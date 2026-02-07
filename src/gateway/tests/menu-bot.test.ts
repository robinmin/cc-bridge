import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Channel } from "@/gateway/channels";
import type { Message } from "@/gateway/pipeline";
import { MenuBot } from "@/gateway/pipeline/menu-bot";

describe("MenuBot", () => {
	const mockChannel: Channel = {
		name: "test",
		sendMessage: async () => {},
	};

	const spy = spyOn(mockChannel, "sendMessage");

	beforeEach(() => {
		spy.mockClear();
	});

	test("should handle /start", async () => {
		const bot = new MenuBot(mockChannel);
		const msg: Message = { channelId: "test", chatId: "123", text: "/start" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalled();
	});

	test("should not handle random text", async () => {
		const bot = new MenuBot(mockChannel);
		const msg: Message = { channelId: "test", chatId: "123", text: "hello" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});

	test("should handle /help", async () => {
		const bot = new MenuBot(mockChannel);
		const msg: Message = { channelId: "test", chatId: "123", text: "/help" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalled();
	});
});
