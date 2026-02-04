import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { StdioIpcAdapter } from "@/packages/ipc";

describe("StdioIpcAdapter", () => {
	test("should process commands from input stream and write to output", async () => {
		const app = new Hono();
		app.post("/test", async (c) => c.json({ ok: true }));

		// Mock input stream
		const inputData = [
			JSON.stringify({ id: "1", method: "POST", path: "/test", body: {} }) +
			"\n",
			`${JSON.stringify({ id: "2", method: "POST", path: "/test" })}\n`,
		];

		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();
				for (const chunk of inputData) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		});

		// Mock output
		const outputs: string[] = [];
		const mockOutput = (msg: string) => {
			outputs.push(msg);
		};

		const adapter = new StdioIpcAdapter(app, stream, mockOutput);
		await adapter.start();

		expect(outputs.length).toBe(2);

		const res1 = JSON.parse(outputs[0]);
		expect(res1.id).toBe("1");
		expect(res1.result.ok).toBe(true);

		const res2 = JSON.parse(outputs[1]);
		expect(res2.id).toBe("2");
		expect(res2.result.ok).toBe(true);
	});

	test("should handle malformed JSON", async () => {
		const app = new Hono();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("NOT JSON\n"));
				controller.close();
			},
		});

		const outputs: string[] = [];
		const adapter = new StdioIpcAdapter(app, stream, (msg) =>
			outputs.push(msg),
		);
		await adapter.start();

		expect(outputs.length).toBe(1);
		const err = JSON.parse(outputs[0]);
		expect(err.id).toBe("error");
		expect(err.status).toBe(500);
	});

	test("should handle empty lines", async () => {
		const app = new Hono();
		// Just newlines
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("\n\n\n"));
				controller.close();
			},
		});

		const outputs: string[] = [];
		const adapter = new StdioIpcAdapter(app, stream, (msg) =>
			outputs.push(msg),
		);
		await adapter.start();

		expect(outputs.length).toBe(0);
	});
});
