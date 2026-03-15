/**
 * Bash Tool
 *
 * AgentTool that executes shell commands in the workspace directory.
 * Commands run with cwd set to the workspace and a configurable timeout.
 * Output is capped to prevent excessive token usage.
 *
 * SECURITY NOTE: This tool intentionally grants the AI agent arbitrary shell
 * access within the workspace. The agent IS the trust boundary — it decides
 * which commands to run. The `DANGEROUS_PATTERNS` blocklist below is a
 * defense-in-depth safety net against common catastrophic mistakes (e.g.
 * `rm -rf /`), NOT a security boundary. A determined agent can bypass it.
 */

import { spawn } from "node:child_process";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB

/**
 * Options for creating a bash tool (primarily for testing)
 * @internal
 */
export interface BashToolOptions {
	/** Override timeout in milliseconds (for testing) */
	timeoutMs?: number;
	/** Custom spawn function for testing error cases */
	_spawn?: typeof spawn;
}

/**
 * Defense-in-depth blocklist of destructive command patterns.
 * These are common catastrophic mistakes — not a security boundary.
 */
const DANGEROUS_PATTERNS: { pattern: RegExp; description: string }[] = [
	{ pattern: /rm\s+(-\w*f\w*\s+.*\/|.*\s+\/)(?!\w)/, description: "rm -rf / or similar root-level removal" },
	{ pattern: /mkfs\b/, description: "filesystem formatting" },
	{ pattern: /dd\s+if=/, description: "raw disk write via dd" },
	{ pattern: /:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;?\s*:/, description: "fork bomb" },
	{ pattern: />\s*\/dev\/sd[a-z]/, description: "direct write to block device" },
	{ pattern: /chmod\s+(-\w*R\w*\s+)?0?777\s+\/\s*$/, description: "chmod 777 on root" },
];

/**
 * Check if a command matches any dangerous pattern.
 * Returns the description of the matched pattern, or null if safe.
 */
function matchesDangerousPattern(command: string): string | null {
	for (const { pattern, description } of DANGEROUS_PATTERNS) {
		if (pattern.test(command)) {
			return description;
		}
	}
	return null;
}

const parameters = Type.Object({
	command: Type.String({ description: "Shell command to execute in the workspace directory" }),
});

type BashParams = Static<typeof parameters>;

interface BashDetails {
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
}

/**
 * Execute a shell command and collect stdout/stderr.
 * Returns when the process exits or is killed by timeout/abort.
 */
function execCommand(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	customSpawn?: typeof spawn,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null; timedOut: boolean }> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Bash operation was aborted"));
			return;
		}

		const spawnFn = customSpawn ?? spawn;
		const child = spawnFn("sh", ["-c", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let stdoutTruncated = false;
		let stderrTruncated = false;

		child.stdout.on("data", (data: Buffer) => {
			if (stdout.length + stderr.length < MAX_OUTPUT_BYTES) {
				const remaining = MAX_OUTPUT_BYTES - stdout.length - stderr.length;
				stdout += data.toString("utf-8").slice(0, remaining);
				if (data.length > remaining) {
					stdoutTruncated = true;
				}
			}
		});

		child.stderr.on("data", (data: Buffer) => {
			if (stdout.length + stderr.length < MAX_OUTPUT_BYTES) {
				const remaining = MAX_OUTPUT_BYTES - stdout.length - stderr.length;
				stderr += data.toString("utf-8").slice(0, remaining);
				if (data.length > remaining) {
					stderrTruncated = true;
				}
			}
		});

		// Track force-kill timer so it can be cleared
		let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

		// Helper to schedule force-kill after SIGTERM
		const scheduleForceKill = () => {
			forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
		};

		// Timeout handler
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			scheduleForceKill();
		}, timeoutMs);

		// Abort signal handler
		const onAbort = () => {
			child.kill("SIGTERM");
			scheduleForceKill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("close", (code, sig) => {
			clearTimeout(timer);
			if (forceKillTimer !== null) {
				clearTimeout(forceKillTimer);
			}
			signal?.removeEventListener("abort", onAbort);

			if (stdoutTruncated || stderrTruncated) {
				const truncMsg = "\n[Output truncated - exceeded 50KB limit]";
				if (stdoutTruncated) stdout += truncMsg;
				if (stderrTruncated) stderr += truncMsg;
			}

			resolve({
				stdout,
				stderr,
				exitCode: code,
				signal: sig,
				timedOut,
			});
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			if (forceKillTimer !== null) {
				clearTimeout(forceKillTimer);
			}
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
	});
}

/**
 * Create a bash AgentTool bound to a workspace directory.
 * @param workspaceDir - Directory to execute commands in
 * @param options - Optional configuration (primarily for testing)
 */
export function createBashTool(
	workspaceDir: string,
	options?: BashToolOptions,
): AgentTool<typeof parameters, BashDetails> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const customSpawn = options?._spawn;
	return {
		name: "bash",
		label: "Bash",
		description:
			"Execute a shell command in the workspace directory. " +
			"The command runs with a 30-second timeout. " +
			"Combined stdout+stderr output is limited to 50KB.",
		parameters,
		execute: async (
			_toolCallId: string,
			params: BashParams,
			signal?: AbortSignal,
		): Promise<AgentToolResult<BashDetails>> => {
			// Defense-in-depth: block obviously catastrophic commands
			const dangerousMatch = matchesDangerousPattern(params.command);
			if (dangerousMatch) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Command blocked by safety filter (${dangerousMatch}). This is a defense-in-depth check against common destructive patterns.`,
						},
					],
					details: {
						exitCode: null,
						signal: null,
						timedOut: false,
					},
				};
			}

			const result = await execCommand(params.command, workspaceDir, timeoutMs, signal, customSpawn);

			const parts: string[] = [];

			if (result.timedOut) {
				parts.push(`[Command timed out after ${timeoutMs / 1000} seconds]`);
			}

			if (result.stdout) {
				parts.push(result.stdout);
			}

			if (result.stderr) {
				parts.push(`[stderr]\n${result.stderr}`);
			}

			if (!result.stdout && !result.stderr && !result.timedOut) {
				parts.push(`Command completed with exit code ${result.exitCode ?? "unknown"}.`);
			}

			if (result.exitCode !== null && result.exitCode !== 0 && !result.timedOut) {
				parts.push(`[exit code: ${result.exitCode}]`);
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: {
					exitCode: result.exitCode,
					signal: result.signal,
					timedOut: result.timedOut,
				},
			};
		},
	};
}
