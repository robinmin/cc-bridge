import { logger } from "@/packages/logger";
import type { RemoteBackend } from "./backends";
import type { IIpcClient, IpcRequest, IpcResponse } from "./types";
import { parseFetchResponseBody, toIpcErrorPayload } from "./response-utils";

const DEFAULT_TIMEOUT = 120000;

/**
 * Remote IPC Client - communicates with agent running on remote machine
 * Useful for distributed systems and cloud deployments
 */
export class RemoteIpcClient implements IIpcClient {
	private readonly backend: RemoteBackend;

	constructor(backend: RemoteBackend) {
		this.backend = backend;
		logger.info({ url: backend.url }, "Remote IPC client created");
	}

	getMethod(): string {
		return "remote";
	}

	isAvailable(): boolean {
		// Remote client assumes URL is reachable
		return true;
	}

	async sendRequest(request: IpcRequest, timeout = DEFAULT_TIMEOUT): Promise<IpcResponse> {
		const { method, path: requestPath, body } = request;
		const payload = body ? JSON.stringify(body) : undefined;

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);
		try {
			const url = `${this.backend.url}${requestPath}`;
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};

			// Add API key if provided
			if (this.backend.apiKey) {
				headers.Authorization = `Bearer ${this.backend.apiKey}`;
			}

			const fetchRequest = new Request(url, {
				method,
				headers,
				body: payload,
			});

			const response = await fetch(fetchRequest, { signal: controller.signal });
			const responseBody = await parseFetchResponseBody(response);

			logger.debug(
				{ id: request.id, path: requestPath, status: response.status, backend: "remote" },
				"Remote IPC request processed",
			);

			return {
				id: request.id,
				status: response.status,
				result: response.ok ? responseBody : undefined,
				error: !response.ok ? toIpcErrorPayload(responseBody, response.status) : undefined,
			};
		} catch (error) {
			logger.warn(
				{
					url: this.backend.url,
					error: error instanceof Error ? error.message : String(error),
				},
				"Remote IPC failed",
			);
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}
