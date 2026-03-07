import type { Hono } from "hono";
import { logger } from "@/packages/logger";

/**
 * StdioIpcAdapter - Agent-side stdio IPC adapter
 * Reads JSON-RPC requests from stdin, routes them through Hono, writes responses to stdout
 */
export class StdioIpcAdapter {
	private app: Hono;
	private input: ReadableStream<Uint8Array>;
	private output: (msg: string) => void;

	constructor(
		app: Hono,
		input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
		output: (msg: string) => void = (msg) => process.stdout.write(`${msg}\n`),
	) {
		this.app = app;
		this.input = input;
		this.output = output;
	}

	async start() {
		const reader = this.input.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.trim()) {
						await this.handleLine(line);
					}
				}
			}
		} catch (error) {
			console.error("Fatal IPC error:", error);
			process.exit(1);
		} finally {
			reader.releaseLock();
			// In one-shot IPC mode, we must exit to close stdout and release the Gateway's await
			process.exit(0);
		}
	}

	private async handleLine(line: string) {
		try {
			const payload = JSON.parse(line);
			const id = payload.id || "unknown";
			const method = payload.method || "GET";
			const path = payload.path || "/";
			const body = payload.body ? JSON.stringify(payload.body) : undefined;

			const url = `http://localhost${path}`;
			const request = new Request(url, {
				method,
				headers: { "Content-Type": "application/json" },
				body,
			});

			const response = await this.app.fetch(request);
			const responseBody = await response.json().catch(() => ({}));

			logger.debug({ id, path, status: response.status }, "IPC request processed");

			const ipcResponse = {
				id,
				status: response.status,
				result: response.ok ? responseBody : undefined,
				error: !response.ok ? responseBody : undefined,
			};

			this.output(JSON.stringify(ipcResponse));
		} catch (error) {
			this.output(
				JSON.stringify({
					id: "error",
					status: 500,
					error: {
						message: error instanceof Error ? error.message : String(error),
					},
				}),
			);
		}
	}
}
