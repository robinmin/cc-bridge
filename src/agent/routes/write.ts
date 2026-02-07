import { chmod } from "node:fs/promises";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-statusCodes";
import { AGENT_CONSTANTS } from "@/agent/consts";
import { WriteFileSchema } from "@/agent/types";
import { validatePath } from "@/agent/utils/path-utils";

const app = new Hono();

app.post("/", zValidator("json", WriteFileSchema), async (c) => {
	const { path, content, encoding, mode } = c.req.valid("json");

	try {
		// Validate path is within workspace to prevent directory traversal
		const safePath = validatePath(path);

		const file = Bun.file(safePath);

		let data: string | Uint8Array = content;
		if (encoding === AGENT_CONSTANTS.FILES.ENCODING_BASE64) {
			data = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
		}

		const bytesWritten = await Bun.write(file, data);

		if (mode !== undefined) {
			await chmod(safePath, mode);
		}

		return c.json({
			success: true,
			bytesWritten,
		});
	} catch (error) {
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : String(error),
				bytesWritten: 0,
			},
			AGENT_CONSTANTS.HTTP.INTERNAL_SERVER_ERROR as StatusCode,
		);
	}
});

export default app;
