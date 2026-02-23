import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as broadcast from "@/gateway/services/broadcast";
import * as claudeExecutor from "@/gateway/services/claude-executor";
import { FeishuChannel } from "@/gateway/channels/feishu";
import { TelegramChannel } from "@/gateway/channels/telegram";
import { MiniAppDriver, miniAppDriver, runCli } from "@/gateway/apps/driver";
import { instanceManager } from "@/gateway/instance-manager";
import { persistence } from "@/gateway/persistence";
import { ConfigLoader } from "@/packages/config";

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

describe("MiniAppDriver runApp coverage", () => {
	let appsDir: string;

	beforeEach(async () => {
		appsDir = await mkdtemp(path.join(tmpdir(), "miniapp-run-test-"));
	});

	afterEach(async () => {
		await rm(appsDir, { recursive: true, force: true });
		mock.restore();
		delete process.env.TELEGRAM_BOT_TOKEN;
		delete process.env.MINI_APP_EXEC_TIMEOUT_MS;
	});

	test("should skip invalid markdowns when listing apps", async () => {
		await writeFile(
			path.join(appsDir, "valid.md"),
			`---
id: valid
enabled: true
target_mode: all_sessions
---
Prompt body`,
			"utf-8",
		);
		await writeFile(
			path.join(appsDir, "invalid.md"),
			`---
enabled: true
---
Prompt body`,
			"utf-8",
		);

		const tempDriver = new MiniAppDriver(appsDir);
		const apps = await tempDriver.listApps();
		expect(apps.map((app) => app.id)).toEqual(["valid"]);
	});

	test("should reject disabled mini-app", async () => {
		await writeFile(
			path.join(appsDir, "disabled.md"),
			`---
id: disabled
enabled: false
target_mode: all_sessions
---
Prompt body`,
			"utf-8",
		);
		const tempDriver = new MiniAppDriver(appsDir);
		await expect(tempDriver.runApp("disabled")).rejects.toThrow(/disabled/i);
	});

	test("should reject when no targets resolve", async () => {
		await writeFile(
			path.join(appsDir, "no-targets.md"),
			`---
id: no-targets
enabled: true
target_mode: all_sessions
instance: inst-a
---
Prompt body`,
			"utf-8",
		);
		spyOn(broadcast, "resolveBroadcastTargets").mockResolvedValue([]);
		const tempDriver = new MiniAppDriver(appsDir);
		await expect(tempDriver.runApp("no-targets")).rejects.toThrow(/no resolved targets/i);
	});

	test("should return skipped when no running execution target exists", async () => {
		await writeFile(
			path.join(appsDir, "skip.md"),
			`---
id: skip
enabled: true
target_mode: all_sessions
instance: fallback-inst
---
Prompt body`,
			"utf-8",
		);
		spyOn(broadcast, "resolveBroadcastTargets").mockResolvedValue([
			{ chatId: "1001", channel: "telegram", instanceName: "down-inst", workspace: "ws1" },
		]);
		spyOn(instanceManager, "refresh").mockResolvedValue([]);
		spyOn(instanceManager, "getInstance").mockReturnValue(undefined);

		const tempDriver = new MiniAppDriver(appsDir);
		const result = await tempDriver.runApp("skip");
		expect(result).toEqual({
			appId: "skip",
			totalTargets: 1,
			dispatched: 0,
			succeeded: 0,
			failed: 0,
			skipped: 1,
			queued: 0,
		});
	});

	test("should dispatch telegram output and fallback to plain text when markdown send fails", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		await writeFile(
			path.join(appsDir, "ok.md"),
			`---
id: ok
enabled: true
target_mode: all_sessions
instance: inst-a
workspace: ws-a
channels: [telegram]
---
Prompt body {{input}}`,
			"utf-8",
		);

		spyOn(ConfigLoader, "load").mockReturnValue({
			...({} as Record<string, unknown>),
			feishu: { appId: "", appSecret: "", domain: "feishu", encryptKey: "" },
		});
		spyOn(broadcast, "resolveBroadcastTargets").mockResolvedValue([
			{ chatId: "1001", channel: "telegram", instanceName: "inst-a", workspace: "ws-a" },
		]);
		spyOn(instanceManager, "refresh").mockResolvedValue([]);
		spyOn(instanceManager, "getInstance").mockReturnValue({
			name: "inst-a",
			containerId: "cid-1",
			status: "running",
			image: "img",
		});
		spyOn(claudeExecutor, "executeClaudeRaw").mockResolvedValue({
			success: true,
			output: "hello from app",
		});
		const tgSend = spyOn(TelegramChannel.prototype, "sendMessage")
			.mockRejectedValueOnce(new Error("bad markdown"))
			.mockResolvedValue(undefined);
		const storeMessage = spyOn(persistence, "storeMessage").mockResolvedValue(undefined as never);

		const tempDriver = new MiniAppDriver(appsDir);
		const result = await tempDriver.runApp("ok", { input: "world" });
		expect(result.succeeded).toBe(1);
		expect(result.failed).toBe(0);
		expect(tgSend).toHaveBeenCalledTimes(2);
		expect(storeMessage).toHaveBeenCalledTimes(1);
	});

	test("should use fallback app.instance when target instance is unavailable", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		await writeFile(
			path.join(appsDir, "fallback.md"),
			`---
id: fallback
enabled: true
target_mode: all_sessions
instance: app-inst
workspace: ws-a
channels: [telegram]
---
Prompt body`,
			"utf-8",
		);

		spyOn(ConfigLoader, "load").mockReturnValue({
			...({} as Record<string, unknown>),
			feishu: { appId: "", appSecret: "", domain: "feishu", encryptKey: "" },
		});
		spyOn(broadcast, "resolveBroadcastTargets").mockResolvedValue([
			{ chatId: "1001", channel: "telegram", instanceName: "target-inst", workspace: "ws-a" },
		]);
		spyOn(instanceManager, "refresh").mockResolvedValue([]);
		let targetCallCount = 0;
		spyOn(instanceManager, "getInstance").mockImplementation((name: string) => {
			if (name === "target-inst") {
				targetCallCount++;
				if (targetCallCount === 1) {
					return { name, containerId: "cid-target", status: "running", image: "img" };
				}
				return { name, containerId: "cid-target", status: "stopped", image: "img" };
			}
			if (name === "app-inst") return { name, containerId: "cid-app", status: "running", image: "img" };
			return undefined;
		});
		const execSpy = spyOn(claudeExecutor, "executeClaudeRaw").mockResolvedValue({
			success: true,
			output: "ok",
		});
		spyOn(TelegramChannel.prototype, "sendMessage").mockResolvedValue(undefined);
		spyOn(persistence, "storeMessage").mockResolvedValue(undefined as never);

		const tempDriver = new MiniAppDriver(appsDir);
		const result = await tempDriver.runApp("fallback");
		expect(result.succeeded).toBe(1);
		expect(execSpy.mock.calls[0]?.[1]).toBe("app-inst");
	});

	test("should fail when generation fails", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		await writeFile(
			path.join(appsDir, "gen-fail.md"),
			`---
id: gen-fail
enabled: true
target_mode: all_sessions
instance: inst-a
channels: [telegram]
---
Prompt body`,
			"utf-8",
		);
		spyOn(ConfigLoader, "load").mockReturnValue({
			...({} as Record<string, unknown>),
			feishu: { appId: "", appSecret: "", domain: "feishu", encryptKey: "" },
		});
		spyOn(broadcast, "resolveBroadcastTargets").mockResolvedValue([
			{ chatId: "1001", channel: "telegram", instanceName: "inst-a", workspace: "ws-a" },
		]);
		spyOn(instanceManager, "refresh").mockResolvedValue([]);
		spyOn(instanceManager, "getInstance").mockReturnValue({
			name: "inst-a",
			containerId: "cid-1",
			status: "running",
			image: "img",
		});
		spyOn(claudeExecutor, "executeClaudeRaw").mockResolvedValue({
			success: false,
			error: "generation failed",
		});

		const tempDriver = new MiniAppDriver(appsDir);
		await expect(tempDriver.runApp("gen-fail")).rejects.toThrow(/generation failed/i);
	});

	test("should retry daily-news generation when first output fails validation", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		await writeFile(
			path.join(appsDir, "daily-news.md"),
			`---
id: daily-news
enabled: true
target_mode: all_sessions
instance: inst-a
channels: [telegram]
---
Prompt body`,
			"utf-8",
		);
		spyOn(ConfigLoader, "load").mockReturnValue({
			...({} as Record<string, unknown>),
			feishu: { appId: "", appSecret: "", domain: "feishu", encryptKey: "" },
		});
		spyOn(broadcast, "resolveBroadcastTargets").mockResolvedValue([
			{ chatId: "1001", channel: "telegram", instanceName: "inst-a", workspace: "ws-a" },
		]);
		spyOn(instanceManager, "refresh").mockResolvedValue([]);
		spyOn(instanceManager, "getInstance").mockReturnValue({
			name: "inst-a",
			containerId: "cid-1",
			status: "running",
			image: "img",
		});
		const execSpy = spyOn(claudeExecutor, "executeClaudeRaw")
			.mockResolvedValueOnce({
				success: true,
				output: "Story without source line",
			})
			.mockResolvedValueOnce({
				success: true,
				output: "世界新闻\n来源：[Reuters](https://example.com/story)",
			});
		spyOn(TelegramChannel.prototype, "sendMessage").mockResolvedValue(undefined);
		spyOn(persistence, "storeMessage").mockResolvedValue(undefined as never);

		const tempDriver = new MiniAppDriver(appsDir);
		const result = await tempDriver.runApp("daily-news");
		expect(result.succeeded).toBe(1);
		expect(execSpy).toHaveBeenCalledTimes(2);
	});

	test("should fail daily-news when retry output is still invalid", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		await writeFile(
			path.join(appsDir, "daily-news-bad.md"),
			`---
id: daily-news
enabled: true
target_mode: all_sessions
instance: inst-a
channels: [telegram]
---
Prompt body`,
			"utf-8",
		);
		spyOn(ConfigLoader, "load").mockReturnValue({
			...({} as Record<string, unknown>),
			feishu: { appId: "", appSecret: "", domain: "feishu", encryptKey: "" },
		});
		spyOn(broadcast, "resolveBroadcastTargets").mockResolvedValue([
			{ chatId: "1001", channel: "telegram", instanceName: "inst-a", workspace: "ws-a" },
		]);
		spyOn(instanceManager, "refresh").mockResolvedValue([]);
		spyOn(instanceManager, "getInstance").mockReturnValue({
			name: "inst-a",
			containerId: "cid-1",
			status: "running",
			image: "img",
		});
		spyOn(claudeExecutor, "executeClaudeRaw")
			.mockResolvedValueOnce({ success: true, output: "first output without source" })
			.mockResolvedValueOnce({ success: true, output: "still invalid without source links" });

		const tempDriver = new MiniAppDriver(appsDir);
		await expect(tempDriver.runApp("daily-news-bad")).rejects.toThrow(/invalid output/i);
	});

	test("should resolve chat_ids targets and dispatch to feishu", async () => {
		delete process.env.TELEGRAM_BOT_TOKEN;
		await writeFile(
			path.join(appsDir, "chat-ids.md"),
			`---
id: chat-ids
enabled: true
target_mode: chat_ids
chat_ids: [oc_chat_a]
instance: inst-a
channels: [feishu]
---
Prompt body`,
			"utf-8",
		);
		spyOn(ConfigLoader, "load").mockReturnValue({
			...({} as Record<string, unknown>),
			feishu: { appId: "app-id", appSecret: "secret", domain: "feishu", encryptKey: "" },
		});
		spyOn(persistence, "getChatChannel").mockResolvedValue("feishu" as never);
		spyOn(persistence, "getSession").mockResolvedValue("inst-a");
		spyOn(persistence, "getWorkspace").mockResolvedValue("ws-feishu");
		spyOn(instanceManager, "refresh").mockResolvedValue([]);
		spyOn(instanceManager, "getInstance").mockReturnValue({
			name: "inst-a",
			containerId: "cid-1",
			status: "running",
			image: "img",
		});
		spyOn(claudeExecutor, "executeClaudeRaw").mockResolvedValue({
			success: true,
			output: "feishu ok",
		});
		const feishuSend = spyOn(FeishuChannel.prototype, "sendMessage").mockResolvedValue(undefined);
		spyOn(persistence, "storeMessage").mockResolvedValue(undefined as never);

		const tempDriver = new MiniAppDriver(appsDir);
		const result = await tempDriver.runApp("chat-ids");
		expect(result.succeeded).toBe(1);
		expect(feishuSend).toHaveBeenCalledTimes(1);
	});
});

