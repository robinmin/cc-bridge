import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { FeishuChannel } from "@/gateway/channels/feishu";
import { TelegramChannel } from "@/gateway/channels/telegram";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { type AgentInstance, instanceManager } from "@/gateway/instance-manager";
import { persistence } from "@/gateway/persistence";
import { type BroadcastChannel, type BroadcastTarget, resolveBroadcastTargets } from "@/gateway/services/broadcast";
import { executeMiniAppPrompt, type ContextMode, type MiniAppExecutionEngine } from "@/gateway/services/execution-engine";
import { mapWithConcurrency } from "@/packages/async";
import { ConfigLoader } from "@/packages/config";
import { logger } from "@/packages/logger";
import { type FrontmatterValue, parseMarkdownFrontmatter, stripMarkdownFrontmatter } from "@/packages/markdown";
import { renderTemplate } from "@/packages/template";
import { splitTextChunks } from "@/packages/text";
import { getMissingRequiredFields } from "@/packages/validation";

const APPS_DIR = path.resolve("src/apps");
const MINI_APP_TASK_PREFIX = "@miniapp:";

type TargetMode = "all_sessions" | "chat_ids";

export interface MiniAppDefinition {
	id: string;
	name: string;
	description?: string;
	enabled: boolean;
	executionEngine: MiniAppExecutionEngine;
	contextMode: ContextMode;
	instance?: string;
	workspace?: string;
	engineCommand?: string;
	engineArgs?: string[];
	execTimeoutMs?: number;
	scheduleType?: "once" | "recurring" | "cron";
	scheduleValue?: string;
	targetMode: TargetMode;
	chatIds: string[];
	channels: BroadcastChannel[];
	templateVars: string[];
	body: string;
}

export interface MiniAppRunOptions {
	input?: string;
	variables?: Record<string, string>;
	targetChatIds?: Array<string | number>;
	channels?: BroadcastChannel[];
	timeoutMs?: number;
	concurrency?: number;
}

export interface MiniAppRunResult {
	appId: string;
	totalTargets: number;
	dispatched: number;
	succeeded: number;
	failed: number;
	skipped: number;
	/** @deprecated Use `succeeded` for direct run semantics. */
	queued: number;
}

const TELEGRAM_SAFE_CHUNK_SIZE = 3500;
const DAILY_NEWS_BOILERPLATE_PATTERNS = [
	/^based on (my |the )?search results/i,
	/^based on my retrieval/i,
	/^based on (my |the )?retrieval from/i,
	/^根据(?:我的)?(?:搜索|检索)结果/i,
	/^以下是.*(?:每日|今天).*(?:新闻|简报|摘要)/i,
	/^daily news summary completed/i,
	/^日报(?:已)?(?:完成|生成|发送)/i,
	/^新闻简报(?:已)?(?:完成|生成|发送)/i,
];
const DAILY_NEWS_FORBIDDEN_META_PATTERNS = [
	/daily news summary completed/i,
	/\b(the brief includes|includes \d+ stories)\b/i,
	/(based on|from) (my |the )?(knowledge|knowledge cutoff)/i,
	/(知识截止|知识库|无法获取.*尚未到来)/i,
];
const DAILY_NEWS_SOURCE_LINE_PATTERN = /来源：\[[^\]]+\]\(https?:\/\/[^\s)]+\)/;

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
	if (!value) return defaultValue;
	if (value === "true") return true;
	if (value === "false") return false;
	return defaultValue;
}

function parseArray(value: FrontmatterValue | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
	return trimmed
		.slice(1, -1)
		.split(",")
		.map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
		.filter(Boolean);
}

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
}

function parseExecutionEngine(value: FrontmatterValue | undefined): MiniAppExecutionEngine {
	if (value === "claude_host" || value === "codex_host" || value === "claude_container") {
		return value;
	}
	return "claude_container";
}

function parseContextMode(value: FrontmatterValue | undefined): ContextMode {
	if (value === "existing" || value === "fresh") {
		return value;
	}
	return "fresh";
}

