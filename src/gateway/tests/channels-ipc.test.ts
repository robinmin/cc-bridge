import { beforeEach, describe, expect, test } from "bun:test";
import { TelegramChannel } from "@/gateway/channels/telegram";

describe("TelegramChannel", () => {
	let channel: TelegramChannel;
	const BOT_TOKEN = "test-token";

	beforeEach(() => {
		channel = new TelegramChannel(BOT_TOKEN);
	});

	test("should parse valid webhook", () => {
		const body = {
			update_id: 1,
			message: {
				chat: { id: 123 },
				text: "hello",
				from: { id: 456, username: "testuser" },
			},
		};
		const message = channel.parseWebhook(body);
		expect(message).not.toBeNull();
		expect(message?.text).toBe("hello");
		expect(message?.chatId).toBe(123);
	});

	test("should return null for invalid webhook", () => {
		expect(channel.parseWebhook({})).toBeNull();
		expect(channel.parseWebhook(null)).toBeNull();
	});
});
