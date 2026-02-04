import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { ListDirSchema } from "@/agent/types";
import { AGENT_CONSTANTS } from "@/agent/consts";

const app = new Hono();

app.post("/list", zValidator("json", ListDirSchema), async (c) => {
	const { path } = c.req.valid("json");

	try {
		const entries = await readdir(path, { withFileTypes: true });

		const result = await Promise.all(
			entries.map(async (entry) => {
				const fullPath = join(path, entry.name);
				try {
					const s = await stat(fullPath);
					return {
						name: entry.name,
						isDirectory: entry.isDirectory(),
						size: s.size,
						updatedAt: s.mtime.toISOString(),
					};
				} catch (_e) {
					// Handle race condition where file might be deleted
					return null;
				}
			}),
		);

		return c.json({
			entries: result.filter(Boolean),
		});
	} catch (error) {
		return c.json(
			{
				error: error instanceof Error ? error.message : String(error),
				entries: [],
			},
			AGENT_CONSTANTS.HTTP.INTERNAL_SERVER_ERROR as any,
		);
	}
});

export default app;
