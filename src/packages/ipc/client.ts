import fs from "node:fs";
import path from "node:path";
import { logger } from "@/packages/logger";
import type { IpcRequest, IpcResponse } from "@/packages/types";

// Default timeout for IPC requests (2 minutes)
const DEFAULT_IPC_TIMEOUT_MS = 120000;

// Circuit breaker state
interface CircuitState {
	failures: number;
	lastFailureTime: number;
	state: "closed" | "open" | "half-open";
}

// Circuit breaker configuration
const CIRCUIT_BREAKER_CONFIG = {
	threshold: 5, // Number of failures before opening
	halfOpenTimeoutMs: 60000, // Time before trying again (1 minute)
	resetTimeoutMs: 120000, // Time to fully reset (2 minutes)
};

export class IpcClient {
	private static circuitState: CircuitState = {
		failures: 0,
		lastFailureTime: 0,
		state: "closed",
	};
	private socketPath?: string;
	private tcpPort?: number;
	private tcpHost?: string;

	constructor(
		private containerId: string,
		private instanceName?: string,
	) {
		if (this.instanceName) {
			// Check for Unix socket on host (shared volume)
			const hostSocket = path.resolve("data/ipc", this.instanceName, "agent.sock");
			if (fs.existsSync(hostSocket)) {
				this.socketPath = hostSocket;
				logger.debug({ socketPath: hostSocket }, "Unix socket found, will use fast IPC");
			}

			// Check if TCP mode is available (faster than docker exec)
			// Agent runs on localhost:3001 when in TCP mode
			this.tcpPort = Number.parseInt(process.env.AGENT_TCP_PORT || "3001", 10);
			this.tcpHost = process.env.AGENT_TCP_HOST || "localhost";
		}
	}

