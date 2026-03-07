import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FeishuChannel } from "@/gateway/channels/feishu";
import { TelegramChannel } from "@/gateway/channels/telegram";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import type { ExecutionRequest, ExecutionResult } from "@/gateway/engine/contracts";
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
import { renderTemplate } from "@/packages/template";
import { splitTextChunks } from "@/packages/text";
import { getMissingRequiredFields } from "@/packages/validation";

// Types previously from execution-engine.ts
/** Execution engine type for mini-apps */
export type MiniAppExecutionEngine = "claude_container" | "claude_host" | "codex_host";
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
const MINI_APP_DEBUG_DIR = path.resolve("data/debug/mini-apps");
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

/**
 * Wait for tmux command completion and capture output
 * Uses tmux capture-pane to get the output after command completes
 */
async function waitForTmuxCompletion(params: {
	sessionName: string;
	timeoutMs: number;
	promptSentAt: number;
}): Promise<ExecutionResult> {
	const { sessionName, timeoutMs, promptSentAt } = params;
	const pollIntervalMs = 2000; // Check every 2 seconds
	const startTime = Date.now();
	const minExecutionTimeMs = 5000; // Minimum time to wait before checking completion

	logger.info({ sessionName, timeoutMs }, "Waiting for tmux command completion");

	// Wait minimum execution time first
	await new Promise((resolve) => setTimeout(resolve, minExecutionTimeMs));

	let lastLineCount = 0;
	let stableCount = 0;
	const requiredStableChecks = 3; // Output must be stable for 3 consecutive checks

	while (Date.now() - startTime < timeoutMs) {
		try {
			// Capture the current pane content
			const proc = Bun.spawn(
				["tmux", "capture-pane", "-t", sessionName, "-p", "-S", "-1000"],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			const output = await new Response(proc.stdout).text();
			await proc.exited;

			if (proc.exitCode !== 0) {
				logger.debug({ sessionName, exitCode: proc.exitCode }, "tmux capture-pane failed, session may have ended");
				// Session might have ended - this could mean completion or error
				// Try to get any remaining output
				if (output.trim()) {
					return {
						status: "completed",
						output: output.trim(),
						exitCode: 0,
						retryable: false,
					};
				}
				return {
					status: "failed",
					error: "tmux session ended unexpectedly",
					retryable: true,
				};
			}

			// Check if output has stabilized (command completed)
			const lines = output.split("\n").filter((l) => l.trim());
			const currentLineCount = lines.length;

			if (currentLineCount === lastLineCount && currentLineCount > 0) {
				stableCount++;
				if (stableCount >= requiredStableChecks) {
					// Output has been stable - command likely completed
					// Extract the output after our prompt was sent
					logger.info(
						{ sessionName, lineCount: currentLineCount, elapsedMs: Date.now() - startTime },
						"tmux command output stabilized, assuming completion",
					);

					// Find where our output starts (after the prompt we sent)
					// We look for common completion indicators or just return all recent output
					const cleanOutput = extractRecentOutput(output, promptSentAt);

					return {
						status: "completed",
						output: cleanOutput,
						exitCode: 0,
						retryable: false,
					};
				}
			} else {
				stableCount = 0;
				lastLineCount = currentLineCount;
			}

			logger.debug(
				{ sessionName, lineCount: currentLineCount, stableCount, elapsedMs: Date.now() - startTime },
				"Checking tmux output stability...",
			);
		} catch (error) {
			logger.debug({ sessionName, error: String(error) }, "tmux check failed, continuing...");
		}

		// Wait before next poll
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	// Timeout - return whatever output we have
	logger.warn({ sessionName, elapsedMs: Date.now() - startTime }, "tmux command timed out, returning current output");

	// Try to capture current output
	try {
		const proc = Bun.spawn(["tmux", "capture-pane", "-t", sessionName, "-p", "-S", "-1000"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(proc.stdout).text();
		await proc.exited;

		return {
			status: "timeout",
			output: output.trim(),
			error: `tmux command timed out after ${timeoutMs}ms`,
			retryable: true,
			isTimeout: true,
		};
	} catch {
		return {
			status: "timeout",
			error: `tmux command timed out after ${timeoutMs}ms`,
			retryable: true,
			isTimeout: true,
		};
	}
}

/**
 * Extract recent output from tmux capture, filtering out old content
 */
function extractRecentOutput(fullOutput: string, _promptSentAt: number): string {
	const lines = fullOutput.split("\n");

	// Look for Claude output markers or just return the last portion
	// Common patterns that indicate start of response
	const startMarkers = [/^Claude:/i, /^Here['']s/i, /^Based on/i, /^I['']ll/i, /^Let me/i];

	let startIndex = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		for (const marker of startMarkers) {
			if (marker.test(line)) {
				startIndex = i;
				break;
			}
		}
		if (startIndex !== -1) break;
	}

	// If we found a start marker, return from there
	if (startIndex !== -1) {
		return lines.slice(startIndex).join("\n").trim();
	}

	// Otherwise return the last 80% of output (heuristic)
	const keepLines = Math.floor(lines.length * 0.8);
	return lines.slice(-keepLines).join("\n").trim();
}

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

async function persistMiniAppDebugArtifact(params: {
	appId: string;
	stage: "generation" | "retry";
	launcherPrompt?: string;
	retryPrompt?: string;
	rawOutput: string;
	sanitizedOutput: string;
}): Promise<string | null> {
	try {
		await mkdir(MINI_APP_DEBUG_DIR, { recursive: true });
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const filePath = path.join(MINI_APP_DEBUG_DIR, `${params.appId}-${params.stage}-${ts}.md`);
		const content = [
			`# Mini-App Debug Artifact`,
			`app_id: ${params.appId}`,
			`stage: ${params.stage}`,
			`timestamp: ${new Date().toISOString()}`,
			"",
			"## Launcher Prompt",
			"```text",
			params.launcherPrompt || "",
			"```",
			"",
			"## Retry Prompt",
			"```text",
			params.retryPrompt || "",
			"```",
			"",
			"## Raw Output",
			"```text",
			params.rawOutput || "",
			"```",
			"",
			"## Sanitized Output",
			"```text",
			params.sanitizedOutput || "",
			"```",
			"",
		].join("\n");
		await writeFile(filePath, content, "utf-8");
		return filePath;
	} catch (error) {
		logger.warn(
			{
				appId: params.appId,
				stage: params.stage,
				error: error instanceof Error ? error.message : String(error),
			},
			"Failed to persist mini-app debug artifact",
		);
		return null;
	}
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

		// Build effective prompt with memory context
		const memoryConfig = resolveMemoryConfig(GATEWAY_CONSTANTS.DEFAULT_CONFIG.memory);
		const isGroupContext = inferGroupContext("telegram", executionTarget.chatId ?? "");
		const memoryContext = await buildMemoryBootstrapContext({
			config: memoryConfig,
			workspaceRoot: path.join(GATEWAY_CONSTANTS.CONFIG.PROJECTS_ROOT, workspace),
			isGroupContext,
		});
		const effectivePrompt = memoryContext ? `${memoryContext}\n\nUser request:\n${launcherPrompt}` : launcherPrompt;

		// Execute via unified orchestrator
		const request: ExecutionRequest = {
			prompt: effectivePrompt,
			options: {
				timeout: timeoutMs,
				workspace,
				chatId: executionTarget.chatId,
				history,
				command: app.engineCommand,
				args: app.engineArgs,
			},
			instance,
		};

		const orchestratorResult = await getExecutionOrchestrator().execute(request);

		// Generate session name for tmux operations (must match host-ipc.ts generateSessionName)
		const sanitizedWorkspace = workspace.replace(/[^a-zA-Z0-9_-]/g, "_");
		const sanitizedChatId = String(executionTarget.chatId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
		const sessionName = `claude-${sanitizedWorkspace}-${sanitizedChatId}`;

		// Handle async execution - wait for tmux completion and capture output
		let finalResult = orchestratorResult;
		if (orchestratorResult.mode === "tmux" && orchestratorResult.status === "running") {
			logger.info({ sessionName, workspace, timeoutMs }, "Execution is async via tmux, waiting for completion...");
			finalResult = await waitForTmuxCompletion({
				sessionName,
				timeoutMs,
				promptSentAt: Date.now(),
			});
		}

		// Convert to expected format
		const generation = {
			success: finalResult.status === "completed",
			output: finalResult.output,
			error: finalResult.error,
			exitCode: finalResult.exitCode,
			retryable: finalResult.retryable,
			isTimeout: finalResult.isTimeout,
		};
		if (!generation.success) {
			throw new Error(generation.error || `Mini-app "${appId}" generation failed`);
		}
		let output = sanitizeMiniAppOutput(app.id, generation.output || "");
		if (!output) {
			throw new Error(`Mini-app "${appId}" produced empty output`);
		}
		if (app.id === "daily-news" && !isValidDailyNewsOutput(output)) {
			const invalidPath = await persistMiniAppDebugArtifact({
				appId: app.id,
				stage: "generation",
				launcherPrompt,
				rawOutput: generation.output || "",
				sanitizedOutput: output,
			});
			logger.warn({ appId }, "Daily-news output failed validation; retrying generation with stricter constraints");
			if (invalidPath) {
				logger.warn({ appId, artifact: invalidPath }, "Daily-news invalid generation artifact saved");
			}
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
			// Retry with fresh context using orchestrator
			const retryEffectivePrompt = retryPrompt;
			const retryRequest: ExecutionRequest = {
				prompt: retryEffectivePrompt,
				options: {
					timeout: timeoutMs,
					workspace,
					chatId: executionTarget.chatId,
				},
				instance,
			};

			const retryOrchestratorResult = await getExecutionOrchestrator().execute(retryRequest);

			// Handle async execution - wait for tmux completion and capture output
			let retryFinalResult = retryOrchestratorResult;
			if (retryOrchestratorResult.mode === "tmux" && retryOrchestratorResult.status === "running") {
				logger.info({ sessionName, workspace, timeoutMs }, "Retry execution is async via tmux, waiting for completion...");
				retryFinalResult = await waitForTmuxCompletion({
					sessionName,
					timeoutMs,
					promptSentAt: Date.now(),
				});
			}

			const retryGeneration = {
				success: retryFinalResult.status === "completed",
				output: retryFinalResult.output,
				error: retryFinalResult.error,
				exitCode: retryFinalResult.exitCode,
				retryable: retryFinalResult.retryable,
				isTimeout: retryFinalResult.isTimeout,
			};
			if (!retryGeneration.success) {
				throw new Error(retryGeneration.error || `Mini-app "${appId}" retry generation failed`);
			}
			output = sanitizeMiniAppOutput(app.id, retryGeneration.output || "");
			if (!output || !isValidDailyNewsOutput(output)) {
				const retryInvalidPath = await persistMiniAppDebugArtifact({
					appId: app.id,
					stage: "retry",
					launcherPrompt,
					retryPrompt,
					rawOutput: retryGeneration.output || "",
					sanitizedOutput: output,
				});
				throw new Error(
					`Mini-app "${appId}" produced invalid output: must be direct news content with valid 来源 links and no completion/meta summary${retryInvalidPath ? ` (artifact: ${retryInvalidPath})` : ""}`,
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
