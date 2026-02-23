import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Channel } from "@/gateway/channels";
import { instanceManager } from "@/gateway/instance-manager";
import type { Message } from "@/gateway/pipeline";

const TEST_PROJECTS_ROOT = path.resolve("test-data/menu-bot-workspaces");
const configLoadMock = mock(() => ({ projectsRoot: TEST_PROJECTS_ROOT }));
mock.module("@/packages/config", () => ({
	ConfigLoader: { load: configLoadMock },
}));
const { MenuBot } = await import("@/gateway/pipeline/menu-bot");

describe("MenuBot", () => {
	const mockChannel: Channel = {
		name: "test",
		sendMessage: async () => {},
	};
	const persistenceMock = {
		getSession: mock(async () => null),
		setSession: mock(async () => {}),
		setWorkspace: mock(async () => {}),
	};

	const spy = spyOn(mockChannel, "sendMessage");
	const refreshSpy = spyOn(instanceManager, "refresh");
	const foldersSpy = spyOn(instanceManager, "getWorkspaceFolders");
	const fetchMock = mock(async () => new Response("ok", { status: 200 }));
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spy.mockClear();
		persistenceMock.getSession.mockReset();
		persistenceMock.getSession.mockResolvedValue(null);
		persistenceMock.setSession.mockReset();
		persistenceMock.setWorkspace.mockReset();
		refreshSpy.mockReset();
		refreshSpy.mockResolvedValue([]);
		foldersSpy.mockReset();
		foldersSpy.mockResolvedValue([]);
		spawnSpy = spyOn(Bun, "spawn").mockImplementation(
			(() => ({ exited: Promise.resolve(0) })) as typeof Bun.spawn,
		);
		(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(new Response("OK", { status: 200 }));
		configLoadMock.mockReset();
		configLoadMock.mockReturnValue({ projectsRoot: TEST_PROJECTS_ROOT });

		if (!fs.existsSync("test-data")) {
			fs.mkdirSync("test-data", { recursive: true });
		}
		fs.rmSync(TEST_PROJECTS_ROOT, { recursive: true, force: true });
		fs.mkdirSync(TEST_PROJECTS_ROOT, { recursive: true });
	});

	afterEach(() => {
		spawnSpy?.mockRestore();
		fs.rmSync(TEST_PROJECTS_ROOT, { recursive: true, force: true });
	});

	test("should handle /start", async () => {
		const bot = new MenuBot(mockChannel, persistenceMock as never);
		const msg: Message = { channelId: "test", chatId: "123", text: "/start" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalled();
	});

	test("should not handle random text", async () => {
		const bot = new MenuBot(mockChannel, persistenceMock as never);
		const msg: Message = { channelId: "test", chatId: "123", text: "hello" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});

	test("should handle /help", async () => {
		const bot = new MenuBot(mockChannel, persistenceMock as never);
		const msg: Message = { channelId: "test", chatId: "123", text: "/help" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalled();
	});

	test("should handle /menu and include cross-bot commands", async () => {
		const bot = new MenuBot(mockChannel, persistenceMock as never);
		const msg: Message = { channelId: "test", chatId: "123", text: "/menu" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("Available Commands"));
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("/host_uptime"));
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("/agents"));
	});

	test("should expose menu helpers", () => {
		const bot = new MenuBot(mockChannel, persistenceMock as never);
		expect(bot.getMenus().length).toBeGreaterThan(0);
		expect(
			MenuBot.getAllMenus([
				{ getMenus: () => [{ command: "a", description: "A" }], handle: async () => false, name: "a" },
				{ getMenus: () => [{ command: "b", description: "B" }], handle: async () => false, name: "b" },
			]),
		).toEqual([
			{ command: "a", description: "A" },
			{ command: "b", description: "B" },
		]);
	});

	test("should handle /status success and failure", async () => {
		const bot = new MenuBot(mockChannel, persistenceMock as never);
		const msg: Message = { channelId: "test", chatId: "123", text: "/status" };

		let handled = await bot.handle(msg);
		expect(handled).toBe(true);
		expect(fetchMock).toHaveBeenCalled();
		expect(spy).toHaveBeenCalledWith("123", "OK");

		fetchMock.mockResolvedValueOnce(new Response("bad", { status: 500 }));
		handled = await bot.handle(msg);
		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalledWith("123", "❌ Failed to fetch detailed system status.");
	});

	test("should handle /ws_status and /ws_list variants", async () => {
		const bot = new MenuBot(mockChannel, persistenceMock as never);
		persistenceMock.getSession.mockResolvedValueOnce("alpha").mockResolvedValueOnce("alpha");
		refreshSpy
			.mockResolvedValueOnce([{ name: "alpha", containerId: "1", status: "running", image: "img" }])
			.mockResolvedValueOnce([{ name: "alpha", containerId: "1", status: "running", image: "img" }]);
		foldersSpy.mockResolvedValueOnce(["alpha", "beta"]);

		const statusMsg: Message = { channelId: "test", chatId: "123", text: "/ws_status" };
		const listMsg: Message = { channelId: "test", chatId: "123", text: "/ws_list" };
		const emptyListMsg: Message = { channelId: "test", chatId: "123", text: "/list" };

		expect(await bot.handle(statusMsg)).toBe(true);
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("Current Workspace"));

		expect(await bot.handle(listMsg)).toBe(true);
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("Workspace"));

		foldersSpy.mockResolvedValueOnce([]);
		expect(await bot.handle(emptyListMsg)).toBe(true);
		expect(spy).toHaveBeenCalledWith("123", "⚠️ No workspaces found in root folder.");
	});

	test("should handle /ws_switch validation and switching", async () => {
		const bot = new MenuBot(mockChannel, persistenceMock as never);
		const chatId = "123";
		expect(await bot.handle({ channelId: "test", chatId, text: "/ws_switch" })).toBe(true);
		expect(spy).toHaveBeenCalledWith(
			chatId,
			"❓ Please specify a workspace name.\nExample: `/ws_switch cc-bridge`.",
		);

		refreshSpy.mockResolvedValueOnce([{ name: "alpha", containerId: "1", status: "running", image: "img" }]);
		expect(await bot.handle({ channelId: "test", chatId, text: "/ws_switch beta" })).toBe(true);
		expect(spy).toHaveBeenCalledWith(chatId, "❌ Workspace `beta` not found.");

		refreshSpy.mockResolvedValueOnce([{ name: "Alpha", containerId: "1", status: "running", image: "img" }]);
		expect(await bot.handle({ channelId: "test", chatId, text: "/ws_switch alpha" })).toBe(true);
		expect(persistenceMock.setSession).toHaveBeenCalledWith(chatId, "Alpha");
		expect(spy).toHaveBeenCalledWith(chatId, "✅ Switched to workspace: **Alpha**");
	});

	test("should handle /ws_add validation and success path", async () => {
		const bot = new MenuBot(mockChannel, persistenceMock as never);
		const chatId = "123";
		const originalMkdirSync = fs.mkdirSync;
		const mkdirSyncSpy = spyOn(fs, "mkdirSync").mockImplementation(
			(targetPath: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }) => {
				const normalized = String(targetPath);
				if (normalized.endsWith(`${path.sep}sample_project`)) {
					return undefined;
				}
				return originalMkdirSync(targetPath, options);
			},
		);

		expect(await bot.handle({ channelId: "test", chatId, text: "/ws_add" })).toBe(true);
		expect(spy).toHaveBeenCalledWith(
			chatId,
			"❓ Please specify a workspace name.\nExample: `/ws_add my-project`.",
		);

		expect(await bot.handle({ channelId: "test", chatId, text: "/ws_add bad$name" })).toBe(true);
		expect(spy).toHaveBeenCalledWith(chatId, expect.stringContaining("Invalid workspace name"));

		expect(await bot.handle({ channelId: "test", chatId, text: "/ws_add sample_project" })).toBe(true);
		expect(persistenceMock.setWorkspace).toHaveBeenCalledWith(chatId, "sample_project");
		expect(spawnSpy).toHaveBeenCalledTimes(4);
		expect(spy).toHaveBeenCalledWith(chatId, expect.stringContaining("created successfully"));
		mkdirSyncSpy.mockRestore();
	});

	test("should report workspace exists in handleWorkspaceAdd", async () => {
		const bot = new MenuBot(mockChannel, persistenceMock as never);
		const chatId = "123";
		const existingPath = path.join(TEST_PROJECTS_ROOT, "existing");
		fs.mkdirSync(existingPath, { recursive: true });

		await bot.handleWorkspaceAdd({ channelId: "test", chatId, text: "" }, "existing");
		expect(spy).toHaveBeenCalledWith(chatId, expect.stringContaining("already exists"));
	});

	test("should handle /ws_add errors and unknown command", async () => {
		const bot = new MenuBot(mockChannel, persistenceMock as never);
		const handleWorkspaceAddSpy = spyOn(bot, "handleWorkspaceAdd").mockRejectedValueOnce(new Error("boom"));

		expect(await bot.handle({ channelId: "test", chatId: "123", text: "/ws_add x" })).toBe(true);
		expect(spy).toHaveBeenCalledWith("123", "❌ Failed to create workspace. Please try again.");

		expect(await bot.handle({ channelId: "test", chatId: "123", text: "/unknown" })).toBe(false);
		handleWorkspaceAddSpy.mockRestore();
	});
});
