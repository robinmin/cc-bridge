import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { logger } from "@/packages/logger";
import { parseRawResponseBody, toIpcErrorPayload } from "./response-utils";
import type { IIpcClient, IpcClientConfig, IpcRequest, IpcResponse } from "./types";

const SOCKET_TIMEOUT_MS = 5000;

/**
 * Unix Socket IPC Client - communicates with agent via Unix domain socket
 * Fast IPC method for local communication
 */
export class UnixSocketIpcClient implements IIpcClient {
	private socketPath?: string;

	constructor(config: IpcClientConfig = {}) {
		if (config.instanceName) {
			// Check for Unix socket on host (shared volume)
			const hostSocket = path.resolve("data/ipc", config.instanceName, "agent.sock");
			if (fs.existsSync(hostSocket)) {
				this.socketPath = hostSocket;
				logger.debug({ socketPath: hostSocket }, "Unix socket IPC available");
			}
		}
	}

	getMethod(): string {
		return "unix";
	}

	isAvailable(): boolean {
		if (this.socketPath === undefined) return false;
		return fs.existsSync(this.socketPath);
	}

	async sendRequest(request: IpcRequest): Promise<IpcResponse> {
		if (!this.socketPath) {
			throw new Error("Unix socket path not configured");
		}

		// Use local const with proper typing (socketPath is validated above)
		const socketPath = this.socketPath;
		const { method, path: requestPath, body } = request;
		const payload = body ? JSON.stringify(body) : undefined;

		try {
			// Build raw HTTP request for Unix socket communication
			const headers = [
				`${method} ${requestPath} HTTP/1.1`,
				"Host: localhost",
				"Content-Type: application/json",
				"Accept: application/json",
				"Connection: close", // Essential for one-off request/response on raw socket
			];

			if (payload) {
				headers.push(`Content-Length: ${Buffer.byteLength(payload)}`);
			}

			const httpRequest = [...headers.join("\r\n"), "\r\n", payload || ""].join("\r\n");

			// Create a promise-based socket connection
			const rawResponse = await new Promise<string>((resolve, reject) => {
				const socket = net.createConnection({ path: socketPath });

				let responseData = "";
				let timedOut = false;

				// Set timeout
				const timeoutId = setTimeout(() => {
					timedOut = true;
					socket.destroy();
					reject(new Error("Unix socket connection timed out"));
				}, SOCKET_TIMEOUT_MS);

				socket.on("connect", () => {
					socket.write(httpRequest);
				});

				socket.on("data", (chunk) => {
					responseData += chunk.toString();
				});

				socket.on("end", () => {
					clearTimeout(timeoutId);
					if (!timedOut) resolve(responseData);
				});

				socket.on("error", (err) => {
					clearTimeout(timeoutId);
					reject(err);
				});
			});

			// Parse HTTP response
			const parts = rawResponse.split("\r\n\r\n");
			const headersPart = parts[0];
			const bodyPart = parts.slice(1).join("\r\n");

			// Extract status code from headers
			const statusLine = headersPart.split("\r\n")[0];
			const statusMatch = statusLine.match(/HTTP\/1\.1 (\d+)/);
			const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 500;

			// Parse JSON body
			const responseBody = parseRawResponseBody(bodyPart);

			logger.debug({ id: request.id, path: requestPath, status, method: this.getMethod() }, "IPC request processed");

			return {
				id: request.id,
				status,
				result: status >= 200 && status < 300 ? responseBody : undefined,
				error: status >= 400 ? toIpcErrorPayload(responseBody, status) : undefined,
			};
		} catch (error) {
			logger.warn(
				{
					socketPath: this.socketPath,
					error: error instanceof Error ? error.message : String(error),
				},
				"Unix socket IPC failed",
			);
			throw error;
		}
	}
}