function validateMiniAppFrontmatter(frontmatter: Record<string, FrontmatterValue>, body: string, appId: string): void {
	const missing = getMissingRequiredFields(frontmatter as Record<string, unknown>, ["id"]);
	if (missing.length > 0) {
		throw new Error(`Mini-app "${appId}" is missing required frontmatter fields: ${missing.join(", ")}`);
	}

	const targetMode = frontmatter.target_mode;
	if (typeof targetMode === "string" && targetMode === "chat_ids") {
		const chatIds = parseArray(frontmatter.chat_ids);
		if (chatIds.length === 0) {
			throw new Error(`Mini-app "${appId}" requires non-empty "chat_ids" when target_mode is "chat_ids"`);
		}
	}

	const scheduleType = frontmatter.schedule_type;
	if (
		typeof scheduleType === "string" &&
		(scheduleType === "once" || scheduleType === "recurring" || scheduleType === "cron")
	) {
		const scheduleValue = frontmatter.schedule_value;
		if (!(typeof scheduleValue === "string" && scheduleValue.trim().length > 0)) {
			throw new Error(`Mini-app "${appId}" requires "schedule_value" when "schedule_type" is set`);
		}
	}

	if (!body.trim()) {
		throw new Error(`Mini-app "${appId}" body is empty`);
	}

	const executionEngine = frontmatter.execution_engine;
	if (
		typeof executionEngine === "string" &&
		executionEngine !== "claude_container" &&
		executionEngine !== "claude_host" &&
		executionEngine !== "codex_host"
	) {
		throw new Error(
			`Mini-app "${appId}" has invalid "execution_engine": ${executionEngine} (expected claude_container|claude_host|codex_host)`,
		);
	}

	const contextMode = frontmatter.context_mode;
	if (typeof contextMode === "string" && contextMode !== "existing" && contextMode !== "fresh") {
		throw new Error(`Mini-app "${appId}" has invalid "context_mode": ${contextMode} (expected existing|fresh)`);
	}
}

function buildMiniAppFileLauncherPrompt(params: {
	appId: string;
	specPath: string;
	nowIso: string;
	dateUtc: string;
	input: string;
}): string {
	return [
		`Execute mini-app "${params.appId}" using the markdown spec at: ${params.specPath}`,
		"",
		"Instructions:",
		"1. Open and read the full markdown file (frontmatter + body sections).",
		'2. Follow the mini-app "Goal/Inputs/Outputs/Workflow/Prompt" contract from that file.',
		"3. Apply runtime variables below when interpreting placeholders.",
		"4. Produce the final response directly.",
		"",
		"Runtime variables:",
		`- now_iso: ${params.nowIso}`,
		`- date_utc: ${params.dateUtc}`,
		`- input: ${params.input || "(empty)"}`,
	].join("\n");
}

function normalizeChannels(channels: string[]): BroadcastChannel[] {
	return channels.filter((ch): ch is BroadcastChannel => ch === "telegram" || ch === "feishu");
}

function sanitizeMiniAppOutput(appId: string, rawOutput: string): string {
	const normalized = rawOutput.trim();
	if (!normalized) return "";
	if (appId !== "daily-news") return normalized;

	const lines = normalized.split("\n");
	while (lines.length > 0) {
		const line = lines[0].trim();
		if (!line) {
			lines.shift();
			continue;
		}
		if (line === "---" || line === "***" || /^[-*_]{3,}$/.test(line)) {
			lines.shift();
			continue;
		}
		if (DAILY_NEWS_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(line))) {
			lines.shift();
			continue;
		}
		break;
	}

	return lines.join("\n").trim();
}

function isValidDailyNewsOutput(output: string): boolean {
	if (!output.trim()) return false;
	if (DAILY_NEWS_FORBIDDEN_META_PATTERNS.some((pattern) => pattern.test(output))) return false;
	return DAILY_NEWS_SOURCE_LINE_PATTERN.test(output);
}

