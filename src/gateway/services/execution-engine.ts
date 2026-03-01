import fs from "node:fs";
import path from "node:path";
import type { AgentInstance } from "@/gateway/instance-manager";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { buildMemoryBootstrapContext, resolveMemoryConfig } from "@/gateway/memory/manager";
import { inferGroupContext } from "@/gateway/memory/policy";
import {
	type ClaudeExecutionConfig,
	type ClaudeExecutionResult,
	buildClaudePrompt,
	executeClaudeRaw,
} from "@/gateway/services/claude-executor";
import { logger } from "@/packages/logger";

export type MiniAppExecutionEngine = "claude_container" | "claude_host" | "codex_host";
export type ContextMode = "existing" | "fresh";

export interface EngineHistoryItem {
	sender: string;
	text: string;
	timestamp: string;
}

export interface MiniAppExecutionRequest {
	engine: MiniAppExecutionEngine;
	contextMode: ContextMode;
	basePrompt: string;
	workspace: string;
	timeoutMs: number;
	chatId?: string | number;
	history?: EngineHistoryItem[];
	instance?: AgentInstance;
	engineCommand?: string;
	engineArgs?: string[];
}

function buildPlainContextPrompt(basePrompt: string, history: EngineHistoryItem[]): string {
	const lines = history
		.slice()
		.reverse()
		.map((item) => `[${item.timestamp}] ${item.sender}: ${item.text}`);

	return [
		"Conversation context:",
		...lines,
		"",
		"Current request:",
		basePrompt,
	].join("\n");
}

function buildEnginePrompt(
	engine: MiniAppExecutionEngine,
	contextMode: ContextMode,
	basePrompt: string,
	history: EngineHistoryItem[] = [],
): string {
	if (contextMode === "fresh" || history.length === 0) {
		return basePrompt;
	}

	if (engine === "codex_host") {
		return buildPlainContextPrompt(basePrompt, history);
	}

	return buildClaudePrompt(basePrompt, history);
}

function interpolateArg(template: string, prompt: string, workspace: string, chatId: string | number | undefined): string {
	return template
		.replaceAll("{{prompt}}", prompt)
		.replaceAll("{{workspace}}", workspace)
		.replaceAll("{{chat_id}}", chatId === undefined ? "" : String(chatId));
}

function resolveWorkspacePath(workspace: string): string | undefined {
	const candidate = path.resolve(GATEWAY_CONSTANTS.CONFIG.WORKSPACE_ROOT, workspace);
	if (fs.existsSync(candidate)) {
		return candidate;
	}

	logger.warn({ workspace, candidate }, "Workspace path not found for host engine, using current directory");
	return undefined;
}

async function executeHostCommand(params: {
	command: string;
	args: string[];
	workspace: string;
	timeoutMs: number;
}): Promise<ClaudeExecutionResult> {
	const cwd = resolveWorkspacePath(params.workspace);
	const proc = Bun.spawn([params.command, ...params.args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			WORKSPACE_ROOT: GATEWAY_CONSTANTS.CONFIG.WORKSPACE_ROOT,
		},
	});

	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, params.timeoutMs);

	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const output = (stdout || stderr || "").trim();

		if (timedOut) {
			return {
				success: false,
				error: "Request timeout",
				exitCode,
				isTimeout: true,
				retryable: false,
			};
		}

		if (exitCode === 0) {
			return {
				success: true,
				output,
				exitCode,
			};
		}

		return {
			success: false,
			error: output || `Command failed with exit code ${exitCode}`,
			exitCode,
			retryable: false,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			retryable: false,
		};
	} finally {
		clearTimeout(timeoutId);
	}
}

function buildClaudeHostCommandArgs(prompt: string, request: MiniAppExecutionRequest): { command: string; args: string[] } {
	const command = request.engineCommand || process.env.CLAUDE_HOST_COMMAND || "claude";
	const argTemplates =
		request.engineArgs ||
		[
			"-p",
			"{{prompt}}",
			"--dangerously-skip-permissions",
			"--allowedTools=*",
		];
	const args = argTemplates.map((template) => interpolateArg(template, prompt, request.workspace, request.chatId));
	return { command, args };
}

function buildCodexHostCommandArgs(prompt: string, request: MiniAppExecutionRequest): { command: string; args: string[] } {
	const command = request.engineCommand || process.env.CODEX_HOST_COMMAND || "codex";
	const argTemplates = request.engineArgs || ["{{prompt}}"];
	const args = argTemplates.map((template) => interpolateArg(template, prompt, request.workspace, request.chatId));
	return { command, args };
}

export async function executeMiniAppPrompt(request: MiniAppExecutionRequest): Promise<ClaudeExecutionResult> {
	const prompt = buildEnginePrompt(request.engine, request.contextMode, request.basePrompt, request.history);
	const memoryConfig = resolveMemoryConfig(GATEWAY_CONSTANTS.DEFAULT_CONFIG.memory);
	const isGroupContext = inferGroupContext("telegram", request.chatId ?? "");
	const memoryContext = await buildMemoryBootstrapContext({
		config: memoryConfig,
		workspaceRoot: path.join(GATEWAY_CONSTANTS.CONFIG.PROJECTS_ROOT, request.workspace),
		isGroupContext,
	});
	const effectivePrompt = memoryContext ? `${memoryContext}\n\nUser request:\n${prompt}` : prompt;

	if (request.engine === "claude_container") {
		if (!request.instance) {
			return {
				success: false,
				error: "Container engine requires a running instance",
				retryable: false,
			};
		}

		const config: ClaudeExecutionConfig = {
			workspace: request.workspace,
			chatId: request.chatId,
			timeout: request.timeoutMs,
			command: request.engineCommand,
			args: request.engineArgs,
		};

		return executeClaudeRaw(request.instance.containerId, request.instance.name, effectivePrompt, config);
	}

	if (request.engine === "claude_host") {
		const { command, args } = buildClaudeHostCommandArgs(effectivePrompt, request);
		return executeHostCommand({
			command,
			args,
			workspace: request.workspace,
			timeoutMs: request.timeoutMs,
		});
	}

	const { command, args } = buildCodexHostCommandArgs(effectivePrompt, request);
	return executeHostCommand({
		command,
		args,
		workspace: request.workspace,
		timeoutMs: request.timeoutMs,
	});
}
