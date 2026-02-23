import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { miniAppDriver } from "@/gateway/apps/driver";
import { IpcFactory } from "@/packages/ipc";
import { TaskScheduler } from "@/gateway/task-scheduler";

type Task = {
	id: string;
	instance_name: string;
	chat_id: string;
	prompt: string;
	schedule_type: "once" | "recurring" | "cron";
	schedule_value: string;
	next_run: string;
	status: "active" | "completed";
};

describe("TaskScheduler coverage", () => {
	const tmpRoot = `/tmp/task-scheduler-test-${Date.now()}`;

	beforeEach(async () => {
		await fs.mkdir(tmpRoot, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tmpRoot, { recursive: true, force: true });
	});

	test("covers checkTasks empty and error branches", async () => {
		const schedulerEmpty = new TaskScheduler(
			{
				getActiveTasks: async () => [],
				saveTask: async () => {},
			} as never,
			{ getInstance: () => null } as never,
		);
		await schedulerEmpty.checkTasks();

		const schedulerError = new TaskScheduler(
			{
				getActiveTasks: async () => {
					throw new Error("boom");
				},
				saveTask: async () => {},
			} as never,
			{ getInstance: () => null } as never,
		);
		await schedulerError.checkTasks();
	});

	test("covers runTick skip and cleanup guard branches", async () => {
		const scheduler = new TaskScheduler(
			{
				getActiveTasks: async () => [],
				saveTask: async () => {},
			} as never,
			{ getInstance: () => null } as never,
		) as unknown as {
			tickInProgress: boolean;
			runTick: () => Promise<void>;
			uploadsConfig?: {
				enabled: boolean;
				allowedMimeTypes: string[];
				maxTextBytes: number;
				maxImageBytes: number;
				retentionHours: number;
				storageDir: string;
			};
			cleanupUploads: () => Promise<void>;
		};

		scheduler.tickInProgress = true;
		await scheduler.runTick();

		scheduler.uploadsConfig = undefined;
		await scheduler.cleanupUploads();
		scheduler.uploadsConfig = {
			enabled: false,
			allowedMimeTypes: [],
			maxTextBytes: 1,
			maxImageBytes: 1,
			retentionHours: 1,
			storageDir: "",
		};
		await scheduler.cleanupUploads();
	});

	test("covers cleanupDir recursion and deletion", async () => {
		const storageDir = path.join(tmpRoot, "uploads");
		const nested = path.join(storageDir, "a/b");
		await fs.mkdir(nested, { recursive: true });
		const oldFile = path.join(nested, "old.txt");
		const keepFile = path.join(storageDir, "new.txt");
		await fs.writeFile(oldFile, "old");
		await fs.writeFile(keepFile, "new");
		const oldTime = new Date(Date.now() - 5 * 60 * 60 * 1000);
		await fs.utimes(oldFile, oldTime, oldTime);

		const scheduler = new TaskScheduler(
			{
				getActiveTasks: async () => [],
				saveTask: async () => {},
			} as never,
			{ getInstance: () => null } as never,
		) as unknown as {
			uploadsConfig: {
				enabled: boolean;
				allowedMimeTypes: string[];
				maxTextBytes: number;
				maxImageBytes: number;
				retentionHours: number;
				storageDir: string;
			};
			cleanupUploads: () => Promise<void>;
		};

		scheduler.uploadsConfig = {
			enabled: true,
			allowedMimeTypes: [],
			maxTextBytes: 1,
			maxImageBytes: 1,
			retentionHours: 1,
			storageDir,
		};
		await scheduler.cleanupUploads();

		await expect(fs.stat(oldFile)).rejects.toThrow();
		expect(await fs.readFile(keepFile, "utf8")).toBe("new");
	});

	test("covers executeTask mini-app branches", async () => {
		const saveTask = mock(async (_task: unknown) => {});
		const scheduler = new TaskScheduler(
			{
				getActiveTasks: async () => [],
				saveTask,
			} as never,
			{ getInstance: () => null } as never,
		) as unknown as {
			executeTask: (task: Task) => Promise<void>;
		};

		const miniSpy = spyOn(miniAppDriver, "isMiniAppTaskPrompt").mockReturnValue(true);
		const parseSpy = spyOn(miniAppDriver, "parseTaskPrompt").mockReturnValue(null);
		await scheduler.executeTask({
			id: "t1",
			instance_name: "i1",
			chat_id: "c1",
			prompt: "mini",
			schedule_type: "once",
			schedule_value: "1m",
			next_run: "2026-01-01 00:00:00",
			status: "active",
		});
		expect(saveTask).toHaveBeenCalled();

		parseSpy.mockReturnValue({ appId: "daily-news", input: "go" });
		const runSpy = spyOn(miniAppDriver, "runApp").mockResolvedValue({
			app: "daily-news",
			status: "queued",
			queued: 1,
			sent: 0,
			failed: 0,
			skipped: 0,
		});
		await scheduler.executeTask({
			id: "t2",
			instance_name: "i1",
			chat_id: "c1",
			prompt: "mini",
			schedule_type: "recurring",
			schedule_value: "1m",
			next_run: "2026-01-01 00:00:00",
			status: "active",
		});
		expect(runSpy).toHaveBeenCalled();

		runSpy.mockRestore();
		parseSpy.mockRestore();
		miniSpy.mockRestore();
	});

	test("covers executeTask non-mini branches and error path", async () => {
		const saveTask = mock(async (_task: unknown) => {});
		const getInstance = mock(() => ({ containerId: "cid", status: "running" }));
		const scheduler = new TaskScheduler(
			{
				getActiveTasks: async () => [],
				saveTask,
			} as never,
			{ getInstance } as never,
		) as unknown as {
			executeTask: (task: Task) => Promise<void>;
			calculateNextRun: (task: Task) => string | null;
		};

		const miniSpy = spyOn(miniAppDriver, "isMiniAppTaskPrompt").mockReturnValue(false);

		const createSpy = spyOn(IpcFactory, "create").mockReturnValue({
			sendRequest: async () => ({ id: "x", status: 500, error: { message: "failed" } }),
			isAvailable: () => true,
			getMethod: () => "mock",
		} as never);
		await scheduler.executeTask({
			id: "t3",
			instance_name: "i1",
			chat_id: "c1",
			prompt: "echo hi",
			schedule_type: "once",
			schedule_value: "1m",
			next_run: "2026-01-01 00:00:00",
			status: "active",
		});
		expect(saveTask).toHaveBeenCalled();

		createSpy.mockRestore();
		const throwSpy = spyOn(IpcFactory, "create").mockImplementation(() => {
			throw new Error("ipc-fail");
		});
		await scheduler.executeTask({
			id: "t4",
			instance_name: "i1",
			chat_id: "c1",
			prompt: "echo hi",
			schedule_type: "once",
			schedule_value: "1m",
			next_run: "2026-01-01 00:00:00",
			status: "active",
		});
		throwSpy.mockRestore();

		getInstance.mockImplementation(() => null);
		await scheduler.executeTask({
			id: "t5",
			instance_name: "i1",
			chat_id: "c1",
			prompt: "echo hi",
			schedule_type: "once",
			schedule_value: "1m",
			next_run: "2026-01-01 00:00:00",
			status: "active",
		});

		const fallback = scheduler.calculateNextRun({
			id: "t6",
			instance_name: "i1",
			chat_id: "c1",
			prompt: "echo hi",
			schedule_type: "cron",
			schedule_value: "invalid cron",
			next_run: "2026-01-01 00:00:00",
			status: "active",
		});
		expect(typeof fallback).toBe("string");

		miniSpy.mockRestore();
	});
});