type DispatchChannels = {
	telegram?: TelegramChannel;
	feishu?: FeishuChannel;
};

function buildDispatchChannels(): DispatchChannels {
	const config = ConfigLoader.load(GATEWAY_CONSTANTS.CONFIG.CONFIG_FILE, GATEWAY_CONSTANTS.DEFAULT_CONFIG);
	const telegramToken = process.env.TELEGRAM_BOT_TOKEN || "";
	const feishuAppId = config.feishu.appId;
	const feishuAppSecret = config.feishu.appSecret;
	const feishuDomain = config.feishu.domain;
	const feishuEncryptKey = config.feishu.encryptKey;

	return {
		telegram: telegramToken ? new TelegramChannel(telegramToken) : undefined,
		feishu:
			feishuAppId && feishuAppSecret
				? new FeishuChannel(feishuAppId, feishuAppSecret, feishuDomain, feishuEncryptKey)
				: undefined,
	};
}

async function resolveTargetsForApp(app: MiniAppDefinition, options?: MiniAppRunOptions): Promise<BroadcastTarget[]> {
	const requestedChatIds = options?.targetChatIds?.map((id) => String(id));
	const requestedChannels = options?.channels || app.channels;

	if (app.targetMode === "chat_ids") {
		const ids = requestedChatIds?.length ? requestedChatIds : app.chatIds;
		const targets: BroadcastTarget[] = [];

		for (const chatId of ids) {
			const persistedChannel = await persistence.getChatChannel(chatId);
			const inferred: BroadcastChannel = chatId.startsWith("oc_") || chatId.startsWith("ou_") ? "feishu" : "telegram";
			const channel = (
				persistedChannel === "telegram" || persistedChannel === "feishu" ? persistedChannel : inferred
			) as BroadcastChannel;
			if (requestedChannels.length > 0 && !requestedChannels.includes(channel)) continue;

			const instanceName = (await persistence.getSession(chatId)) || app.instance;
			const workspace = await persistence.getWorkspace(chatId);
			targets.push({ chatId, channel, instanceName: instanceName || undefined, workspace });
		}
		return targets;
	}

	return resolveBroadcastTargets({
		targetChatIds: requestedChatIds,
		channels: requestedChannels.length > 0 ? requestedChannels : undefined,
	});
}

function parseMiniAppToken(value: string): { appId: string; input?: string } | null {
	if (!value.startsWith(MINI_APP_TASK_PREFIX)) return null;
	const raw = value.slice(MINI_APP_TASK_PREFIX.length).trim();
	if (!raw) return null;

	const firstSpace = raw.indexOf(" ");
	if (firstSpace === -1) return { appId: raw };
	return {
		appId: raw.slice(0, firstSpace).trim(),
		input: raw.slice(firstSpace + 1).trim(),
	};
}

export class MiniAppDriver {
	private appsDir: string;

	constructor(appsDir = APPS_DIR) {
		this.appsDir = appsDir;
	}

	async listApps(): Promise<MiniAppDefinition[]> {
		const files = await readdir(this.appsDir);
		const markdownFiles = files.filter((file) => file.endsWith(".md"));
		const apps: MiniAppDefinition[] = [];

		for (const file of markdownFiles) {
			try {
				const app = await this.loadApp(path.basename(file, ".md"));
				apps.push(app);
			} catch (error) {
				logger.warn(
					{ file, error: error instanceof Error ? error.message : String(error) },
					"Skipping invalid mini-app markdown",
				);
			}
		}

		return apps;
	}

