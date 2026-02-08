import fs from "node:fs";
import { logger } from "@/packages/logger";
import type { HostBackend } from "./backends";
import type { IIpcClient, IpcRequest, IpcResponse } from "./types";

const DEFAULT_HOST_PORT = 3001;
const DEFAULT_HOST = "localhost";
const DEFAULT_SOCKET_PATH = "/tmp/cc-bridge-agent.sock";

/**
 * Host IPC Client - communicates with agent running directly on host (no Docker)
 * Best for development when you want to skip Docker overhead
 */
export class HostIpcClient implements IIpcClient {
	private readonly backend: HostBackend;
	private readonly useTcp: boolean;
	private readonly useUnix: boolean;

	constructor(backend: HostBackend) {
		this.backend = backend;

		// Determine communication method
		this.useTcp = !!backend.port;
		this.useUnix = !!backend.socketPath;

		if (!this.useTcp && !this.useUnix) {
			// Try to auto-detect
			this.useTcp = true; // Default to TCP
		}

		logger.info(
			{
				method: this.useTcp ? "TCP" : "Unix",
				port: backend.port,
				socketPath: backend.socketPath,
				host: backend.host,
			},
			"Host IPC client created",
		);
	}

	getMethod(): string {
		return "host";
	}

	isAvailable(): boolean {
		if (this.useTcp) {
			// TCP is always available if port is configured
			return true;
		}

		if (this.useUnix && this.backend.socketPath) {
			// Check if socket exists
			return fs.existsSync(this.backend.socketPath);
		}

		return true; // Assume available
	}

	async sendRequest(request: IpcRequest, timeout = 120000): Promise<IpcResponse> {
		if (this.useTcp) {
			return this.sendViaTcp(request, timeout);
		}
		return this.sendViaUnixSocket(request, timeout);
	}

	private async sendViaTcp(request: IpcRequest, timeout: number): Promise<IpcResponse> {
		const { method, path: requestPath, body } = request;
		const payload = body ? JSON.stringify(body) : undefined;

		const host = this.backend.host || DEFAULT_HOST;
		const port = this.backend.port || DEFAULT_HOST_PORT;

		try {
			const url = `http://${host}:${port}${requestPath}`;
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};

			const fetchRequest = new Request(url, {
				method,
				headers,
				body: payload,
			});

			// Add timeout
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeout);

			const response = await fetch(fetchRequest, { signal: controller.signal });
			clearTimeout(timeoutId);

			const responseBody = await response.json();

			logger.debug(
				{ id: request.id, path: requestPath, status: response.status, backend: "host-tcp" },
				"Host IPC request processed",
			);

			return {
				id: request.id,
				status: response.status,
				result: response.ok ? responseBody : undefined,
				error: !response.ok ? responseBody : undefined,
			};
		} catch (error) {
			logger.warn(
				{
					host,
					port,
					error: error instanceof Error ? error.message : String(error),
				},
				"Host TCP IPC failed",
			);
			throw error;
		}
	}

	private async sendViaUnixSocket(request: IpcRequest): Promise<IpcResponse> {
		const socketPath = this.backend.socketPath || DEFAULT_SOCKET_PATH;

		if (!fs.existsSync(socketPath)) {
			throw new Error(`Unix socket not found: ${socketPath}`);
		}

		const { method, path: requestPath, body } = request;
		const payload = body ? JSON.stringify(body) : undefined;

		// Import net only when needed to avoid issues
		const net = await import("node:net");

		try {
			// Build raw HTTP request
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

			// Create socket connection
			const _response = await new Promise<string>((resolve, reject) => {
				const socket = net.default.createConnection({ path: socketPath });

				let responseData = "";
				const timeoutId = setTimeout(() => {
					socket.destroy();
					reject(new Error("Unix socket connection timed out"));
				}, 5000);

				socket.on("connect", () => {
					socket.write(httpRequest);
				});

				socket.on("data", (chunk: Buffer) => {
					responseData += chunk.toString();
				});

				socket.on("end", () => {
					clearTimeout(timeoutId);
					resolve(responseData);
				});

				socket.on("error", (err) => {
					clearTimeout(timeoutId);
					reject(err);
				});
			});

			// Parse HTTP response
			const parts = responseData.split("\r\n\r\n");
			const headersPart = parts[0];
			const bodyPart = parts.slice(1).join("\r\n");

			const statusLine = headersPart.split("\r\n")[0];
			const statusMatch = statusLine.match(/HTTP\/1\.1 (\d+)/);
			const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 500;

			const responseBody = bodyPart ? JSON.parse(bodyPart) : {};

			logger.debug({ id: request.id, path: requestPath, status, backend: "host-unix" }, "Host IPC request processed");

			return {
				id: request.id,
				status,
				result: status >= 200 && status < 300 ? responseBody : undefined,
				error: status >= 400 ? responseBody : undefined,
			};
		} catch (error) {
			logger.warn(
				{
					socketPath,
					error: error instanceof Error ? error.message : String(error),
				},
				"Host Unix socket IPC failed",
			);
			throw error;
		}
	}
}
