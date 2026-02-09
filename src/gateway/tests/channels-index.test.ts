import { describe, expect, test } from "bun:test";
import type { Channel, ChannelAdapter } from "@/gateway/channels";
import { FeishuChannel, TelegramChannel, TelegramClient } from "@/gateway/channels";

describe("Channels Index - Exports", () => {
	describe("Named exports", () => {
		test("should export TelegramChannel", () => {
			expect(TelegramChannel).toBeDefined();
			expect(typeof TelegramChannel).toBe("function");
		});

		test("should export TelegramClient", () => {
			expect(TelegramClient).toBeDefined();
			expect(typeof TelegramClient).toBe("function");
		});

		test("should export FeishuChannel", () => {
			expect(FeishuChannel).toBeDefined();
			expect(typeof FeishuChannel).toBe("function");
		});
	});

	describe("Channel interface", () => {
		test("Channel interface should have required properties", () => {
			// Create a mock that implements the Channel interface
			const mockChannel = {
				name: "test",
				sendMessage: async () => {},
			} as Channel;

			expect(mockChannel).toHaveProperty("name");
			expect(typeof mockChannel.name).toBe("string");
			expect(typeof mockChannel.sendMessage).toBe("function");
		});

		test("Channel interface should have optional showTyping", () => {
			const mockChannelWithTyping = {
				name: "test",
				sendMessage: async () => {},
				showTyping: async () => {},
			} as Channel;

			expect(typeof mockChannelWithTyping.showTyping).toBe("function");
		});
	});

	describe("ChannelAdapter interface", () => {
		test("ChannelAdapter interface should have parseWebhook method", () => {
			// Create a mock that implements the ChannelAdapter interface
			const mockAdapter = {
				parseWebhook: () => null,
			} as ChannelAdapter;

			expect(typeof mockAdapter.parseWebhook).toBe("function");
		});
	});

	describe("Channel implementations", () => {
		test("TelegramChannel should implement Channel interface", () => {
			const telegram = new TelegramChannel("test-token");

			expect(telegram).toHaveProperty("name");
			expect(telegram.name).toBe("telegram");
			expect(typeof telegram.sendMessage).toBe("function");
		});

		test("TelegramChannel should implement ChannelAdapter interface", () => {
			const telegram = new TelegramChannel("test-token");

			expect(typeof telegram.parseWebhook).toBe("function");

			// Test with null input
			const result = telegram.parseWebhook(null);
			expect(result).toBeNull();
		});

		test("FeishuChannel should implement Channel interface", () => {
			const feishu = new FeishuChannel("test-app-id", "test-app-secret");

			expect(feishu).toHaveProperty("name");
			expect(feishu.name).toBe("feishu");
			expect(typeof feishu.sendMessage).toBe("function");
		});

		test("FeishuChannel should implement ChannelAdapter interface", () => {
			const feishu = new FeishuChannel("test-app-id", "test-app-secret");

			expect(typeof feishu.parseWebhook).toBe("function");

			// Test with null input
			const result = feishu.parseWebhook(null);
			expect(result).toBeNull();
		});
	});

	describe("Channel type compatibility", () => {
		test("TelegramChannel and FeishuChannel should be compatible with Channel type", () => {
			const telegram: Channel = new TelegramChannel("test-token");
			const feishu: Channel = new FeishuChannel("test-app-id", "test-app-secret");

			expect(telegram.name).toBeDefined();
			expect(feishu.name).toBeDefined();
			expect(typeof telegram.sendMessage).toBe("function");
			expect(typeof feishu.sendMessage).toBe("function");
		});

		test("TelegramChannel and FeishuChannel should be compatible with ChannelAdapter type", () => {
			const telegram: ChannelAdapter = new TelegramChannel("test-token");
			const feishu: ChannelAdapter = new FeishuChannel("test-app-id", "test-app-secret");

			expect(typeof telegram.parseWebhook).toBe("function");
			expect(typeof feishu.parseWebhook).toBe("function");
		});
	});

	describe("Polymorphic channel usage", () => {
		test("should be able to use channels polymorphically", () => {
			const channels: Channel[] = [
				new TelegramChannel("test-token"),
				new FeishuChannel("test-app-id", "test-app-secret"),
			];

			channels.forEach((channel) => {
				expect(channel.name).toBeDefined();
				expect(typeof channel.sendMessage).toBe("function");
			});
		});

		test("should be able to parse webhooks polymorphically", () => {
			const adapters: ChannelAdapter[] = [
				new TelegramChannel("test-token"),
				new FeishuChannel("test-app-id", "test-app-secret"),
			];

			adapters.forEach((adapter) => {
				expect(typeof adapter.parseWebhook).toBe("function");
				// Test that parseWebhook can be called
				const result = adapter.parseWebhook(null);
				expect(result).toBeNull();
			});
		});
	});
});