	async loadApp(appId: string): Promise<MiniAppDefinition> {
		const filePath = path.join(this.appsDir, `${appId}.md`);
		const content = await readFile(filePath, "utf-8");
		const frontmatter = parseMarkdownFrontmatter(content);
		const body = stripMarkdownFrontmatter(content);
		validateMiniAppFrontmatter(frontmatter, body, appId);

		const id = typeof frontmatter.id === "string" ? frontmatter.id : appId;
		const channels = normalizeChannels(parseArray(frontmatter.channels));
		const chatIds = parseArray(frontmatter.chat_ids);
		const templateVars = parseArray(frontmatter.template_vars);
		const targetMode: TargetMode = frontmatter.target_mode === "chat_ids" ? "chat_ids" : "all_sessions";

		return {
			id,
			name: String(frontmatter.name || id),
			description: String(frontmatter.description || ""),
			enabled: parseBool(typeof frontmatter.enabled === "string" ? frontmatter.enabled : undefined, true),
			executionEngine: parseExecutionEngine(frontmatter.execution_engine),
			contextMode: parseContextMode(frontmatter.context_mode),
			instance: typeof frontmatter.instance === "string" ? frontmatter.instance : undefined,
			workspace: typeof frontmatter.workspace === "string" ? frontmatter.workspace : undefined,
			engineCommand: typeof frontmatter.engine_command === "string" ? frontmatter.engine_command : undefined,
			engineArgs: parseArray(frontmatter.engine_args),
			execTimeoutMs: parsePositiveInt(
				typeof frontmatter.exec_timeout_ms === "string" ? frontmatter.exec_timeout_ms : undefined,
			),
			scheduleType:
				frontmatter.schedule_type === "once" ||
				frontmatter.schedule_type === "recurring" ||
				frontmatter.schedule_type === "cron"
					? (frontmatter.schedule_type as "once" | "recurring" | "cron")
					: undefined,
			scheduleValue: typeof frontmatter.schedule_value === "string" ? frontmatter.schedule_value : undefined,
			targetMode,
			chatIds,
			channels,
			templateVars,
			body,
		};
	}

	createTaskPrompt(appId: string, input?: string): string {
		return `${MINI_APP_TASK_PREFIX}${appId}${input ? ` ${input}` : ""}`;
	}

	isMiniAppTaskPrompt(prompt: string): boolean {
		return prompt.startsWith(MINI_APP_TASK_PREFIX);
	}

	parseTaskPrompt(prompt: string): { appId: string; input?: string } | null {
		return parseMiniAppToken(prompt);
	}

