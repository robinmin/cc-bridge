import { describe, expect, mock, spyOn, test } from "bun:test";
import { TaskScheduler } from "@/gateway/task-scheduler";
import { IpcFactory } from "@/packages/ipc";

type MockPersistenceForScheduler = {
	getActiveTasks: () => Promise<
		Array<{
			id: string;
			instance_name: string;
			chat_id: string | number;
			prompt: string;
			schedule_type: string;
			next_run: string;
			status: string;
		}>
	>;
	saveTask: (task: unknown) => Promise<void>;
};

type MockInstanceManagerForScheduler = {
	getInstance: () => {
		name: string;
		containerId: string;
		status: string;
	} | null;
};

describe("TaskScheduler", () => {
	test("should execute due tasks", async () => {
		// Mock persistence
		const mockGetActiveTasks = mock(() =>
			Promise.resolve([
				{
					id: "task-1",
					instance_name: "agent-1",
					chat_id: "123",
					prompt: "Test prompt",
					schedule_type: "once",
					next_run: "2000-01-01 00:00:00",
					status: "active",
				},
			]),
		);
		const mockSaveTask = mock(() => Promise.resolve());
		const mockPersistence = {
			getActiveTasks: mockGetActiveTasks,
			saveTask: mockSaveTask,
		};

		// Mock instance manager
		const mockInstanceManager = {
			getInstance: () => ({
				name: "agent-1",
				containerId: "123",
				status: "running",
			}),
		};

		// Create fresh scheduler with mocks
		const scheduler = new TaskScheduler(
			mockPersistence as unknown as MockPersistenceForScheduler,
			mockInstanceManager as unknown as MockInstanceManagerForScheduler,
		);

		// Mock IpcFactory.create to return a mock client
		const mockSendRequest = mock(() =>
			Promise.resolve({
				id: "task-1",
				status: 200,
				result: { stdout: "ok" },
			}),
		);
		const mockIpcClient = {
			sendRequest: mockSendRequest,
			isAvailable: () => true,
			getMethod: () => "mock",
		};
		const mockCreate = spyOn(IpcFactory, "create").mockReturnValue(mockIpcClient as never);

		await scheduler.checkTasks();

		expect(mockGetActiveTasks).toHaveBeenCalled();
		expect(mockCreate).toHaveBeenCalled();
		expect(mockSendRequest).toHaveBeenCalled();
		expect(mockSaveTask).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "task-1",
				status: "completed",
			}),
		);

		mockCreate.mockRestore();
	});

	test("should start and stop", async () => {
		const scheduler = new TaskScheduler();
		await scheduler.start();
		// @ts-expect-error
		expect(scheduler.isRunning).toBe(true);
		// @ts-expect-error
		expect(scheduler.timer).not.toBeNull();

		await scheduler.stop();
		// @ts-expect-error
		expect(scheduler.isRunning).toBe(false);
		// @ts-expect-error
		expect(scheduler.timer).toBeNull();
	});
});
