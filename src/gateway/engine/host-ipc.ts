/**
 * Host IPC Execution Engine
 *
 * CLI subprocess execution on the host OS via tmux sessions.
 * Supports Claude and Codex CLI commands.
 * Absorbed from execution-engine.ts claude_host and codex_host modes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { logger } from "@/packages/logger";
import type { ExecutionOptions, ExecutionRequest, ExecutionResult, IExecutionEngine, LayerHealth } from "./contracts";

/** Host engine type */
export type HostEngineType = "claude_host" | "codex_host";

/** Configuration for host IPC engine */
export interface HostIpcConfig {
	/** Engine type */
	engineType: HostEngineType;
	/** Custom command override */
	command?: string;
	/** Custom argument templates */
	args?: string[];
}

/**
 * Host IPC execution engine
 * Executes prompts via tmux sessions on the host OS
 */
export class HostIpcEngine implements IExecutionEngine {
	private readonly config: HostIpcConfig;

	constructor(config: Partial<HostIpcConfig> = {}) {
		this.config = {
			engineType: config.engineType || "claude_host",
			command: config.command,
			args: config.args,
		};
	}

	getLayer(): "host-ipc" {
		return "host-ipc";
	}

	async isAvailable(): Promise<boolean> {
		// Check if the CLI command is available
		const command = this.getCommand();
		try {
			const proc = Bun.spawn([command, "--version"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
			return proc.exitCode === 0;
		} catch {
			return false;
		}
	}

	async execute(request: ExecutionRequest): Promise<ExecutionResult> {
		const options = request.options || {};
		const workspace = options.workspace || "cc-bridge";
		const timeoutMs = options.timeout || GATEWAY_CONSTANTS.ORCHESTRATOR?.defaultTimeoutMs || 120000;
		const chatId = options.chatId;

		// Build prompt based on history
		const { prompt, buildArgs } = this.prepareExecution(request.prompt, options);

		try {
			const { command, args } = buildArgs(prompt, workspace, chatId);

			// Execute via tmux session on host
			const result = await this.executeViaTmux({
				command,
				args,
				workspace,
				chatId: String(chatId || "default"),
				timeoutMs,
			});

			return result;
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				retryable: false,
			};
		}
	}

	async getHealth(): Promise<LayerHealth> {
		const available = await this.isAvailable();
		return {
			layer: "host-ipc",
			available,
			lastCheck: new Date(),
			error: available ? undefined : "CLI command not available",
		};
	}

	// =============================================================================
	// Private Methods
	// =============================================================================

	private getCommand(): string {
		if (this.config.command) {
			return this.config.command;
		}

		if (this.config.engineType === "codex_host") {
			return process.env.CODEX_HOST_COMMAND || "codex";
		}

		return process.env.CLAUDE_HOST_COMMAND || "claude";
	}

	private prepareExecution(prompt: string, options: ExecutionOptions) {
		// Import dynamically to avoid circular deps
		const { buildClaudePrompt, buildPlainContextPrompt, interpolateArg } = require("./prompt-utils");

		let effectivePrompt: string;
		let buildArgs: (prompt: string, workspace: string, chatId?: string | number) => { command: string; args: string[] };

		if (options.history && options.history.length > 0) {
			if (this.config.engineType === "codex_host") {
				effectivePrompt = buildPlainContextPrompt(prompt, options.history);
			} else {
				effectivePrompt = buildClaudePrompt(prompt, options.history);
			}
		} else {
			effectivePrompt = prompt;
		}

		if (this.config.engineType === "codex_host") {
			buildArgs = (p: string, w: string, c?: string | number) => ({
				command: this.config.command || process.env.CODEX_HOST_COMMAND || "codex",
				args: (this.config.args || ["{{prompt}}"]).map((t: string) => interpolateArg(t, p, w, c)),
			});
		} else {
			buildArgs = (p: string, w: string, c?: string | number) => ({
				command: this.config.command || process.env.CLAUDE_HOST_COMMAND || "claude",
				args: (this.config.args || ["-p", "{{prompt}}", "--dangerously-skip-permissions", "--allowedTools=*"]).map(
					(t: string) => interpolateArg(t, p, w, c),
				),
			});
		}

		return { prompt: effectivePrompt, buildArgs };
	}

	private resolveWorkspacePath(workspace: string): string | undefined {
		const candidate = path.resolve(GATEWAY_CONSTANTS.CONFIG.WORKSPACE_ROOT, workspace);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
		return undefined;
	}

	// =============================================================================
	// Tmux-based execution (host OS, no docker)
	// =============================================================================

	/**
	 * Execute command via tmux session on host OS
	 */
	private async executeViaTmux(params: {
		command: string;
		args: string[];
		workspace: string;
		chatId: string;
		timeoutMs: number;
	}): Promise<ExecutionResult> {
		const requestId = crypto.randomUUID();
		const sessionName = this.generateSessionName(params.workspace, params.chatId);

		try {
			// Get or create tmux session on host
			await this.ensureHostSession(params.workspace, params.chatId, sessionName);

			// Build the full command
			const fullCommand = this.buildCommand(params.command, params.args, params.workspace);

			// Send command to tmux session
			await this.sendToHostSession(sessionName, fullCommand);

			logger.info(
				{ requestId, sessionName, workspace: params.workspace, command: params.command },
				"Prompt sent via tmux to host session",
			);

			// Return async result - response comes via callback
			return {
				status: "running",
				requestId,
				mode: "tmux",
			};
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				retryable: false,
			};
		}
	}