	async runApp(appId: string, options?: MiniAppRunOptions): Promise<MiniAppRunResult> {
		const app = await this.loadApp(appId);
		if (!app.enabled) {
			throw new Error(`Mini-app "${appId}" is disabled`);
		}

		const now = new Date();
		const vars: Record<string, string> = {
			now_iso: now.toISOString(),
			date_utc: now.toISOString().slice(0, 10),
			input: options?.input || "",
			...(options?.variables || {}),
		};
		const finalPrompt = renderTemplate(app.body, vars).trim();
		if (!finalPrompt) throw new Error(`Mini-app "${appId}" prompt body is empty`);
		const specWorkspace = path.basename(path.resolve("."));
		const specPath = `/workspaces/${specWorkspace}/src/apps/${app.id}.md`;
		const launcherPrompt = buildMiniAppFileLauncherPrompt({
			appId: app.id,
			specPath,
			nowIso: vars.now_iso,
			dateUtc: vars.date_utc,
			input: vars.input,
		});

		const targets = await resolveTargetsForApp(app, options);
		if (targets.length === 0) {
			throw new Error(`Mini-app "${appId}" has no resolved targets`);
		}
		await instanceManager.refresh();

		const timeoutMs =
			options?.timeoutMs || app.execTimeoutMs || Number.parseInt(process.env.MINI_APP_EXEC_TIMEOUT_MS || "300000", 10);
		const executionEngine = app.executionEngine;
		const workspaceFallback = app.workspace || "cc-bridge";

		let executionTarget: BroadcastTarget | undefined = targets[0];
		let instanceName: string | undefined;
		let instance: AgentInstance | undefined;

		if (executionEngine === "claude_container") {
			executionTarget = targets.find((target) => {
				const name = target.instanceName || app.instance;
				if (!name) return false;
				const current = instanceManager.getInstance(name);
				return !!current && current.status === "running";
			});

			if (!executionTarget) {
				return {
					appId: app.id,
					totalTargets: targets.length,
					dispatched: 0,
					succeeded: 0,
					failed: 0,
					skipped: targets.length,
					queued: 0,
				};
			}

			instanceName = executionTarget.instanceName || app.instance;
			if (!instanceName) {
				throw new Error(`Mini-app "${appId}" has no instance configured`);
			}

			instance = instanceManager.getInstance(instanceName);
			if ((!instance || instance.status !== "running") && app.instance && app.instance !== instanceName) {
				const fallback = instanceManager.getInstance(app.instance);
				if (fallback && fallback.status === "running") {
					instanceName = app.instance;
					instance = fallback;
				}
			}

			if (!instance || instance.status !== "running") {
				return {
					appId: app.id,
					totalTargets: targets.length,
					dispatched: 0,
					succeeded: 0,
					failed: 0,
					skipped: targets.length,
					queued: 0,
				};
			}
		}

		if (!executionTarget) {
			return {
				appId: app.id,
				totalTargets: targets.length,
				dispatched: 0,
				succeeded: 0,
				failed: 0,
				skipped: targets.length,
				queued: 0,
			};
		}

		const workspace = executionTarget.workspace || workspaceFallback;
		let history: Array<{ sender: string; text: string; timestamp: string }> = [];
		if (app.contextMode === "existing") {
			history = await persistence.getHistory(executionTarget.chatId, 11, workspace);
		}

		const generation = await executeMiniAppPrompt({
			engine: executionEngine,
			contextMode: app.contextMode,
			basePrompt: launcherPrompt,
			workspace,
			chatId: executionTarget.chatId,
			history,
			timeoutMs,
			instance,
			engineCommand: app.engineCommand,
			engineArgs: app.engineArgs?.length ? app.engineArgs : undefined,
		});
		if (!generation.success) {
			throw new Error(generation.error || `Mini-app "${appId}" generation failed`);
		}
		let output = sanitizeMiniAppOutput(app.id, generation.output || "");
		if (!output) {
			throw new Error(`Mini-app "${appId}" produced empty output`);
		}
		if (app.id === "daily-news" && !isValidDailyNewsOutput(output)) {
			logger.warn({ appId }, "Daily-news output failed validation; retrying generation with stricter constraints");
			const retryPrompt = [
				launcherPrompt,
				"",
				"Your previous output was rejected by runtime validation.",
				"Retry now. Return only the final news report content.",
				"",
				"Hard constraints (must satisfy all):",
				"- No completion/status/meta text (for example: 'Daily news summary completed...').",
				"- Use only fetched web news within last 48 hours from now_iso.",
				"- Include 7-12 story items grouped by required categories.",
				"- Every story item must include one source line exactly in this form: 来源：[<媒体简称>](<原始新闻URL>).",
				"- Source links must be valid article URLs, not dead links or generic pages.",
			].join("\n");
			const retryGeneration = await executeMiniAppPrompt({
				engine: executionEngine,
				contextMode: "fresh",
				basePrompt: retryPrompt,
				workspace,
				chatId: executionTarget.chatId,
				timeoutMs,
				instance,
				engineCommand: app.engineCommand,
				engineArgs: app.engineArgs?.length ? app.engineArgs : undefined,
			});
			if (!retryGeneration.success) {
				throw new Error(retryGeneration.error || `Mini-app "${appId}" retry generation failed`);
			}
			output = sanitizeMiniAppOutput(app.id, retryGeneration.output || "");
			if (!output || !isValidDailyNewsOutput(output)) {
				throw new Error(
					`Mini-app "${appId}" produced invalid output: must be direct news content with valid 来源 links and no completion/meta summary`,
				);
			}
		}

		const channels = buildDispatchChannels();
		const dispatchConcurrency =
			Number.isFinite(options?.concurrency) && (options?.concurrency || 0) > 0 ? Number(options?.concurrency) : 1;
		const outcomes = await mapWithConcurrency(targets, dispatchConcurrency, async (target) => {
			try {
				if (target.channel === "telegram") {
					if (!channels.telegram) return "failed" as const;
					const chunks = splitTextChunks(output, TELEGRAM_SAFE_CHUNK_SIZE);
					for (const chunk of chunks) {
						try {
							await channels.telegram.sendMessage(target.chatId, chunk, { parse_mode: "Markdown" });
						} catch (error) {
							logger.warn(
								{
									appId,
									chatId: target.chatId,
									error: error instanceof Error ? error.message : String(error),
								},
								"Mini-app markdown send failed, retrying telegram chunk as plain text",
							);
							await channels.telegram.sendMessage(target.chatId, chunk);
						}
					}
				} else if (target.channel === "feishu") {
					if (!channels.feishu) return "failed" as const;
					const chunks = splitTextChunks(output, TELEGRAM_SAFE_CHUNK_SIZE);
					for (const chunk of chunks) {
						await channels.feishu.sendMessage(target.chatId, chunk);
					}
				} else {
					return "skipped" as const;
				}

				await persistence.storeMessage(
					target.chatId,
					"agent",
					output,
					target.workspace || app.workspace || "cc-bridge",
				);
				return "succeeded" as const;
			} catch (error) {
				logger.error(
					{
						appId,
						chatId: target.chatId,
						channel: target.channel,
						error: error instanceof Error ? error.message : String(error),
					},
					"Mini-app output dispatch failed",
				);
				return "failed" as const;
			}
		});

		const dispatched = targets.length;
		const succeeded = outcomes.filter((status) => status === "succeeded").length;
		const failed = outcomes.filter((status) => status === "failed").length;
		const skipped = outcomes.filter((status) => status === "skipped").length;

		return {
			appId: app.id,
			totalTargets: targets.length,
			dispatched,
			succeeded,
			failed,
			skipped,
			queued: 0,
		};
	}
}

