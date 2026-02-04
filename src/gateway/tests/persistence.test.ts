import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { PersistenceManager } from "@/gateway/persistence";
import fs from "node:fs";

describe("PersistenceManager", () => {
    const testDbPath = "data/test_gateway.db";
    let persistence: PersistenceManager;

    beforeEach(() => {
        if (!fs.existsSync("data")) fs.mkdirSync("data");
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
        persistence = new PersistenceManager(testDbPath);
    });

    afterEach(() => {
        persistence.close();
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
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
            status: "active"
        };

        await persistence.saveTask(task);

        const activeTasks = await persistence.getActiveTasks() as any[];
        expect(activeTasks.length).toBe(1);
        expect(activeTasks[0].id).toBe("task-1");
    });
});
