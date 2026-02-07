import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { Channel } from "@/gateway/channels";
import { MailboxWatcher } from "@/gateway/mailbox-watcher";

describe("MailboxWatcher", () => {
	let mockChannel: Channel;
	const tempIpcDir = path.join(process.cwd(), "temp_ipc_test");

	beforeEach(async () => {
		mockChannel = {
			name: "test",
			sendMessage: async (_chatId, _text) => {},
		};

		if (
			await fs
				.access(tempIpcDir)
				.then(() => true)
				.catch(() => false)
		) {
			await fs.rm(tempIpcDir, { recursive: true });
		}
		await fs.mkdir(tempIpcDir, { recursive: true });
	});

	afterEach(async () => {
		if (
			await fs
				.access(tempIpcDir)
				.then(() => true)
				.catch(() => false)
		) {
			await fs.rm(tempIpcDir, { recursive: true });
		}
	});

	test("should discover and deliver messages from instance folders", async () => {
		const sendMessageSpy = spyOn(mockChannel, "sendMessage");
		const mockPersistence = { storeMessage: async () => {} };
		const watcher = new MailboxWatcher(
			mockChannel,
			tempIpcDir,
			1000,
			mockPersistence as unknown as { storeMessage: () => Promise<void> },
		);

		const instanceName = "test-agent";
		const messagesDir = path.join(tempIpcDir, instanceName, "messages");
		await fs.mkdir(messagesDir, { recursive: true });

		const message = {
			type: "message",
			chatId: 123,
			text: "Hello from agent!",
		};

		await fs.writeFile(
			path.join(messagesDir, "msg_1.json"),
			JSON.stringify(message),
		);

		await watcher.poll();

		expect(sendMessageSpy).toHaveBeenCalledWith(123, "Hello from agent!");

		const files = await fs.readdir(messagesDir);
		expect(files.length).toBe(0);
	});

	test("should ignore invalid message types or missing fields", async () => {
		const sendMessageSpy = spyOn(mockChannel, "sendMessage");
		const mockPersistence = { storeMessage: async () => {} };
		const watcher = new MailboxWatcher(
			mockChannel,
			tempIpcDir,
			1000,
			mockPersistence as unknown as { storeMessage: () => Promise<void> },
		);

		const instanceName = "test-agent-invalid";
		const messagesDir = path.join(tempIpcDir, instanceName, "messages");
		await fs.mkdir(messagesDir, { recursive: true });

		// Missing text
		await fs.writeFile(
			path.join(messagesDir, "invalid_1.json"),
			JSON.stringify({ type: "message", chatId: 123 }),
		);

		// Wrong type
		await fs.writeFile(
			path.join(messagesDir, "invalid_2.json"),
			JSON.stringify({ type: "other", chatId: 123, text: "hi" }),
		);

		await watcher.poll();

		expect(sendMessageSpy).not.toHaveBeenCalled();

		const files = await fs.readdir(messagesDir);
		expect(files.length).toBe(0);
	});

	test("should start and stop timer", async () => {
		const watcher = new MailboxWatcher(mockChannel, tempIpcDir);

		await watcher.start();
		// @ts-expect-error
		expect(watcher.isRunning).toBe(true);

		await watcher.stop();
		// @ts-expect-error
		expect(watcher.isRunning).toBe(false);
	});
});
