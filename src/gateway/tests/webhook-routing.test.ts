import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { FeishuChannel } from "@/gateway/channels/feishu";
import type { TelegramChannel } from "@/gateway/channels/telegram";
import type { Bot } from "@/gateway/pipeline";
import { handleWebhook } from "@/gateway/routes/webhook";

// Mock dependencies
const mockPersistence = {
	getWorkspace: mock(async () => "default-workspace"),
	storeMessage: mock(async () => {}),
	setChatChannel: mock(async () => {}),
};

const mockRateLimiter = {
	isAllowed: mock(async () => true),
	getRetryAfter: mock(async () => 60),
	stop: mock(() => {}),
};

const mockUpdateTracker = {
	isProcessed: mock(async () => false),
};

// Mock the modules
mock.module("@/gateway/persistence", () => ({
	persistence: mockPersistence,
}));

mock.module("@/gateway/rate-limiter", () => ({
	rateLimiter: mockRateLimiter,
}));

mock.module("@/gateway/tracker", () => ({
	updateTracker: mockUpdateTracker,
}));

describe("Webhook Routing - handleWebhook", () => {
	let mockTelegram: TelegramChannel;
	let mockFeishu: FeishuChannel;
	let mockBots: Bot[];
	let mockFeishuBots: Bot[];
	let sendMessageSpy: ReturnType<typeof mock>;
	let parseWebhookSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		sendMessageSpy = mock(async () => {});
		parseWebhookSpy = mock(() => ({
			channelId: "test",
			chatId: "test-chat",
			text: "test message",
			updateId: "test-update",
			user: { id: "user-123" },
		}));

		mockTelegram = {
			name: "telegram",
			sendMessage: sendMessageSpy,
			parseWebhook: parseWebhookSpy,
			showTyping: mock(async () => {}),
			setMenu: mock(async () => {}),
			getStatus: mock(async () => ({})),
		} as unknown as TelegramChannel;

		mockFeishu = {
			name: "feishu",
			sendMessage: sendMessageSpy,
			parseWebhook: parseWebhookSpy,
			showTyping: mock(async () => {}),
			setMenu: mock(async () => {}),
			getStatus: mock(async () => ({})),
		} as unknown as FeishuChannel;

		mockBots = [
			{
				name: "TestBot1",
				handle: mock(async () => false),
				getMenus: () => [],
			},
		];

		mockFeishuBots = [
			{
				name: "FeishuBot1",
				handle: mock(async () => false),
				getMenus: () => [],
			},
		];
	});

	afterEach(() => {
		sendMessageSpy.mockClear();
		parseWebhookSpy.mockClear();
		mockPersistence.getWorkspace.mockClear();
		mockPersistence.storeMessage.mockClear();
		mockRateLimiter.isAllowed.mockClear();
		mockUpdateTracker.isProcessed.mockClear();
	});

	describe("Telegram webhook handling", () => {
		test("should process Telegram webhook successfully", async () => {
			const telegramBody = {
				update_id: 123,
				message: {
					message_id: 456,
					from: { id: 789, username: "testuser" },
					chat: { id: 12345, type: "private" },
					text: "Hello bot",
				},
			};

			const app = new Hono();
			app.post("/webhook", (c) => handleWebhook(c, { telegram: mockTelegram, bots: mockBots }));

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramBody),
			});

			expect(response.status).toBe(200);
			const data = (await response.json()) as { status: string };
			expect(data.status).toBe("ok");
		});

		test("should handle Telegram webhook when no bot handles message", async () => {
			const telegramBody = {
				update_id: 123,
				message: {
					message_id: 456,
					from: { id: 789, username: "testuser" },
					chat: { id: 12345, type: "private" },
					text: "Unhandled message",
				},
			};

			const unhandledBot = {
				name: "UnhandledBot",
				handle: mock(async () => false),
				getMenus: () => [],
			};

			const app = new Hono();
			app.post("/webhook", (c) => handleWebhook(c, { telegram: mockTelegram, bots: [unhandledBot] }));

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramBody),
			});

			// Should return 200 even if no bot handles it
			expect(response.status).toBe(200);
			expect(sendMessageSpy).toHaveBeenCalled();
			const firstMessage = sendMessageSpy.mock.calls[0]?.[1];
			expect(String(firstMessage)).toContain("No available handler");
		});
	});

	describe("Feishu webhook handling", () => {
		test("should process Feishu webhook successfully", async () => {
			const feishuBody = {
				schema: "2.0",
				header: {
					event_id: "event_test_123",
					timestamp: "1640000000000",
					event_type: "im.message.receive_v1",
					tenant_key: "test_tenant",
					app_id: "cli_test123456",
				},
				event: {
					sender: {
						sender_id: {
							open_id: "ou_test123",
						},
						sender_type: "user",
						tenant_key: "test_tenant",
					},
					message: {
						message_id: "om_test789",
						chat_id: "oc_test12345",
						chat_type: "group",
						content: '{"text":"Hello bot"}',
						message_type: "text",
					},
				},
			};

			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: mockTelegram,
					feishu: mockFeishu,
					bots: mockBots,
					feishuBots: mockFeishuBots,
				}),
			);

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(feishuBody),
			});

			expect(response.status).toBe(200);
			const data = (await response.json()) as { status: string };
			expect(data.status).toBe("ok");
		});

		test("should return 503 when Feishu webhook received but Feishu not configured", async () => {
			const feishuBody = {
				schema: "2.0",
				header: {
					event_id: "event_test_123",
					timestamp: "1640000000000",
					event_type: "im.message.receive_v1",
					tenant_key: "test_tenant",
					app_id: "cli_test123456",
				},
				event: {
					sender: {
						sender_id: {
							open_id: "ou_test123",
						},
						sender_type: "user",
						tenant_key: "test_tenant",
					},
					message: {
						message_id: "om_test789",
						chat_id: "oc_test12345",
						chat_type: "group",
						content: '{"text":"Hello bot"}',
						message_type: "text",
					},
				},
			};

			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: mockTelegram,
					feishu: undefined,
					bots: mockBots,
					feishuBots: undefined,
				}),
			);

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(feishuBody),
			});

			expect(response.status).toBe(503);
			const data = (await response.json()) as { status: string; reason: string };
			expect(data.status).toBe("ignored");
			expect(data.reason).toBe("feishu not configured");
		});

		test("should return 503 when Feishu webhook received but feishuBots not configured", async () => {
			const feishuBody = {
				schema: "2.0",
				header: {
					event_id: "event_test_123",
					event_type: "im.message.receive_v1",
				},
				event: {
					sender: {
						sender_id: { open_id: "ou_test123" },
					},
					message: {
						chat_id: "oc_test12345",
						content: '{"text":"Hello"}',
					},
				},
			};

			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: mockTelegram,
					feishu: mockFeishu,
					bots: mockBots,
					feishuBots: undefined,
				}),
			);

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(feishuBody),
			});

			expect(response.status).toBe(503);
		});
	});

	describe("Unknown channel handling", () => {
		test("should return ignored status for unknown channel type", async () => {
			const unknownBody = {
				some_field: "some_value",
				random_data: 123,
			};

			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: mockTelegram,
					bots: mockBots,
				}),
			);

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(unknownBody),
			});

			expect(response.status).toBe(200);
			const data = (await response.json()) as { status: string; reason: string };
			expect(data.status).toBe("ignored");
			expect(data.reason).toBe("unknown channel");
		});

		test("should handle empty request body", async () => {
			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: mockTelegram,
					bots: mockBots,
				}),
			);

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(null),
			});

			expect(response.status).toBe(200);
			const data = (await response.json()) as { status: string; reason: string };
			expect(data.status).toBe("ignored");
			expect(data.reason).toBe("unknown channel");
		});

		test("should handle invalid JSON", async () => {
			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: mockTelegram,
					bots: mockBots,
				}),
			);

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "invalid json",
			});

			// Should handle gracefully (likely 400 or 500 depending on Hono's error handling)
			expect([400, 500, 200]).toContain(response.status);
		});
	});

	describe("Rate limiting", () => {
		test("should return rate limited response when rate limit exceeded", async () => {
			const telegramBody = {
				update_id: 123,
				message: {
					message_id: 456,
					from: { id: 789, username: "testuser" },
					chat: { id: 12345, type: "private" },
					text: "Hello bot",
				},
			};

			mockRateLimiter.isAllowed.mockResolvedValueOnce(false);
			mockRateLimiter.getRetryAfter.mockResolvedValueOnce(30);

			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: mockTelegram,
					bots: mockBots,
				}),
			);

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramBody),
			});

			expect(response.status).toBe(429);
			const data = (await response.json()) as { status: string };
			expect(data.status).toBe("rate_limited");
			expect(sendMessageSpy).toHaveBeenCalled();
		});
	});

	describe("Deduplication", () => {
		test("should ignore duplicate updates", async () => {
			const telegramBody = {
				update_id: 123,
				message: {
					message_id: 456,
					from: { id: 789, username: "testuser" },
					chat: { id: 12345, type: "private" },
					text: "Hello bot",
				},
			};

			mockUpdateTracker.isProcessed.mockResolvedValueOnce(true);

			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: mockTelegram,
					bots: mockBots,
				}),
			);

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramBody),
			});

			expect(response.status).toBe(200);
			const data = (await response.json()) as { status: string; reason: string };
			expect(data.status).toBe("ignored");
			expect(data.reason).toBe("duplicate");
		});
	});

	describe("Message parsing edge cases", () => {
		test("should ignore webhook when parseWebhook returns null", async () => {
			const telegramBody = {
				update_id: 123,
				// No message - callback_query only
				callback_query: {
					id: 456,
					data: "test_data",
				},
			};

			const mockChannel = {
				...mockTelegram,
				parseWebhook: mock(() => null),
			} as unknown as TelegramChannel;

			const app = new Hono();
			app.post("/webhook", (c) => handleWebhook(c, { telegram: mockChannel, bots: mockBots }));

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramBody),
			});

			expect(response.status).toBe(200);
			const data = (await response.json()) as { status: string; reason: string };
			expect(data.status).toBe("ignored");
			expect(data.reason).toBe("no message");
		});
	});

	describe("Error handling", () => {
		test("should handle bot errors gracefully", async () => {
			const telegramBody = {
				update_id: 123,
				message: {
					message_id: 456,
					from: { id: 789, username: "testuser" },
					chat: { id: 12345, type: "private" },
					text: "Trigger error",
				},
			};

			const errorBot = {
				name: "ErrorBot",
				handle: mock(async () => {
					throw new Error("Bot error");
				}),
				getMenus: () => [],
			};

			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: mockTelegram,
					bots: [errorBot],
				}),
			);

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramBody),
			});

			// Should return 200 even if bot throws (error is caught)
			expect(response.status).toBe(200);
		});

		test("should send error notification when no bot handles and error occurred", async () => {
			const telegramBody = {
				update_id: 123,
				message: {
					message_id: 456,
					from: { id: 789, username: "testuser" },
					chat: { id: 12345, type: "private" },
					text: "Error test",
				},
			};

			// Use AgentBot name so BotRouter will route to it
			const errorBot = {
				name: "AgentBot",
				handle: mock(async () => {
					throw new Error("Test error");
				}),
				getMenus: () => [],
			};

			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: mockTelegram,
					bots: [errorBot],
				}),
			);

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramBody),
			});

			expect(response.status).toBe(200);
			// Error notification should be sent via sendMessage
			expect(sendMessageSpy).toHaveBeenCalled();
		});
	});
});
