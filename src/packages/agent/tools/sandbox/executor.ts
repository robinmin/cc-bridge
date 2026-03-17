/**
 * Sandbox Executor
 *
 * Executes commands either on host or in Docker container.
 * Inspired by Pi-mono's simple approach with OpenClaw's validation.
 */

import { spawn } from "node:child_process";
import type { ToolSandboxConfig, ToolSandboxDockerSettings } from "./config";
import { limitsToDockerArgs, parseResourceLimits } from "./limits";
import { validateSandboxConfig } from "./validator";

/**
 * Execution result
 */
export interface ExecResult {
	/** Standard output */
	stdout: string;
	/** Standard error */
	stderr: string;
	/** Exit code */
	code: number;
	/** Whether the command was killed due to timeout */
	timedOut: boolean;
}

/**
 * Execution options
 */
export interface ExecOptions {
	/** Timeout in milliseconds */
	timeoutMs?: number;
	/** Abort signal */
	signal?: AbortSignal;
	/** Working directory */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
}

/**
 * Base executor interface
 */
export interface SandboxExecutor {
	/**
	 * Execute a command
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;

	/**
	 * Get the workspace path for this executor
	 */
	getWorkspacePath(hostPath: string): string;

	/**
	 * Check if this executor is using sandboxing
	 */
	isSandboxed(): boolean;
}

/**
 * Host executor - runs commands directly on host (no sandbox)
 */
export class HostExecutor implements SandboxExecutor {
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return execWithTimeout("sh", ["-c", command], options);
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}

	isSandboxed(): boolean {
		return false;
	}
}

/**
 * Docker executor - runs commands in Docker container
 */
export class DockerExecutor implements SandboxExecutor {
	constructor(
		private container: string,
		private settings?: ToolSandboxDockerSettings,
	) {
		// Validate Docker settings
		if (settings) {
			validateSandboxConfig({ docker: settings });
		}
	}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const dockerArgs = this.buildDockerArgs();

		// Build the docker exec command
		const execCmd = `docker exec ${dockerArgs.join(" ")} ${this.container} sh -c ${shellEscape(command)}`;

		return execWithTimeout("sh", ["-c", execCmd], options);
	}

	private buildDockerArgs(): string[] {
		const args: string[] = [];

		// Add resource limits if specified
		if (this.settings) {
			const limits = parseResourceLimits({
				memory: this.settings.memory,
				cpus: this.settings.cpus,
				pidsLimit: this.settings.pidsLimit,
			});
			args.push(...limitsToDockerArgs(limits));
		}

		// Add network mode
		if (this.settings?.network && this.settings.network !== "bridge") {
			args.push("--network", this.settings.network);
		}

		// Add environment variables
		if (this.settings?.env) {
			for (const [key, value] of Object.entries(this.settings.env)) {
				args.push("-e", `${key}=${value}`);
			}
		}

		// Add working directory
		if (this.settings?.workdir) {
			args.push("-w", this.settings.workdir);
		}

		return args;
	}

	getWorkspacePath(_hostPath: string): string {
		// Docker container sees /workspace
		return this.settings?.workdir || "/workspace";
	}

	isSandboxed(): boolean {
		return true;
	}
}

/**
 * Create executor based on config
 */
export function createSandboxExecutor(config: ToolSandboxConfig, container?: string): SandboxExecutor {
	switch (config.defaultMode) {
		case "host":
			return new HostExecutor();
		case "docker": {
			const containerName = container ?? config.docker?.containerPrefix;
			if (!containerName) {
				throw new Error("Docker mode requires a container name (pass container param or set docker.containerPrefix)");
			}
			return new DockerExecutor(containerName, config.docker);
		}
		default:
			return new HostExecutor();
	}
}

/**
 * Create executor with explicit container
 */
export function createDockerExecutor(container: string, settings?: ToolSandboxDockerSettings): SandboxExecutor {
	return new DockerExecutor(container, settings);
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Execute a command with timeout
 */
function execWithTimeout(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			detached: false,
			stdio: ["ignore", "pipe", "pipe"],
			cwd: options?.cwd,
			env: options?.env,
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timeoutHandle = options?.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					if (child.pid) killProcessTree(child.pid);
				}, options.timeoutMs)
			: undefined;

		const onAbort = () => {
			if (child.pid) {
				killProcessTree(child.pid);
			}
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
			// Limit output size
			if (stdout.length > 10 * 1024 * 1024) {
				stdout = stdout.slice(0, 10 * 1024 * 1024);
			}
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
			if (stderr.length > 10 * 1024 * 1024) {
				stderr = stderr.slice(0, 10 * 1024 * 1024);
			}
		});

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (options?.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}

			if (options?.signal?.aborted) {
				reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
				return;
			}

			if (timedOut) {
				reject(new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeoutMs}ms`.trim()));
				return;
			}

			resolve({ stdout, stderr, code: code ?? 0, timedOut: false });
		});

		child.on("error", (error) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			reject(error);
		});
	});
}

/**
 * Kill a process and its children
 */
function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore errors
		}
	} else {
		try {
			// Try process group kill first
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				// Fallback to single process
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}

/**
 * Escape a string for shell
 */
function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