describe("MiniAppDriver runCli", () => {
	afterEach(() => {
		mock.restore();
		delete process.env.MINI_APP_CHAT_ID;
		delete process.env.MINI_APP_TIMEOUT_MS;
		delete process.env.MINI_APP_CONCURRENCY;
	});

	test("lists apps from cli", async () => {
		spyOn(miniAppDriver, "listApps").mockResolvedValue([
			{
				id: "a1",
				name: "App One",
				enabled: true,
				targetMode: "all_sessions",
				chatIds: [],
				channels: ["telegram"],
				templateVars: [],
				body: "x",
			},
		] as never);
		const outSpy = spyOn(process.stdout, "write").mockReturnValue(true as never);
		await runCli(["list"]);
		expect(outSpy.mock.calls.map((call) => String(call[0])).join("")).toContain("a1\tApp One\tall_sessions");
	});

	test("runs app from cli with parsed env options", async () => {
		process.env.MINI_APP_CHAT_ID = "123, 456";
		process.env.MINI_APP_TIMEOUT_MS = "45000";
		process.env.MINI_APP_CONCURRENCY = "2";
		const runSpy = spyOn(miniAppDriver, "runApp").mockResolvedValue({
			appId: "daily-news",
			totalTargets: 2,
			dispatched: 2,
			succeeded: 2,
			failed: 0,
			skipped: 0,
			queued: 0,
		});
		const outSpy = spyOn(process.stdout, "write").mockReturnValue(true as never);

		await runCli(["run", "daily-news", "focus", "ai"]);
		expect(runSpy).toHaveBeenCalledWith("daily-news", {
			input: "focus ai",
			targetChatIds: ["123", "456"],
			timeoutMs: 45000,
			concurrency: 2,
		});
		expect(outSpy.mock.calls.length).toBeGreaterThan(0);
	});

	test("prints task prompt from cli", async () => {
		const outSpy = spyOn(process.stdout, "write").mockReturnValue(true as never);
		await runCli(["task-prompt", "daily-news", "hello"]);
		expect(String(outSpy.mock.calls[0]?.[0]).trim()).toBe("@miniapp:daily-news hello");
	});

	test("prints usage when command is unknown", async () => {
		const outSpy = spyOn(process.stdout, "write").mockReturnValue(true as never);
		await runCli(["unknown"]);
		expect(String(outSpy.mock.calls[0]?.[0])).toContain("Usage:");
	});

	test("throws usage error when run/task-prompt app-id is missing", async () => {
		await expect(runCli(["run"])).rejects.toThrow(/run <app-id>/i);
		await expect(runCli(["task-prompt"])).rejects.toThrow(/task-prompt <app-id>/i);
	});
});
