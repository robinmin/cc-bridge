import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { PersistenceManager } from "@/gateway/persistence";

describe("PersistenceManager", () => {
	const testDbPath = "data/test_gateway.db";
	const testDbNestedPath = "data/persistence/nested/test_gateway_nested.db";
	let persistence: PersistenceManager;
	let originalEnableCache: string | undefined;

	beforeEach(() => {
		originalEnableCache = process.env.ENABLE_LRU_HISTORY;
		process.env.ENABLE_LRU_HISTORY = "false";
		if (!fs.existsSync("data")) fs.mkdirSync("data");
		if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
		fs.rmSync("data/persistence", { recursive: true, force: true });
		persistence = new PersistenceManager(testDbPath);
	});

	afterEach(() => {
		persistence.close();
		if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
		fs.rmSync("data/persistence", { recursive: true, force: true });
		if (originalEnableCache === undefined) {
			delete process.env.ENABLE_LRU_HISTORY;
		} else {
			process.env.ENABLE_LRU_HISTORY = originalEnableCache;
		}
	});

	test("should store and retrieve message history", async () => {
		await persistence.storeMessage(123, "user", "Hello");
		await persistence.storeMessage(123, "agent", "Hi there!");
		await persistence.storeMessage(456, "user", "Separate chat");

		const history = await persistence.getHistory(123);
		expect(history.length).toBe(2);
		expect(history[0].text).toBe("Hi there!");
		expect(history[1].text).toBe("Hello");
	});

	test("should manage sticky sessions", async () => {
		await persistence.setSession(123, "agent-1");

		let session = await persistence.getSession(123);
		expect(session).toBe("agent-1");

		await persistence.setSession(123, "agent-2");
		session = await persistence.getSession(123);
		expect(session).toBe("agent-2");
	});

	test("should manage proactive tasks", async () => {
		// Use an ISO string that is definitely in the past UTC
		// SQLite datetime('now') is UTC
		const pastDate = new Date(Date.now() - 10000).toISOString().replace("T", " ").substring(0, 19);

		const task = {
			id: "task-1",
			instance_name: "agent-1",
			chat_id: "123",
			prompt: "Daily report",
			schedule_type: "cron",
			schedule_value: "0 9 * * *",
			next_run: pastDate,
			status: "active",
		};

		await persistence.saveTask(task);

		const activeTasks = (await persistence.getActiveTasks()) as Array<{
			id: string;
		}>;
		expect(activeTasks.length).toBe(1);
		expect(activeTasks[0].id).toBe("task-1");
	});

	test("should support sessions, workspaces, and chat channels", async () => {
		await persistence.setSession(111, "a");
		await persistence.setSession(222, "b");
		const sessions = await persistence.getAllSessions();
		expect(sessions.length).toBe(2);
		expect(sessions.some((s) => s.instance_name === "a")).toBe(true);

		expect(await persistence.getWorkspace("none")).toBe("cc-bridge");
		await persistence.setWorkspace(111, "ws-a");
		expect(await persistence.getWorkspace(111)).toBe("ws-a");

		expect(await persistence.getChatChannel(111)).toBeNull();
		await persistence.setChatChannel(111, "telegram");
		await persistence.setChatChannel(222, "feishu");
		expect(await persistence.getChatChannel(111)).toBe("telegram");
		const channels = await persistence.getAllChatChannels();
		expect(channels.length).toBe(2);
	});

	test("should manage mini app task lifecycle", async () => {
		const first = await persistence.upsertMiniAppTask({
			id: "mini-1",
			instance_name: "inst-a",
			app_id: "demo",
			prompt: "@miniapp:demo run",
			schedule_type: "cron",
			schedule_value: "*/5 * * * *",
			next_run: new Date().toISOString(),
		});
		expect(first.created).toBe(true);
		expect(first.duplicate_ids_deleted).toEqual([]);

		const second = await persistence.upsertMiniAppTask({
			id: "mini-2",
			instance_name: "inst-a",
			app_id: "demo",
			prompt: "@miniapp:demo run",
			schedule_type: "cron",
			schedule_value: "*/10 * * * *",
			next_run: new Date().toISOString(),
		});
		expect(second.created).toBe(true);
		expect(second.duplicate_ids_deleted).toEqual(["mini-1"]);

		const allMini = await persistence.getMiniAppTasks();
		expect(allMini.length).toBe(1);
		expect(allMini[0].id).toBe("mini-2");
		expect(allMini[0].app_id).toBe("demo");
		expect((await persistence.getMiniAppTasks("demo")).length).toBe(1);
		expect((await persistence.getMiniAppTasks("other")).length).toBe(0);

		expect(await persistence.unscheduleMiniAppTaskByTaskId("mini-2")).toBe(1);
		await persistence.upsertMiniAppTask({
			id: "mini-3",
			instance_name: "inst-a",
			app_id: "demo",
			prompt: "@miniapp:demo",
			schedule_type: "recurring",
			schedule_value: "1h",
			next_run: new Date().toISOString(),
		});
		expect(await persistence.unscheduleMiniAppTaskByAppId("demo")).toBe(1);
	});

	test("should manage generic tasks and hide deleted items", async () => {
		await persistence.saveTask({
			id: "task-a",
			instance_name: "inst",
			chat_id: "1",
			prompt: "prompt",
			schedule_type: "once",
			schedule_value: "now",
			next_run: new Date().toISOString(),
			status: "active",
		});
		await persistence.saveTask({
			id: "task-b",
			instance_name: "inst",
			chat_id: "1",
			prompt: "prompt-b",
			schedule_type: "once",
			schedule_value: "now",
			next_run: new Date().toISOString(),
			status: "active",
		});
		expect((await persistence.getAllTasks()).length).toBe(2);
		await persistence.deleteTask("task-b");
		const tasks = (await persistence.getAllTasks()) as Array<{ id: string }>;
		expect(tasks.length).toBe(1);
		expect(tasks[0].id).toBe("task-a");
	});

	test("should return empty tasks when query throws", async () => {
		const db = (persistence as unknown as { db: { query: (sql: string) => { all: () => unknown[] } } }).db;
		const originalQuery = db.query;
		db.query = (() => {
			throw new Error("query failed");
		}) as typeof db.query;
		expect(await persistence.getAllTasks()).toEqual([]);
		db.query = originalQuery;
	});

	test("should support message cache when enabled and invalidate on writes", async () => {
		persistence.close();
		process.env.ENABLE_LRU_HISTORY = "true";
		if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
		persistence = new PersistenceManager(testDbPath);

		await persistence.storeMessage("cache-chat", "user", "one", "cache-ws");
		const first = await persistence.getHistory("cache-chat", 10, "cache-ws");
		expect(first.length).toBe(1);
		const second = await persistence.getHistory("cache-chat", 10, "cache-ws");
		expect(second.length).toBe(1);
		expect(second[0].text).toBe("one");

		await persistence.storeMessage("cache-chat", "user", "two", "cache-ws");
		const third = await persistence.getHistory("cache-chat", 10, "cache-ws");
		expect(third[0].text).toBe("two");
		expect(third.length).toBe(2);
	});

	test("should create missing database directory", () => {
		expect(fs.existsSync(path.dirname(testDbNestedPath))).toBe(false);
		const nested = new PersistenceManager(testDbNestedPath);
		expect(fs.existsSync(path.dirname(testDbNestedPath))).toBe(true);
		nested.close();
		fs.rmSync(path.dirname(testDbNestedPath), { recursive: true, force: true });
	});
});
