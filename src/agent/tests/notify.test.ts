import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { Hono } from "hono";
import { ZodError } from "zod";
import { AGENT_CONSTANTS } from "@/agent/consts";
import notify, { transformNotifyError } from "@/agent/routes/notify";

describe("Notify Route", () => {
	const app = new Hono();
	app.route("/notify", notify);

	const ipcDir = AGENT_CONSTANTS.EXECUTION.IPC_DIR;

	beforeEach(async () => {
		// Ensure IPC directory exists
		await fs.mkdir(ipcDir, { recursive: true });
	});

	afterEach(async () => {
		// Clean up message files
		const messagesDir = `${ipcDir}/messages`;
		try {
			const files = await fs.readdir(messagesDir);
			for (const file of files) {
				if (file.startsWith("msg_")) {
					await fs.unlink(`${messagesDir}/${file}`);
				}
			}
		} catch {
			// Directory doesn't exist, ignore
		}
	});

	describe("POST /notify", () => {
		test("should accept valid notification payload", async () => {
			const res = await app.request("/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: "info",
					chatId: "123",
					text: "Test notification",
				}),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as { status: string; file?: string };
			expect(data.status).toBe("ok");
			expect(data.file).toBeDefined();
			expect(data.file).toMatch(/^msg_\d+_[a-z0-9]+\.json$/);
		});

		test("should return 400 for missing type field", async () => {
			const res = await app.request("/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chatId: "123",
					text: "Test notification",
				}),
			});

			expect(res.status).toBe(400);
			const data = (await res.json()) as { error?: string };
			expect(data.error).toContain("Missing required fields");
		});

		test("should return 400 for missing chatId field", async () => {
			const res = await app.request("/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: "info",
					text: "Test notification",
				}),
			});

			expect(res.status).toBe(400);
			const data = (await res.json()) as { error?: string };
			expect(data.error).toContain("Missing required fields");
		});

		test("should return 400 for missing text field", async () => {
			const res = await app.request("/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: "info",
					chatId: "123",
				}),
			});

			expect(res.status).toBe(400);
			const data = (await res.json()) as { error?: string };
			expect(data.error).toContain("Missing required fields");
		});

		test("should return 400 for empty payload", async () => {
			const res = await app.request("/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});

			expect(res.status).toBe(400);
			const data = (await res.json()) as { error?: string };
			expect(data.error).toContain("Missing required fields");
		});

		test("should write message file to correct location", async () => {
			const res = await app.request("/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: "warning",
					chatId: "456",
					text: "Warning message",
				}),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as { status: string; file?: string };

			// Verify file was created
			const filePath = `${ipcDir}/messages/${data.file}`;
			const exists = await fs
				.access(filePath)
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(true);
		});

		test("should handle special characters in text", async () => {
			const res = await app.request("/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: "info",
					chatId: "789",
					text: "Message with émojis 🎉 and spëcial çharacters",
				}),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as { status: string; file?: string };
			expect(data.status).toBe("ok");
		});

		test("should handle very long text", async () => {
			const longText = "x".repeat(10000);
			const res = await app.request("/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: "info",
					chatId: "999",
					text: longText,
				}),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as { status: string; file?: string };
			expect(data.status).toBe("ok");
		});

		test("should return 400 for invalid JSON", async () => {
			const res = await app.request("/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "invalid json{{{",
			});

			expect(res.status).toBe(400);
			const data = (await res.json()) as { error?: string };
			expect(data.error).toContain("Invalid JSON");
		});

		test("should return 500 when mailbox write fails", async () => {
			const originalWriteFile = fs.writeFile;
			(fs as unknown as { writeFile: typeof fs.writeFile }).writeFile = (async () => {
				throw new Error("disk full");
			}) as typeof fs.writeFile;

			try {
				const res = await app.request("/notify", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						type: "info",
						chatId: "111",
						text: "Test notification",
					}),
				});

				expect(res.status).toBe(500);
				const data = (await res.json()) as { error?: string };
				expect(data.error).toBe("Internal server error");
			} finally {
				(fs as unknown as { writeFile: typeof fs.writeFile }).writeFile = originalWriteFile;
			}
		});
	});

	describe("transformNotifyError", () => {
		test("should convert generic Error", () => {
			expect(transformNotifyError(new Error("boom"))).toEqual({ error: "boom" });
		});

		test("should convert unknown values", () => {
			expect(transformNotifyError("boom")).toEqual({ error: "Unknown error" });
		});

		test("should format zod issues", () => {
			const zodErr = new ZodError([
				{
					code: "custom",
					path: [],
					message: "invalid payload",
				},
			]);
			expect(transformNotifyError(zodErr).error).toContain("root: invalid payload");
		});
	});
});