	/**
	 * Generate deterministic session name
	 * Format: claude-{workspace}-{chatId}
	 */
	private generateSessionName(workspace: string, chatId: string): string {
		const sanitizedWorkspace = workspace.replace(/[^a-zA-Z0-9_-]/g, "_");
		const sanitizedChatId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
		return `${GATEWAY_CONSTANTS.TMUX.SESSION_PREFIX}${GATEWAY_CONSTANTS.TMUX.SESSION_NAME_SEPARATOR}${sanitizedWorkspace}${GATEWAY_CONSTANTS.TMUX.SESSION_NAME_SEPARATOR}${sanitizedChatId}`;
	}

	/**
	 * Ensure tmux session exists on host (not in container)
	 */
	private async ensureHostSession(workspace: string, _chatId: string, sessionName: string): Promise<void> {
		// Check if session already exists
		if (await this.hostSessionExists(sessionName)) {
			logger.debug({ sessionName }, "Reusing existing host tmux session");
			return;
		}

		// Create new tmux session on host
		const cwd = this.resolveWorkspacePath(workspace);
		const proc = Bun.spawn(
			["tmux", "new-session", "-d", "-s", sessionName, "-c", cwd || ".", "bash"],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`Failed to create tmux session: ${stderr || "Unknown error"}`);
		}

		logger.info({ sessionName, workspace }, "Created host tmux session");
	}

	/**
	 * Check if tmux session exists on host
	 */
	private async hostSessionExists(sessionName: string): Promise<boolean> {
		const proc = Bun.spawn(["tmux", "has-session", "-t", sessionName], {
			stdout: "pipe",
			stderr: "pipe",
		});

		await proc.exited;
		return proc.exitCode === 0;
	}

	/**
	 * Build full command with workspace context
	 */
	private buildCommand(command: string, args: string[], workspace: string): string {
		const workspacePath = this.resolveWorkspacePath(workspace) || ".";
		const fullCommand = [command, ...args].join(" ");

		// Escape for shell
		return `cd ${workspacePath} && ${fullCommand}`;
	}

	/**
	 * Send command to host tmux session
	 */
	private async sendToHostSession(sessionName: string, command: string): Promise<void> {
		// Escape single quotes for shell
		const escapedCommand = command.replace(/'/g, "'\\''");

		const proc = Bun.spawn(
			["tmux", "send-keys", "-t", sessionName, `bash -c '${escapedCommand}'`, "C-m"],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`Failed to send keys to tmux session: ${stderr || "Unknown error"}`);
		}
	}
}

/**
 * Factory function to create host IPC engine
 */
export function createHostIpcEngine(type: HostEngineType = "claude_host"): HostIpcEngine {
	return new HostIpcEngine({ engineType: type });
}
