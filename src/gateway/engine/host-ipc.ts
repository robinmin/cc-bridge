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
		const sync = options.sync ?? false;
		const ephemeralSession = options.ephemeralSession ?? false;

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
				sync,
				ephemeralSession,
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
			const requestArgs = options.args && options.args.length > 0 ? options.args : undefined;
			const configArgs = this.config.args && this.config.args.length > 0 ? this.config.args : undefined;
			buildArgs = (p: string, w: string, c?: string | number) => ({
				command: options.command || this.config.command || process.env.CODEX_HOST_COMMAND || "codex",
				args: (requestArgs || configArgs || ["{{prompt}}"]).map((t: string) => interpolateArg(t, p, w, c)),
			});
		} else {
			const allowDangerous = options.allowDangerouslySkipPermissions ?? true;
			const allowedTools = options.allowedTools || "*";
			const defaultArgs = ["-p", "{{prompt}}"];
			if (allowDangerous) {
				defaultArgs.push("--dangerously-skip-permissions");
			}
			if (allowedTools) {
				defaultArgs.push(`--allowedTools=${allowedTools}`);
			}

			const requestArgs = options.args && options.args.length > 0 ? options.args : undefined;
			const configArgs = this.config.args && this.config.args.length > 0 ? this.config.args : undefined;
			buildArgs = (p: string, w: string, c?: string | number) => ({
				command: options.command || this.config.command || process.env.CLAUDE_HOST_COMMAND || "claude",
				args: (requestArgs || configArgs || defaultArgs).map((t: string) => interpolateArg(t, p, w, c)),
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
		sync?: boolean;
		ephemeralSession?: boolean;
	}): Promise<ExecutionResult> {
		const requestId = crypto.randomUUID();
		const sessionName = this.generateSessionName(params.workspace, params.chatId);

		try {
			// Get or create tmux session on host
			await this.ensureHostSession(params.workspace, params.chatId, sessionName);

			// Build the full command
			const completionToken = `CC_BRIDGE_DONE_${requestId.replace(/-/g, "_")}`;
			const fullCommand = this.buildCommand(
				params.command,
				params.args,
				params.workspace,
				completionToken,
				params.timeoutMs,
			);

			// Send command to tmux session (pass requestId for temp file naming)
			await this.sendToHostSession(sessionName, fullCommand, requestId);

			logger.info(
				{
					requestId,
					sessionName,
					workspace: params.workspace,
					command: params.command,
					promptLength: fullCommand.length,
				},
				"Prompt sent via tmux to host session",
			);

			// If sync mode, wait for completion and capture output
			if (params.sync) {
				const result = await this.waitForTmuxCompletion(sessionName, params.timeoutMs, completionToken);

				// Avoid leaving long-running CLI processes behind after sync timeout/failure.
				if (result.status !== "completed") {
					await this.interruptHostSession(sessionName);
				}

				if (params.ephemeralSession) {
					await this.killHostSession(sessionName);
				}

				return result;
			}

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
	 * Wait for tmux command completion and capture output
	 */
	private async waitForTmuxCompletion(
		sessionName: string,
		timeoutMs: number,
		completionToken: string,
	): Promise<ExecutionResult> {
		const pollIntervalMs = 2000;
		const startTime = Date.now();

		logger.info({ sessionName, timeoutMs }, "Waiting for tmux command completion");

		while (Date.now() - startTime < timeoutMs) {
			try {
				const output = await this.capturePane(sessionName);
				const completionRegex = new RegExp(`${completionToken}:(\\d+)`, "g");
				let completionMatch: RegExpExecArray | null = null;
				for (const match of output.matchAll(completionRegex)) {
					completionMatch = match as RegExpExecArray;
				}

				if (completionMatch && completionMatch.index !== undefined) {
					const completionIndex = completionMatch.index;
					const paneBeforeToken = output.slice(0, completionIndex);
					const shellErrorPattern = /(command not found|syntax error|No such file or directory)/i;
					if (shellErrorPattern.test(paneBeforeToken)) {
						return {
							status: "failed",
							error: "Host tmux command failed before completion",
							output: this.extractRecentOutput(paneBeforeToken),
							retryable: false,
						};
					}
					const exitCode = Number.parseInt(completionMatch[1] || "1", 10);
					const normalizedExitCode = Number.isFinite(exitCode) ? exitCode : 0;
					if (normalizedExitCode === 124) {
						return {
							status: "timeout",
							output: this.extractRecentOutput(paneBeforeToken, completionToken),
							exitCode: normalizedExitCode,
							error: `tmux command timed out after ${timeoutMs}ms`,
							retryable: true,
							isTimeout: true,
						};
					}
					return {
						status: "completed",
						output: this.extractRecentOutput(paneBeforeToken, completionToken),
						exitCode: normalizedExitCode,
						retryable: false,
					};
				}
			} catch (error) {
				logger.debug({ sessionName, error: String(error) }, "tmux check failed, continuing...");
			}

			await this.sleep(pollIntervalMs);
		}

		// Timeout - return whatever output we have
		logger.warn({ sessionName, elapsedMs: Date.now() - startTime }, "tmux command timed out");

		try {
			const output = await this.capturePane(sessionName);

			return {
				status: "timeout",
				output: this.extractRecentOutput(output, completionToken),
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
	 * Extract recent output from tmux capture, filtering out echoed commands and old content
	 */
	private extractRecentOutput(fullOutput: string, completionToken?: string): string {
		const normalizedOutput = completionToken ? fullOutput.replaceAll(completionToken, "") : fullOutput;
		const lines = normalizedOutput.split("\n");

		// First, filter out lines that are clearly part of the echoed command
		// These typically start with > (tmux send-keys echo) or are command fragments
		const filteredLines: string[] = [];
		let inCommandEcho = true; // Start assuming we're in command echo section

		for (const line of lines) {
			// Skip empty lines at the start
			if (inCommandEcho && !line.trim()) {
				continue;
			}

			// Lines starting with > are typically tmux command echo
			if (line.startsWith("> ")) {
				inCommandEcho = true;
				continue;
			}

			// Lines that look like the prompt/command (contain common patterns)
			if (
				line.includes("Execute mini-app") ||
				line.includes("Instructions:") ||
				line.includes("Runtime variables:") ||
				line.startsWith("bash -c ")
			) {
				inCommandEcho = true;
				continue;
			}

			// Once we see actual response content, stop filtering
			if (line.match(/^#{1,2}\s+\w+/)) {
				// Markdown headers are response content
				inCommandEcho = false;
				filteredLines.push(line);
			} else if (!inCommandEcho && line.trim()) {
				// After we've exited echo mode, include all non-empty lines
				filteredLines.push(line);
			}
		}

		// If we have filtered content, return it
		if (filteredLines.length > 0) {
			return filteredLines.join("\n").trim();
		}

		// Fallback: look for response start markers in original lines
		const startMarkers = [/^Claude:/i, /^Here['']s/i, /^Based on/i, /^I['']ll/i, /^Let me/i, /^## /i, /^# /i];

		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			for (const marker of startMarkers) {
				if (marker.test(line)) {
					return lines.slice(i).join("\n").trim();
				}
			}
		}

		// Last resort: return last 60% of output
		const keepLines = Math.floor(lines.length * 0.6);
		return lines.slice(-keepLines).join("\n").trim();
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private shellQuote(value: string): string {
		return `'${value.replace(/'/g, "'\\''")}'`;
	}

	private async capturePane(sessionName: string): Promise<string> {
		const proc = Bun.spawn(["tmux", "capture-pane", "-t", sessionName, "-p", "-S", "-2000"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const output = await new Response(proc.stdout).text();
		await proc.exited;
		return output;
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
		const proc = Bun.spawn(["tmux", "new-session", "-d", "-s", sessionName, "-c", cwd || ".", "bash"], {
			stdout: "pipe",
			stderr: "pipe",
		});

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

	private async killHostSession(sessionName: string): Promise<void> {
		const proc = Bun.spawn(["tmux", "kill-session", "-t", sessionName], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
	}

	private async interruptHostSession(sessionName: string): Promise<void> {
		const proc = Bun.spawn(["tmux", "send-keys", "-t", sessionName, "C-c"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
	}

	/**
	 * Build full command with workspace context
	 * Unsets CLAUDECODE to allow running claude inside Claude Code sessions
	 */
	private buildCommand(
		command: string,
		args: string[],
		workspace: string,
		completionToken: string,
		timeoutMs: number,
	): string {
		const workspacePath = this.resolveWorkspacePath(workspace) || ".";
		const quotedCommand = [command, ...args].map((item) => this.shellQuote(item)).join(" ");
		// Fire the watchdog slightly before the engine timeout so completion token can be captured in time.
		const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000) - 3);
		const timeoutMarker = `/tmp/cc-bridge-timeout-${completionToken}.flag`;
		const quotedTimeoutMarker = this.shellQuote(timeoutMarker);

		// Unset CLAUDECODE to allow running claude inside Claude Code sessions
		// Also unset any other Claude Code related env vars
		return (
			`cd ${this.shellQuote(workspacePath)} && ` +
			"unset CLAUDECODE CLAUDE_API_KEY CLAUDE_API_URL && " +
			`rm -f ${quotedTimeoutMarker}; ` +
			`${quotedCommand} & ` +
			"__cc_bridge_target_pid=$!; " +
			"( sleep " +
			`${timeoutSeconds}; ` +
			"if kill -0 $__cc_bridge_target_pid 2>/dev/null; then " +
			`echo timeout > ${quotedTimeoutMarker}; ` +
			"kill -TERM $__cc_bridge_target_pid 2>/dev/null || true; " +
			"sleep 2; " +
			"kill -KILL $__cc_bridge_target_pid 2>/dev/null || true; " +
			"fi ) & " +
			"__cc_bridge_watchdog_pid=$!; " +
			"wait $__cc_bridge_target_pid; " +
			"__cc_bridge_rc=$?; " +
			"kill $__cc_bridge_watchdog_pid 2>/dev/null || true; " +
			`if [ -f ${quotedTimeoutMarker} ]; then __cc_bridge_rc=124; rm -f ${quotedTimeoutMarker}; fi; ` +
			`printf '\\n${completionToken}:%s\\n' "$__cc_bridge_rc"`
		);
	}

	/**
	 * Send command to host tmux session
	 * Uses temp file for long commands to avoid "command too long" error
	 */
	private async sendToHostSession(sessionName: string, command: string, requestId: string): Promise<void> {
		// For long commands, write to temp file first to avoid "command too long"
		const MAX_DIRECT_LENGTH = 8000; // Conservative limit for tmux send-keys

		if (command.length > MAX_DIRECT_LENGTH || command.includes("\n")) {
			// Write command to temp file
			const promptFileSafeId = requestId.replace(/[^a-zA-Z0-9_-]/g, "_");
			const promptFile = `/tmp/cc-bridge-host-${promptFileSafeId}.sh`;

			// Write file using Bun
			await Bun.write(promptFile, command);

			// Source the file in tmux
			const proc = Bun.spawn(
				[
					"tmux",
					"send-keys",
					"-t",
					sessionName,
					`bash ${this.shellQuote(promptFile)}; __cc_bridge_rc=$?; rm -f ${this.shellQuote(promptFile)}`,
					"C-m",
				],
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
			return;
		}

		// Short command: send directly
		const proc = Bun.spawn(["tmux", "send-keys", "-t", sessionName, command, "C-m"], {
			stdout: "pipe",
			stderr: "pipe",
		});

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
