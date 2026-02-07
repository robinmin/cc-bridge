import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { AGENT_CONSTANTS } from "@/agent/consts";

const router = new Hono();

router.post("/", async (c) => {
	try {
		const body = await c.req.json();
		const { type, chatId, text } = body;

		if (!type || !chatId || !text) {
			return c.json(
				{ error: "Missing required fields: type, chatId, text" },
				400,
			);
		}

		const ipcMessagesDir = path.join(
			AGENT_CONSTANTS.EXECUTION.IPC_DIR,
			"messages",
		);

		// Ensure directory exists (though host should have pre-created it)
		await fs.mkdir(ipcMessagesDir, { recursive: true });

		const filename = `msg_${Date.now()}_${Math.random().toString(36).substring(7)}.json`;
		const filePath = path.join(ipcMessagesDir, filename);

		await fs.writeFile(
			filePath,
			JSON.stringify({ type, chatId, text }),
			"utf-8",
		);

		return c.json({ status: "ok", file: filename });
	} catch (error) {
		console.error("[Agent Notify] Error writing to mailbox:", error);
		return c.json({ error: String(error) }, 500);
	}
});

export default router;