	async sendRequest(request: IpcRequest, timeoutMs: number = DEFAULT_IPC_TIMEOUT_MS): Promise<IpcResponse> {
		// Check circuit breaker
		if (!this.isCircuitAvailable()) {
			return {
				id: request.id,
				status: 503,
				error: {
					message: "Service temporarily unavailable (circuit breaker open)",
				},
			};
		}

		try {
			// Try methods in order of preference: TCP > Unix socket > docker exec
			let sendMethod = this.sendViaDockerExec.bind(this);

			if (this.tcpPort) {
				logger.debug({ tcpHost: this.tcpHost, tcpPort: this.tcpPort }, "Using TCP for fast IPC");
				sendMethod = this.sendViaTcp.bind(this);
			} else if (this.socketPath) {
				logger.debug({ socketPath: this.socketPath }, "Using Unix socket for fast IPC");
				sendMethod = this.sendViaSocket.bind(this);
			}

			const response = await Promise.race([sendMethod(request), this.createTimeoutPromise(timeoutMs, request.id)]);

			// Record success for circuit breaker
			this.recordSuccess();

			return response;
		} catch (error: unknown) {
			// Record failure for circuit breaker
			this.recordFailure();

			return {
				id: request.id,
				status: 500,
				error: {
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}

	private createTimeoutPromise(timeoutMs: number, requestId: string): Promise<IpcResponse> {
		return new Promise((resolve) => {
			setTimeout(() => {
				resolve({
					id: requestId,
					status: 408,
					error: { message: `Request timeout after ${timeoutMs}ms` },
				});
			}, timeoutMs);
		});
	}

	private isCircuitAvailable(): boolean {
		const now = Date.now();
		const state = IpcClient.circuitState;

		// Reset to closed if enough time has passed
		if (state.state === "open" && now - state.lastFailureTime > CIRCUIT_BREAKER_CONFIG.resetTimeoutMs) {
			logger.info("Circuit breaker reset to closed state");
			state.failures = 0;
			state.state = "closed";
			return true;
		}

		// Try half-open after threshold
		if (state.state === "open" && now - state.lastFailureTime > CIRCUIT_BREAKER_CONFIG.halfOpenTimeoutMs) {
			logger.info("Circuit breaker entering half-open state");
			state.state = "half-open";
			return true;
		}

		return state.state !== "open";
	}

	private recordSuccess() {
		const state = IpcClient.circuitState;
		if (state.state === "half-open") {
			logger.info("Circuit breaker recovered, returning to closed state");
			state.failures = 0;
			state.state = "closed";
		} else if (state.state === "closed" && state.failures > 0) {
			// Decay failures on success
			state.failures = Math.max(0, state.failures - 1);
		}
	}

	private recordFailure() {
		const state = IpcClient.circuitState;
		state.failures++;
		state.lastFailureTime = Date.now();

		logger.warn(
			{
				failures: state.failures,
				threshold: CIRCUIT_BREAKER_CONFIG.threshold,
			},
			"IPC call failed",
		);

		if (state.failures >= CIRCUIT_BREAKER_CONFIG.threshold) {
			logger.error("Circuit breaker opened due to repeated failures");
			state.state = "open";
		}
	}

	private async sendViaTcp(request: IpcRequest): Promise<IpcResponse> {
		const { method, path: requestPath, body } = request;
		const payload = body ? JSON.stringify(body) : undefined;

		try {
			const url = `http://${this.tcpHost}:${this.tcpPort}${requestPath}`;
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};

			const fetchRequest = new Request(url, {
				method,
				headers,
				body: payload,
			});

			const response = await fetch(fetchRequest);
			const responseBody = await response.json();

			logger.debug({ id: request.id, path: requestPath, status: response.status }, "IPC request processed via TCP");

			return {
				id: request.id,
				status: response.status,
				result: response.ok ? responseBody : undefined,
				error: !response.ok ? responseBody : undefined,
			};
		} catch (error) {
			logger.warn(
				{
					tcpHost: this.tcpHost,
					tcpPort: this.tcpPort,
					error: error instanceof Error ? error.message : String(error),
				},
				"TCP communication failed",
			);
			throw error;
		}
	}

	private async sendViaSocket(request: IpcRequest): Promise<IpcResponse> {
		// This method is only called when this.socketPath is truthy (see sendRequest)
		const socketPath = this.socketPath as string;
		const { method, path: requestPath, body } = request;
		const payload = body ? JSON.stringify(body) : undefined;

		try {
			// Build raw HTTP request for Unix socket communication
			const headers = [
				`${method} ${requestPath} HTTP/1.1`,
				"Host: localhost",
				"Content-Type: application/json",
				"Accept: application/json",
			];

			if (payload) {
				headers.push(`Content-Length: ${Buffer.byteLength(payload)}`);
			}

			const httpRequest = [...headers.join("\r\n"), "\r\n", payload || ""].join("\r\n");

			// Create a promise-based socket connection
			const _response = await new Promise<string>((resolve, reject) => {
				const socket = net.createConnection({ path: socketPath });

				let responseData = "";

				socket.on("connect", () => {
					socket.write(httpRequest);
				});

				socket.on("data", (chunk) => {
					responseData += chunk.toString();
					// Check if we have the complete response (ends with \r\n\r\n after body)
					// For simplicity, we'll wait for the socket to close
				});

				socket.on("end", () => {
					resolve(responseData);
				});

				socket.on("error", (err) => {
					reject(err);
				});
			});

			// Parse HTTP response
			const parts = responseData.split("\r\n\r\n");
			const headersPart = parts[0];
			const bodyPart = parts.slice(1).join("\r\n");

			// Extract status code from headers
			const statusLine = headersPart.split("\r\n")[0];
			const statusMatch = statusLine.match(/HTTP\/1\.1 (\d+)/);
			const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 500;

			// Parse JSON body
			const responseBody = bodyPart ? JSON.parse(bodyPart) : {};

			logger.debug({ id: request.id, path: requestPath, status }, "IPC request processed via Unix socket");

			return {
				id: request.id,
				status,
				result: status >= 200 && status < 300 ? responseBody : undefined,
				error: status >= 400 ? responseBody : undefined,
			};
		} catch (error) {
			logger.warn(
				{
					socketPath: this.socketPath,
					error: error instanceof Error ? error.message : String(error),
				},
				"Unix socket communication failed, will retry via docker exec",
			);
			throw error;
		}
	}

	private async sendViaDockerExec(request: IpcRequest): Promise<IpcResponse> {
		const payload = JSON.stringify(request);

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

		try {
			const writer = proc.stdin;
			writer.write(`${payload}\n`);
			writer.flush();
			writer.end();
			writerClosed = true;

			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			if (exitCode !== 0 && !stdout) {
				const errorMsg = stderr.trim() || `Agent exited with code ${exitCode}`;
				throw new Error(errorMsg);
			}

			// Parse response with improved error handling
			return this.parseResponse(stdout, request.id);
		} finally {
			cleanup();
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

	/**
	 * Reset circuit breaker state (useful for testing or manual recovery)
	 */
	static resetCircuitBreaker() {
		IpcClient.circuitState = {
			failures: 0,
			lastFailureTime: 0,
			state: "closed",
		};
		logger.info("Circuit breaker manually reset");
	}

	/**
	 * Get current circuit breaker state (for monitoring)
	 */
	static getCircuitState(): CircuitState {
		return { ...IpcClient.circuitState };
	}
}