export const miniAppDriver = new MiniAppDriver();

export async function runCli(argv = process.argv.slice(2)) {
	const [command, appId, ...rest] = argv;
	if (command === "list") {
		const apps = await miniAppDriver.listApps();
		for (const app of apps) {
			process.stdout.write(`${app.id}\t${app.name}\t${app.targetMode}\n`);
		}
		return;
	}

	if (command === "run") {
		if (!appId) throw new Error("Usage: bun run src/gateway/apps/driver.ts run <app-id> [input]");
		const input = rest.join(" ").trim() || undefined;
		const targetChatIds = process.env.MINI_APP_CHAT_ID
			? process.env.MINI_APP_CHAT_ID.split(",")
					.map((id) => id.trim())
					.filter(Boolean)
			: undefined;
		const timeoutMs = process.env.MINI_APP_TIMEOUT_MS
			? Number.parseInt(process.env.MINI_APP_TIMEOUT_MS, 10)
			: undefined;
		const concurrency = process.env.MINI_APP_CONCURRENCY
			? Number.parseInt(process.env.MINI_APP_CONCURRENCY, 10)
			: undefined;
		const result = await miniAppDriver.runApp(appId, {
			input,
			targetChatIds,
			timeoutMs,
			concurrency,
		});
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}

	if (command === "task-prompt") {
		if (!appId) throw new Error("Usage: bun run src/gateway/apps/driver.ts task-prompt <app-id> [input]");
		const input = rest.join(" ").trim() || undefined;
		process.stdout.write(`${miniAppDriver.createTaskPrompt(appId, input)}\n`);
		return;
	}

	process.stdout.write(
		`${[
			"Usage:",
			"  bun run src/gateway/apps/driver.ts list",
			"  bun run src/gateway/apps/driver.ts run <app-id> [input]",
			"  bun run src/gateway/apps/driver.ts task-prompt <app-id> [input]",
		].join("\n")}\n`,
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runCli().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
