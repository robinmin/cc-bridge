import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { FeishuChannel } from "@/gateway/channels/feishu";
import { TelegramChannel } from "@/gateway/channels/telegram";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { createContainerEngine } from "@/gateway/engine/container";
import type { ExecutionRequest } from "@/gateway/engine/contracts";
import { createHostIpcEngine } from "@/gateway/engine/host-ipc";
import { getExecutionOrchestrator } from "@/gateway/engine/orchestrator";
import { type AgentInstance, instanceManager } from "@/gateway/instance-manager";
import { buildMemoryBootstrapContext, resolveMemoryConfig } from "@/gateway/memory/manager";
import { inferGroupContext } from "@/gateway/memory/policy";
import { persistence } from "@/gateway/persistence";
import { type BroadcastChannel, type BroadcastTarget, resolveBroadcastTargets } from "@/gateway/services/broadcast";
import { mapWithConcurrency } from "@/packages/async";
import { ConfigLoader } from "@/packages/config";
import { logger } from "@/packages/logger";
import { type FrontmatterValue, parseMarkdownFrontmatter, stripMarkdownFrontmatter } from "@/packages/markdown";
import { splitTextChunks } from "@/packages/text";
import { getMissingRequiredFields } from "@/packages/validation";

// Types previously from execution-engine.ts
/** Execution engine type for mini-apps */
export type MiniAppExecutionEngine = "claude_container" | "claude_host" | "codex_host" | "in_process";
/** Context mode for mini-app execution */
export type ContextMode = "existing" | "fresh";

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
	if (value === "claude_host" || value === "codex_host" || value === "claude_container" || value === "in_process") {
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
		executionEngine !== "codex_host" &&
		executionEngine !== "in_process"
	) {
		throw new Error(
			`Mini-app "${appId}" has invalid "execution_engine": ${executionEngine} (expected claude_container|claude_host|codex_host|in_process)`,
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

function resolveMiniAppSpecPath(appId: string, executionEngine: MiniAppExecutionEngine, appsDir: string): string {
	if (executionEngine === "claude_container") {
		const specWorkspace = path.basename(path.resolve("."));
		return `/workspaces/${specWorkspace}/src/apps/${appId}.md`;
	}

	return path.join(appsDir, `${appId}.md`);
}

function normalizeChannels(channels: string[]): BroadcastChannel[] {
	return channels.filter((ch): ch is BroadcastChannel => ch === "telegram" || ch === "feishu");
}

function sanitizeMiniAppOutput(_appId: string, rawOutput: string): string {
	const normalized = rawOutput.trim();
	if (!normalized) return "";
	return normalized;
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

		const executionEngine = app.executionEngine;

		const now = new Date();
		const vars: Record<string, string> = {
			now_iso: now.toISOString(),
			date_utc: now.toISOString().slice(0, 10),
			input: options?.input || "",
			...(options?.variables || {}),
		};
		const specPath = resolveMiniAppSpecPath(app.id, executionEngine, this.appsDir);
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

		// Mini-apps use a dedicated ephemeral tmux session for each run.
		// This guarantees fresh tmux-side state regardless of context_mode.
		const miniAppSessionId = `miniapp-${crypto.randomUUID().slice(0, 8)}`;

		// Claude-side conversational context is controlled by context_mode:
		// - fresh: empty history
		// - existing: recent persisted chat history
		// Build effective prompt with memory context
		const memoryConfig = resolveMemoryConfig(GATEWAY_CONSTANTS.DEFAULT_CONFIG.memory);
		const isGroupContext = inferGroupContext(executionTarget.channel, executionTarget.chatId ?? "");
		const memoryContext = await buildMemoryBootstrapContext({
			config: memoryConfig,
			workspaceRoot: path.join(GATEWAY_CONSTANTS.CONFIG.PROJECTS_ROOT, workspace),
			isGroupContext,
		});
		const effectivePrompt = memoryContext ? `${memoryContext}\n\nUser request:\n${launcherPrompt}` : launcherPrompt;

		// Execute via unified orchestrator with sync mode for mini-apps
		// Sync mode makes the engine wait for completion and return output directly
		const request: ExecutionRequest = {
			prompt: effectivePrompt,
			options: {
				timeout: timeoutMs,
				workspace,
				chatId: miniAppSessionId, // Use unique session ID to ensure fresh tmux session
				history,
				command: app.engineCommand,
				args: app.engineArgs.length > 0 ? app.engineArgs : undefined,
				sync: true, // Wait for completion and return output
				ephemeralSession: true,
			},
			instance,
		};

		const orchestratorResult =
			executionEngine === "claude_host" || executionEngine === "codex_host"
				? await createHostIpcEngine(executionEngine).execute(request)
				: executionEngine === "claude_container"
					? await createContainerEngine().execute(request)
					: await getExecutionOrchestrator().execute(request);

		// Convert to expected format - sync mode returns completed results directly
		const generation = {
			success: orchestratorResult.status === "completed",
			output: orchestratorResult.output,
			error: orchestratorResult.error,
			exitCode: orchestratorResult.exitCode,
			retryable: orchestratorResult.retryable,
			isTimeout: orchestratorResult.isTimeout,
		};
		if (!generation.success) {
			throw new Error(generation.error || `Mini-app "${appId}" generation failed`);
		}
		const output = sanitizeMiniAppOutput(app.id, generation.output || "");
		if (!output) {
			throw new Error(`Mini-app "${appId}" produced empty output`);
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
						await channels.telegram.sendMessage(target.chatId, chunk);
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
