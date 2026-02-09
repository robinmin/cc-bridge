import { logger } from "@/packages/logger";
import type { IIpcClient, IpcClientConfig, IpcRequest, IpcResponse } from "./types";

const DEFAULT_TCP_PORT = 3001;
const DEFAULT_TCP_HOST = "localhost";

/**
 * TCP IPC Client - communicates with agent via TCP socket
 * Fastest IPC method when available
 */
export class TcpIpcClient implements IIpcClient {
	private readonly host: string;
	private readonly port: number;

	constructor(_config: IpcClientConfig = {}) {
		this.host = process.env.AGENT_TCP_HOST || DEFAULT_TCP_HOST;
		this.port = Number.parseInt(process.env.AGENT_TCP_PORT || String(DEFAULT_TCP_PORT), 10);
	}

	getMethod(): string {
		return "tcp";
	}

	isAvailable(): boolean {
		// TCP is available if the port is configured
		return true;
	}

	async sendRequest(request: IpcRequest, timeout = 300000): Promise<IpcResponse> {
		const { method, path: requestPath, body } = request;
		const payload = body ? JSON.stringify(body) : undefined;

		try {
			const url = `http://${this.host}:${this.port}${requestPath}`;
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};

			const fetchRequest = new Request(url, {
				method,
				headers,
				body: payload,
			});

			// Add timeout to fetch
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeout);

			const response = await fetch(fetchRequest, { signal: controller.signal });
			clearTimeout(timeoutId);

			const responseBody = await response.json();

			logger.debug(
				{ id: request.id, path: requestPath, status: response.status, method: this.getMethod() },
				"IPC request processed",
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
					tcpHost: this.host,
					tcpPort: this.port,
					error: error instanceof Error ? error.message : String(error),
				},
				"TCP IPC failed",
			);
			throw error;
		}
	}
}
