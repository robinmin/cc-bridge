import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Channel } from "@/gateway/channels";
import type { Message } from "@/gateway/pipeline";
import { HostBot } from "@/gateway/pipeline/host-bot";

describe("HostBot", () => {
	const mockChannel: Channel = {
		name: "test",
		sendMessage: async () => {},
	};

	const spy = spyOn(mockChannel, "sendMessage");

	beforeEach(() => {
		spy.mockClear();
	});

	test("should handle /host_uptime", async () => {
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("🏠 **Host Uptime**\n\nup 1 day"));
					controller.close();
				},
			}),
			stderr: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			exited: Promise.resolve(0),
		} as unknown as {
			stdout: ReadableStream;
			stderr: ReadableStream;
			exited: Promise<number>;
		});

		const bot = new HostBot(mockChannel);
		const msg: Message = {
			channelId: "test",
			chatId: "123",
			text: "/host_uptime",
		};

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("Host Uptime"));
		spawnSpy.mockRestore();
	});

	test("should handle /host_ps", async () => {
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("📊 **Host CPU/MEM**\n\nprocess info"));
					controller.close();
				},
			}),
			stderr: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			exited: Promise.resolve(0),
		} as unknown as {
			stdout: ReadableStream;
			stderr: ReadableStream;
			exited: Promise<number>;
		});

		const bot = new HostBot(mockChannel);
		const msg: Message = { channelId: "test", chatId: "123", text: "/host_ps" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("Host CPU/MEM"));
		spawnSpy.mockRestore();
	});

	test("should not handle random text", async () => {
		const bot = new HostBot(mockChannel);
		const msg: Message = { channelId: "test", chatId: "123", text: "hello" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});

	test("should execute /host command and return stdout", async () => {
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("hello from host"));
					controller.close();
				},
			}),
			stderr: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			exited: Promise.resolve(0),
			kill: () => {},
		} as unknown as {
			stdout: ReadableStream;
			stderr: ReadableStream;
			exited: Promise<number>;
			kill: () => void;
		});

		const bot = new HostBot(mockChannel);
		const msg: Message = { channelId: "test", chatId: "123", text: "/host echo hello" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spawnSpy).toHaveBeenCalledWith(
			["bash", "-lc", "echo hello"],
			expect.objectContaining({
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("$ echo hello"));
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("stdout:"));
		spawnSpy.mockRestore();
	});

	test("should block dangerous /host command prefixes", async () => {
		const bot = new HostBot(mockChannel);
		const msg: Message = { channelId: "test", chatId: "123", text: "/host rm -rf /tmp/x" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("Command blocked by security policy"));
	});

	test("should truncate very long /host output", async () => {
		const longOutput = "x".repeat(5000);
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(longOutput));
					controller.close();
				},
			}),
			stderr: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			exited: Promise.resolve(0),
			kill: () => {},
		} as unknown as {
			stdout: ReadableStream;
			stderr: ReadableStream;
			exited: Promise<number>;
			kill: () => void;
		});

		const bot = new HostBot(mockChannel);
		const msg: Message = { channelId: "test", chatId: "123", text: "/host echo long" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("Output truncated"));
		spawnSpy.mockRestore();
	});

	test("should show usage when /host command is empty", async () => {
		const bot = new HostBot(mockChannel);
		const msg: Message = { channelId: "test", chatId: "123", text: "/host   " };

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(spy).toHaveBeenCalledWith("123", "Usage: /host <command>");
	});

	test("should handle timeout for /host_uptime command", async () => {
		const killSpy = spyOn({ kill: () => {} }, "kill");
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: new ReadableStream({
				start() {},
			}),
			stderr: new ReadableStream({
				start() {},
			}),
			exited: new Promise<number>(() => {}),
			kill: killSpy,
		} as unknown as {
			stdout: ReadableStream;
			stderr: ReadableStream;
			exited: Promise<number>;
			kill: () => void;
		});
		const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler) => {
			if (typeof fn === "function") {
				fn();
			}
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout);

		const bot = new HostBot(mockChannel);
		const msg: Message = { channelId: "test", chatId: "123", text: "/host_uptime" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(killSpy).toHaveBeenCalled();
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("timed out"));

		timeoutSpy.mockRestore();
		spawnSpy.mockRestore();
	});

	test("should handle timeout for raw /host command", async () => {
		const killSpy = spyOn({ kill: () => {} }, "kill");
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: new ReadableStream({
				start() {},
			}),
			stderr: new ReadableStream({
				start() {},
			}),
			exited: new Promise<number>(() => {}),
			kill: killSpy,
		} as unknown as {
			stdout: ReadableStream;
			stderr: ReadableStream;
			exited: Promise<number>;
			kill: () => void;
		});
		const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler) => {
			if (typeof fn === "function") {
				fn();
			}
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout);

		const bot = new HostBot(mockChannel);
		const msg: Message = { channelId: "test", chatId: "123", text: "/host echo never" };

		const handled = await bot.handle(msg);

		expect(handled).toBe(true);
		expect(killSpy).toHaveBeenCalled();
		expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("timed out"));

		timeoutSpy.mockRestore();
		spawnSpy.mockRestore();
	});
});
