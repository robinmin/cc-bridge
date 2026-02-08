import { logger } from "@/packages/logger";
import type { IIpcClient, IpcClientConfig, IpcRequest, IpcResponse } from "./types";

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Docker Exec IPC Client - communicates with agent via docker exec stdio
 * Fallback method when faster IPC methods are unavailable
 */
export class DockerExecIpcClient implements IIpcClient {
	private readonly containerId: string;

	constructor(config: IpcClientConfig = {}) {
		if (!config.containerId) {
			throw new Error("DockerExecIpcClient requires containerId");
		}
		this.containerId = config.containerId;
	}

	getMethod(): string {
		return "docker-exec";
	}

	isAvailable(): boolean {
		// Docker exec is always available as a fallback
		return true;
	}

	async sendRequest(request: IpcRequest, timeout = DEFAULT_TIMEOUT_MS): Promise<IpcResponse> {
		const payload = JSON.stringify(request);

		try {
			logger.debug({ containerId: this.containerId, method: this.getMethod() }, "Using docker exec for IPC (fallback)");

			// Force stdio mode to ensure we don't try to start a second server inside the container
			const proc = Bun.spawn(
				["docker", "exec", "-i", "-e", "AGENT_MODE=stdio", this.containerId, "bun", "run", "src/agent/index.ts"],
				{
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			// Set up cleanup for process resources
			let writerClosed = false;
			const cleanup = () => {
				if (!writerClosed) {
					try {
						proc.stdin.end();
					} catch {
						// Ignore cleanup errors
					}
					writerClosed = true;
				}
			};

			// Set timeout
			const timeoutId = setTimeout(() => {
				cleanup();
				proc.kill();
			}, timeout);

			try {
				const writer = proc.stdin;
				writer.write(`${payload}\n`);
				writer.flush();
				writer.end();
				writerClosed = true;

				const stdout = await new Response(proc.stdout).text();
				const stderr = await new Response(proc.stderr).text();
				const exitCode = await proc.exited;

				clearTimeout(timeoutId);

				if (exitCode !== 0 && !stdout) {
					const errorMsg = stderr.trim() || `Agent exited with code ${exitCode}`;
					throw new Error(errorMsg);
				}

				const response = this.parseResponse(stdout, request.id);
				logger.debug({ id: request.id, method: this.getMethod(), status: response.status }, "IPC request processed");
				return response;
			} finally {
				cleanup();
			}
		} catch (error) {
			logger.warn(
				{
					containerId: this.containerId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Docker exec IPC failed",
			);
			throw error;
		}
	}

	private parseResponse(stdout: string, requestId: string): IpcResponse {
		const lines = stdout.trim().split("\n");

		// Search from the end for the most recent response
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();

			// Skip non-JSON lines
			if (!line.startsWith("{") || !line.endsWith("}")) continue;

			try {
				const parsed = JSON.parse(line);
				if (parsed && typeof parsed === "object" && parsed.id === requestId) {
					return parsed as IpcResponse;
				}
			} catch {
				// Continue to next line on parse error
			}
		}

		throw new Error(`Could not find valid JSON response with ID ${requestId} in output`);
	}
}
