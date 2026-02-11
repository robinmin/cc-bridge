import { describe, expect, spyOn, test } from "bun:test";
import type { Channel } from "@/gateway/channels";
import type { Message } from "@/gateway/pipeline";
import { AgentBot } from "@/gateway/pipeline/agent-bot";

type MockPersistence = {
	getSession: () => Promise<null>;
	setSession: () => Promise<void>;
	getHistory: () => Promise<unknown[]>;
	storeMessage: () => Promise<void>;
	getWorkspace: () => Promise<string>;
};

describe("AgentBot", () => {
	const mockChannel: Channel = {
		name: "test",
		sendMessage: async () => {},
	};

	const spy = spyOn(mockChannel, "sendMessage");

	const mockPersistence = {
		getSession: async () => null,
		setSession: async () => {},
		getHistory: async () => [],
		storeMessage: async () => {},
		getWorkspace: async () => "cc-bridge",
	};

	test("should handle no running instances", async () => {
		const bot = new AgentBot(mockChannel, mockPersistence as unknown as MockPersistence);
		const msg: Message = { channelId: "test", chatId: "123", text: "hello" };

		// Mock instance manager to return no instances
		const { instanceManager } = require("@/gateway/instance-manager");
		instanceManager.getInstances = () => [];
		instanceManager.refresh = async () => [];

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("No running Claude instance found"));
	});

	test("should handle workspace commands", async () => {
		const bot = new AgentBot(mockChannel, mockPersistence as unknown as MockPersistence);

		// Mock instance manager to return a running instance
		const { instanceManager } = require("@/gateway/instance-manager");
		instanceManager.getInstances = () => [
			{
				name: "test-agent",
				containerId: "123",
				status: "running",
				image: "cc-bridge",
			},
		];

		// Test /agents command (doesn't require tmux)
		const msg: Message = { channelId: "test", chatId: "123", text: "/agents" };
		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalled();
	});
});
