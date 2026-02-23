import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getChannelForChat, setChannelForChat } from "@/gateway/channels/chat-channel-map";

describe("chat-channel-map", () => {
	let nowSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		delete process.env.CHAT_CHANNEL_MAP_TTL_MS;
		delete process.env.CHAT_CHANNEL_MAP_MAX_SIZE;
		nowSpy = spyOn(Date, "now");
	});

	afterEach(() => {
		nowSpy.mockRestore();
		delete process.env.CHAT_CHANNEL_MAP_TTL_MS;
		delete process.env.CHAT_CHANNEL_MAP_MAX_SIZE;
	});

	test("stores and retrieves channel mapping for chat", () => {
		nowSpy.mockReturnValue(1000);
		setChannelForChat("chat-basic", "telegram");

		nowSpy.mockReturnValue(1001);
		expect(getChannelForChat("chat-basic")).toBe("telegram");
	});

	test("expires mapping when ttl has passed", () => {
		process.env.CHAT_CHANNEL_MAP_TTL_MS = "10";
		nowSpy.mockReturnValue(1000);
		setChannelForChat("chat-expire", "feishu");

		nowSpy.mockReturnValue(1020);
		expect(getChannelForChat("chat-expire")).toBeNull();
	});

	test("falls back to default ttl/max size for invalid env values", () => {
		process.env.CHAT_CHANNEL_MAP_TTL_MS = "-1";
		process.env.CHAT_CHANNEL_MAP_MAX_SIZE = "abc";
		nowSpy.mockReturnValue(2000);
		setChannelForChat("chat-invalid-env", "telegram");

		nowSpy.mockReturnValue(2001);
		expect(getChannelForChat("chat-invalid-env")).toBe("telegram");
	});

	test("applies soft max size cap and removes oldest entries", () => {
		process.env.CHAT_CHANNEL_MAP_MAX_SIZE = "2";
		const base = globalThis.Date.now() + 10_000;

		nowSpy.mockReturnValue(base + 1);
		setChannelForChat("chat-size-1", "telegram");
		nowSpy.mockReturnValue(base + 2);
		setChannelForChat("chat-size-2", "feishu");
		nowSpy.mockReturnValue(base + 3);
		setChannelForChat("chat-size-3", "telegram");

		nowSpy.mockReturnValue(base + 4);
		expect(getChannelForChat("chat-size-1")).toBeNull();
		expect(getChannelForChat("chat-size-2")).toBe("feishu");
		expect(getChannelForChat("chat-size-3")).toBe("telegram");
	});
});
