import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { handleHealth } from "@/gateway/routes/health";

describe("Health Route", () => {
	test.skip("should return rich diagnostic JSON", async () => {
		// Skipped due to external API calls that may timeout
		// This test validates the complete health check response structure
		// For faster unit testing, consider mocking the external dependencies
		const app = new Hono();
		app.get("/health", handleHealth);

		const res = await app.request("/health");
		expect(res.status).toBe(200);

		const data = (await res.json()) as unknown as {
			status?: string;
			runtime?: string;
			time?: string;
		};
		expect(data.status).toBeDefined();
		expect(data.runtime).toBe("bun");
		expect(data.diagnostics).toBeUndefined(); // It's spread out in the response
		expect(data.time).toBeDefined();
		expect(data.env).toBeDefined();
		expect(data.connectivity).toBeDefined();
		expect(data.daemons).toBeDefined();
		expect(data.instances).toBeDefined();
		expect(data.filesystem).toBeDefined();
		expect(data.mailbox_stats).toBeDefined();

		// Check specifics if we can expect certain envs in test env
		expect(typeof data.env.TELEGRAM_BOT_TOKEN).toBe("boolean");
		expect(typeof data.connectivity.telegram).toBe("boolean");
		expect(data.filesystem.mailbox_root).toBeDefined();
	});
});
