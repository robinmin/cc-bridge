import { expect, test, describe, mock, spyOn } from "bun:test";
import { TaskScheduler } from "@/gateway/task-scheduler";
import { IpcClient } from "@/packages/ipc/client";

describe("TaskScheduler", () => {
    test("should execute due tasks", async () => {
        // Mock persistence
        const mockGetActiveTasks = mock(() => Promise.resolve([{
            id: "task-1",
            instance_name: "agent-1",
            chat_id: "123",
            prompt: "Test prompt",
            schedule_type: "once",
            next_run: "2000-01-01 00:00:00",
            status: "active"
        }]));
        const mockSaveTask = mock(() => Promise.resolve());
        const mockPersistence = {
            getActiveTasks: mockGetActiveTasks,
            saveTask: mockSaveTask
        };

        // Mock instance manager
        const mockInstanceManager = {
            getInstance: () => ({ name: "agent-1", containerId: "123", status: "running" })
        };

        // Create fresh scheduler with mocks
        const scheduler = new TaskScheduler(mockPersistence as any, mockInstanceManager as any);

        // Mock IpcClient
        const mockSendRequest = spyOn(IpcClient.prototype, "sendRequest").mockResolvedValue({
            id: "task-1",
            status: 200,
            result: { stdout: "ok" }
        });

        await scheduler.checkTasks();

        expect(mockGetActiveTasks).toHaveBeenCalled();
        expect(mockSendRequest).toHaveBeenCalled();
        expect(mockSaveTask).toHaveBeenCalledWith(expect.objectContaining({
            id: "task-1",
            status: "completed"
        }));

        mockSendRequest.mockRestore();
    });

    test("should start and stop", async () => {
        const scheduler = new TaskScheduler();
        await scheduler.start();
        // @ts-ignore
        expect(scheduler.isRunning).toBe(true);
        // @ts-ignore
        expect(scheduler.timer).not.toBeNull();

        await scheduler.stop();
        // @ts-ignore
        expect(scheduler.isRunning).toBe(false);
        // @ts-ignore
        expect(scheduler.timer).toBeNull();
    });
});
