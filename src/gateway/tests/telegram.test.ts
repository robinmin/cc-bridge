import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { TelegramChannel, TelegramClient } from "@/gateway/channels/telegram";

// Mock fetch globally
const originalFetch = globalThis.fetch;

describe("TelegramChannel", () => {
	let telegram: TelegramChannel;
	const testBotToken = "test-token-12345";
	let mockCalls: Array<{ url: string; body?: unknown }> = [];

	beforeEach(() => {
		mockCalls = [];
		// @ts-expect-error - mock fetch
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const body = init?.body ? JSON.parse(init.body as string) : undefined;

			mockCalls.push({ url, body });

			if (url.includes("sendMessage")) {
				return {
					ok: true,
					json: async () => ({ ok: true, result: body }),
					text: async () => "OK",
				} as Response;
			}

			if (url.includes("sendChatAction")) {
				return {
					ok: true,
					json: async () => ({ ok: true }),
					text: async () => "OK",
				} as Response;
			}

			if (url.includes("setMyCommands")) {
				return {
					ok: true,
					json: async () => ({ ok: true }),
					text: async () => "OK",
				} as Response;
			}

			if (url.includes("getWebhookInfo")) {
				return {
					ok: true,
					json: async () => ({ ok: true, result: { url: "https://test.com" } }),
					text: async () => "OK",
				} as Response;
			}

			return {
				ok: false,
				json: async () => ({ ok: false, description: "Test error" }),
				text: async () => "Error",
			} as Response;
		};

		telegram = new TelegramChannel(testBotToken);
	});

	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	describe("sendMessage", () => {
		test("should send message to user", async () => {
			await telegram.sendMessage(12345, "Hello test");

			expect(mockCalls.length).toBe(1);
			expect(mockCalls[0].url).toContain("sendMessage");
		});

		test("should handle numeric chat IDs", async () => {
			await telegram.sendMessage(12345, "Test");

			expect(mockCalls[0].body.chat_id).toBe(12345);
		});

		test("should handle string chat IDs", async () => {
			await telegram.sendMessage("test-chat", "Test");

			expect(mockCalls[0].body.chat_id).toBe("test-chat");
		});

		test("should pass through options", async () => {
			await telegram.sendMessage(12345, "Test", { parse_mode: "HTML" });

			expect(mockCalls[0].body.parse_mode).toBe("HTML");
		});

		test("should default to MarkdownV2 and escape text", async () => {
			await telegram.sendMessage(12345, "plain text with *markdown-like* chars.");

			expect(mockCalls[0].body.parse_mode).toBe("MarkdownV2");
			expect(mockCalls[0].body.text).toBe("plain text with \\*markdown\\-like\\* chars\\.");
		});
	});

	describe("showTyping", () => {
		test("should send typing action", async () => {
			await telegram.showTyping(12345);

			expect(mockCalls.length).toBe(1);
			expect(mockCalls[0].url).toContain("sendChatAction");
			expect(mockCalls[0].body.action).toBe("typing");
		});

		test("should handle errors gracefully when sending typing", async () => {
			// Mock fetch to return error
			// @ts-expect-error
			globalThis.fetch = async () => ({
				ok: false,
				text: async () => "Error",
			});

			// Should not throw, just log warning
			await telegram.showTyping(12345);

			// Test passes if we get here without throwing
			expect(true).toBe(true);
		});
	});

	describe("parseWebhook", () => {
		test("should parse valid message webhook", () => {
			const webhookBody = {
				update_id: 123,
				message: {
					message_id: 456,
					from: { id: 789, username: "testuser" },
					chat: { id: 12345, type: "private" },
					text: "Hello bot",
					date: 1640000000,
				},
			};

			const message = telegram.parseWebhook(webhookBody);

			expect(message).not.toBeNull();
			expect(message?.chatId).toBe(12345);
			expect(message?.text).toBe("Hello bot");
			expect(message?.updateId).toBe(123);
			expect(message?.user?.id).toBe(789);
			expect(message?.user?.username).toBe("testuser");
		});

		test("should return null for webhook without message", () => {
			const webhookBody = {
				update_id: 123,
				callback_query: {
					id: 456,
					data: "test_data",
				},
			};

			const message = telegram.parseWebhook(webhookBody);
			expect(message).toBeNull();
		});

		test("should return null for empty webhook body", () => {
			const message = telegram.parseWebhook(null);
			expect(message).toBeNull();
		});

		test("should handle missing optional fields", () => {
			const webhookBody = {
				update_id: 123,
				message: {
					message_id: 456,
					chat: { id: 12345, type: "private" },
					text: "Test",
				},
			};

			const message = telegram.parseWebhook(webhookBody);

			expect(message).not.toBeNull();
			expect(message?.user?.id).toBeUndefined();
			expect(message?.text).toBe("Test");
		});
	});

	describe("TelegramClient", () => {
		let client: TelegramClient;

		beforeEach(() => {
			client = new TelegramClient(testBotToken);
			mockCalls = [];
		});

		describe("sendChatAction", () => {
			test("should send typing action", async () => {
				await client.sendChatAction(12345, "typing");

				expect(mockCalls.length).toBe(1);
				expect(mockCalls[0].body.action).toBe("typing");
			});

			test("should default to typing action", async () => {
				await client.sendChatAction(12345);

				expect(mockCalls[0].body.action).toBe("typing");
			});

			test("should handle different action types", async () => {
				await client.sendChatAction(12345, "upload_document");
				expect(mockCalls[0].body.action).toBe("upload_document");

				await client.sendChatAction(12345, "record_video");
				expect(mockCalls[1].body.action).toBe("record_video");
			});
		});

		describe("setCommands", () => {
			test("should set bot commands", async () => {
				const commands = [
					{ command: "start", description: "Start command" },
					{ command: "help", description: "Help command" },
				];

				await client.setCommands(commands);

				expect(mockCalls.length).toBe(1);
				expect(mockCalls[0].body.commands).toEqual(commands);
			});

			test("should sanitize network errors and avoid token leakage", async () => {
				// @ts-expect-error - mock fetch
				globalThis.fetch = async () => {
					const err = new Error(`Unable to connect: /bot${testBotToken}/setMyCommands`);
					(err as Error & { code?: string; path?: string }).code = "ConnectionRefused";
					(err as Error & { code?: string; path?: string }).path =
						`https://api.telegram.org/bot${testBotToken}/setMyCommands`;
					throw err;
				};

				const commands = [{ command: "start", description: "Start command" }];

				try {
					await client.setCommands(commands);
					throw new Error("Expected setCommands to throw");
				} catch (error) {
					const message = String(error);
					expect(message).not.toContain(testBotToken);
					expect(message).toContain("<redacted>");
					expect((error as { path?: string }).path).toBeUndefined();
					expect((error as { code?: string }).code).toBe("ConnectionRefused");
				}
			});
		});

		describe("getWebhookInfo", () => {
			test("should get webhook info", async () => {
				const info = await client.getWebhookInfo();

				expect(info).toBeDefined();
			});
		});
	});
});
