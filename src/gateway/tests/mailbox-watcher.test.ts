import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import type { Channel } from "@/gateway/channels";
import { MailboxWatcher } from "@/gateway/mailbox-watcher";

type MailboxWatcherInternals = {
	processMessages: (messagesDir: string) => Promise<void>;
};

describe("MailboxWatcher", () => {
	let mockChannel: Channel;

	beforeEach(() => {
		mockChannel = {
			name: "test",
			sendMessage: async (_chatId, _text) => {},
		};
	});

	test("should discover and deliver messages from instance folders", async () => {
		const sendMessageSpy = spyOn(mockChannel, "sendMessage");
		const mockPersistence = {
			getWorkspace: async () => "cc-bridge",
			storeMessage: async () => {},
		};
		const watcher = new MailboxWatcher(
			mockChannel,
			"/ipc-test",
			1000,
			mockPersistence as unknown as { storeMessage: () => Promise<void> },
		);

		const readdirSpy = spyOn(fs, "readdir").mockResolvedValue(["msg_1.json"] as never);
		const readFileSpy = spyOn(fs, "readFile").mockResolvedValue(
			JSON.stringify({ type: "message", chatId: 123, text: "Hello from agent!" }) as never,
		);
		const unlinkSpy = spyOn(fs, "unlink").mockResolvedValue(undefined as never);

		await (watcher as unknown as MailboxWatcherInternals).processMessages("/ipc-test/agent/messages");

		expect(sendMessageSpy).toHaveBeenCalledWith(123, "Hello from agent!");
		expect(unlinkSpy).toHaveBeenCalled();

		unlinkSpy.mockRestore();
		readFileSpy.mockRestore();
		readdirSpy.mockRestore();
	});

	test("should ignore invalid message types or missing fields", async () => {
		const sendMessageSpy = spyOn(mockChannel, "sendMessage");
		const mockPersistence = {
			getWorkspace: async () => "cc-bridge",
			storeMessage: async () => {},
		};
		const watcher = new MailboxWatcher(
			mockChannel,
			"/ipc-test",
			1000,
			mockPersistence as unknown as { storeMessage: () => Promise<void> },
		);

		const readdirSpy = spyOn(fs, "readdir").mockResolvedValue(["invalid_1.json", "invalid_2.json"] as never);
		const readFileSpy = spyOn(fs, "readFile")
			.mockResolvedValueOnce(JSON.stringify({ type: "message", chatId: 123 }) as never)
			.mockResolvedValueOnce(JSON.stringify({ type: "other", chatId: 123, text: "hi" }) as never);
		const unlinkSpy = spyOn(fs, "unlink").mockResolvedValue(undefined as never);

		await (watcher as unknown as MailboxWatcherInternals).processMessages("/ipc-test/agent/messages");
		expect(sendMessageSpy).not.toHaveBeenCalled();
		expect(unlinkSpy).toHaveBeenCalledTimes(2);

		unlinkSpy.mockRestore();
		readFileSpy.mockRestore();
		readdirSpy.mockRestore();
	});

	test("should start and stop timer", async () => {
		const watcher = new MailboxWatcher(mockChannel, "/ipc-test");
		await watcher.start();
		// @ts-expect-error internal state assertion
		expect(watcher.isRunning).toBe(true);
		await watcher.stop();
		// @ts-expect-error internal state assertion
		expect(watcher.isRunning).toBe(false);
	});

	test("should swallow poll errors", async () => {
		const watcher = new MailboxWatcher(mockChannel, "/path/does/not/exist");
		await expect(watcher.poll()).resolves.toBeUndefined();
	});

	test("should execute polling callback while running", async () => {
		const watcher = new MailboxWatcher(mockChannel, "/ipc-test", 5);
		const pollSpy = spyOn(watcher, "poll");
		await watcher.start();
		await new Promise((resolve) => setTimeout(resolve, 20));
		await watcher.stop();
		expect(pollSpy).toHaveBeenCalled();
		pollSpy.mockRestore();
	});
});
