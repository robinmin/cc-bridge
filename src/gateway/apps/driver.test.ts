import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MiniAppDriver } from "@/gateway/apps/driver";

describe("MiniAppDriver", () => {
	const driver = new MiniAppDriver();

	test("should load markdown mini-app definition", async () => {
		const app = await driver.loadApp("daily-news");
		expect(app.id).toBe("daily-news");
		expect(app.enabled).toBe(true);
		expect(app.targetMode).toBe("all_sessions");
		expect(app.body.length).toBeGreaterThan(0);
	});

	test("should create and parse mini-app task token", () => {
		const token = driver.createTaskPrompt("daily-news", "focus on AI regulation");
		expect(driver.isMiniAppTaskPrompt(token)).toBe(true);
		expect(driver.parseTaskPrompt(token)).toEqual({
			appId: "daily-news",
			input: "focus on AI regulation",
		});
	});

	test("should reject mini-app without required id frontmatter", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "miniapp-test-"));
		try {
			await writeFile(
				path.join(dir, "invalid.md"),
				`---
name: Invalid
---
# Prompt
Hello`,
				"utf-8",
			);
			const tempDriver = new MiniAppDriver(dir);
			await expect(tempDriver.loadApp("invalid")).rejects.toThrow(/missing required frontmatter fields: id/i);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("should reject chat_ids target_mode without chat_ids", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "miniapp-test-"));
		try {
			await writeFile(
				path.join(dir, "invalid-chatids.md"),
				`---
id: invalid-chatids
target_mode: chat_ids
---
# Prompt
Hello`,
				"utf-8",
			);
			const tempDriver = new MiniAppDriver(dir);
			await expect(tempDriver.loadApp("invalid-chatids")).rejects.toThrow(/requires non-empty "chat_ids"/i);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
