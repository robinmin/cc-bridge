import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { ReadFileSchema } from "@/agent/types";
import { AGENT_CONSTANTS } from "@/agent/consts";

const app = new Hono();

app.post("/", zValidator("json", ReadFileSchema), async (c) => {
	const { path, encoding } = c.req.valid("json");

	try {
		const file = Bun.file(path);
		const exists = await file.exists();

		if (!exists) {
			return c.json({
				content: "",
				exists: false,
			});
		}

		let content: string;
		if (encoding === AGENT_CONSTANTS.FILES.ENCODING_BASE64) {
			const buffer = await file.arrayBuffer();
			content = Buffer.from(buffer).toString("base64");
		} else {
			content = await file.text();
		}

		return c.json({
			content,
			exists: true,
		});
	} catch (error) {
		return c.json(
			{
				error: error instanceof Error ? error.message : String(error),
				exists: false,
			},
			AGENT_CONSTANTS.HTTP.INTERNAL_SERVER_ERROR as any,
		);
	}
});

export default app;
