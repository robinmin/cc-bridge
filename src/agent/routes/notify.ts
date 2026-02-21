import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { ZodError } from "zod";
import { AGENT_CONSTANTS } from "@/agent/consts";
import { NotifySchema } from "@/agent/types";

const router = new Hono();

// Helper to transform Zod errors into consistent format
function transformZodError(error: unknown): { error: string } {
	if (error instanceof ZodError) {
		const issues = error.issues.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "root";
			return `${path}: ${issue.message}`;
		});
		return { error: `Missing required fields: ${issues.join(", ")}` };
	}
	if (error instanceof Error) {
		return { error: error.message };
	}
	return { error: "Unknown error" };
}

// Custom validator that throws properly formatted errors
async function validateNotifySchema(data: unknown) {
	return NotifySchema.parseAsync(data);
}

router.post("/", async (c) => {
	try {
		// Parse and validate JSON
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON in request body" }, 400);
		}

		// Validate schema
		const validated = await validateNotifySchema(body);
		const { type, chatId, text } = validated;

		const ipcMessagesDir = path.join(AGENT_CONSTANTS.EXECUTION.IPC_DIR, "messages");

		// Ensure directory exists (though host should have pre-created it)
		await fs.mkdir(ipcMessagesDir, { recursive: true });

		const filename = `msg_${Date.now()}_${Math.random().toString(36).substring(7)}.json`;
		const filePath = path.join(ipcMessagesDir, filename);

			await fs.writeFile(filePath, JSON.stringify({ type, chatId, text }), "utf-8");

			return c.json({ status: "ok", file: filename });
		} catch (error) {
			if (error instanceof ZodError) {
				const transformed = transformZodError(error);
				return c.json(transformed, 400);
			}
		console.error("[Agent Notify] Error writing to mailbox:", error);
		return c.json({ error: "Internal server error" }, 500);
	}
});

export default router;
