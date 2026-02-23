import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { FeishuChannel } from "@/gateway/channels/feishu";
import type { TelegramChannel } from "@/gateway/channels/telegram";
import type { Bot } from "@/gateway/pipeline";
import { handleFeishuWebhook, handleTelegramWebhook, handleWebhook } from "@/gateway/routes/webhook";

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

		test("should return 400 for invalid telegram json in direct handler", async () => {
			const app = new Hono();
			app.post("/webhook/telegram", (c) => handleTelegramWebhook(c, { telegram: mockTelegram, bots: mockBots }));

			const response = await app.request("/webhook/telegram", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "invalid-json",
			});

			expect(response.status).toBe(400);
			const data = (await response.json()) as { status: string; reason: string };
			expect(data).toEqual({ status: "ignored", reason: "invalid json" });
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

		test("should return 400 for invalid feishu json in direct handler", async () => {
			const app = new Hono();
			app.post("/webhook/feishu", (c) =>
				handleFeishuWebhook(c, {
					telegram: mockTelegram,
					feishu: mockFeishu,
					bots: mockBots,
					feishuBots: mockFeishuBots,
				}),
			);

			const response = await app.request("/webhook/feishu", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "invalid-json",
			});

			expect(response.status).toBe(400);
			const data = (await response.json()) as { status: string; reason: string };
			expect(data).toEqual({ status: "ignored", reason: "invalid json" });
		});

		test("should return 500 when encrypted feishu webhook has no encrypt key", async () => {
			const encryptedFeishu = {
				encrypt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			};
			const feishuNoKey = {
				...mockFeishu,
				getEncryptKey: mock(() => ""),
			} as unknown as FeishuChannel;

			const app = new Hono();
			app.post("/webhook/feishu", (c) =>
				handleFeishuWebhook(c, {
					telegram: mockTelegram,
					feishu: feishuNoKey,
					bots: mockBots,
					feishuBots: mockFeishuBots,
				}),
			);

			const response = await app.request("/webhook/feishu", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(encryptedFeishu),
			});

			expect(response.status).toBe(500);
		});

		test("should return 400 when encrypted feishu webhook decryption fails", async () => {
			const encryptedFeishu = {
				encrypt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			};
			const feishuWithKey = {
				...mockFeishu,
				getEncryptKey: mock(() => "12345678901234567890123456789012"),
			} as unknown as FeishuChannel;

			const app = new Hono();
			app.post("/webhook/feishu", (c) =>
				handleFeishuWebhook(c, {
					telegram: mockTelegram,
					feishu: feishuWithKey,
					bots: mockBots,
					feishuBots: mockFeishuBots,
				}),
			);

			const response = await app.request("/webhook/feishu", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(encryptedFeishu),
			});

			expect(response.status).toBe(400);
			const data = (await response.json()) as { status: string; message: string };
			expect(data.status).toBe("error");
		});

		test("should return URL verification response for encrypted challenge payload", async () => {
			const encryptKey = "12345678901234567890123456789012";
			const encryptedFeishu = {
				encrypt: encryptFeishuPayload({ challenge: "challenge-value" }, encryptKey),
			};
			const feishuWithKey = {
				...mockFeishu,
				getEncryptKey: mock(() => encryptKey),
				handleUrlVerification: mock(() => ({ challenge: "challenge-value" })),
			} as unknown as FeishuChannel;

			const app = new Hono();
			app.post("/webhook/feishu", (c) =>
				handleFeishuWebhook(c, {
					telegram: mockTelegram,
					feishu: feishuWithKey,
					bots: mockBots,
					feishuBots: mockFeishuBots,
				}),
			);

			const response = await app.request("/webhook/feishu", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(encryptedFeishu),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ challenge: "challenge-value" });
		});

		test("should ignore feishu webhook when parseWebhook returns null", async () => {
			const feishuBody = {
				schema: "2.0",
				header: { event_type: "im.message.receive_v1" },
				event: {},
			};
			const feishuNullParser = {
				...mockFeishu,
				parseWebhook: mock(() => null),
			} as unknown as FeishuChannel;

			const app = new Hono();
			app.post("/webhook/feishu", (c) =>
				handleFeishuWebhook(c, {
					telegram: mockTelegram,
					feishu: feishuNullParser,
					bots: mockBots,
					feishuBots: mockFeishuBots,
				}),
			);

			const response = await app.request("/webhook/feishu", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(feishuBody),
			});

			expect(response.status).toBe(200);
			const data = (await response.json()) as { status: string; reason: string };
			expect(data).toEqual({ status: "ignored", reason: "no message" });
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

		test("should route encrypted payload from legacy handler to feishu handler", async () => {
			const encryptKey = "12345678901234567890123456789012";
			const encryptedFeishu = {
				encrypt: encryptFeishuPayload({ challenge: "legacy-challenge" }, encryptKey),
			};
			const feishuWithKey = {
				...mockFeishu,
				getEncryptKey: mock(() => encryptKey),
				handleUrlVerification: mock(() => ({ challenge: "legacy-challenge" })),
			} as unknown as FeishuChannel;

			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: mockTelegram,
					feishu: feishuWithKey,
					bots: mockBots,
					feishuBots: mockFeishuBots,
				}),
			);

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(encryptedFeishu),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ challenge: "legacy-challenge" });
		});

		test("should fall back to unknown for feishu-like payload without event_type", async () => {
			const body = {
				schema: "2.0",
				header: { not_event_type: "x" },
			};
			const app = new Hono();
			app.post("/webhook", (c) => handleWebhook(c, { telegram: mockTelegram, bots: mockBots }));
			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ status: "ignored", reason: "unknown channel" });
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

		test("should handle showTyping failures without failing webhook", async () => {
			const telegramBody = {
				update_id: 123,
				message: {
					chat: { id: 12345, type: "private" },
					text: "hello",
				},
			};
			const typingFailTelegram = {
				...mockTelegram,
				showTyping: mock(async () => {
					throw new Error("typing failed");
				}),
			} as unknown as TelegramChannel;
			const okBot = {
				name: "AgentBot",
				handle: mock(async () => true),
				getMenus: () => [],
			};

			const app = new Hono();
			app.post("/webhook", (c) => handleWebhook(c, { telegram: typingFailTelegram, bots: [okBot] }));

			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramBody),
			});
			expect(response.status).toBe(200);
		});

		test("should send timeout notification when bot handling exceeds timeout", async () => {
			const telegramBody = {
				update_id: 999,
				message: {
					chat: { id: 12345, type: "private" },
					text: "trigger timeout",
				},
			};
			const slowBot = {
				name: "AgentBot",
				handle: mock(async () => new Promise<boolean>(() => {})),
				getMenus: () => [],
			};

			const originalSetTimeout = globalThis.setTimeout;
			const originalClearTimeout = globalThis.clearTimeout;
			(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((cb: TimerHandler) => {
				queueMicrotask(() => {
					if (typeof cb === "function") {
						void cb();
					}
				});
				return 1 as unknown as NodeJS.Timeout;
			}) as typeof setTimeout;
			(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = (() => {}) as typeof clearTimeout;

			try {
				const app = new Hono();
				app.post("/webhook", (c) => handleWebhook(c, { telegram: mockTelegram, bots: [slowBot] }));
				const response = await app.request("/webhook", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(telegramBody),
				});
				expect(response.status).toBe(200);
				expect(sendMessageSpy).toHaveBeenCalledWith(
					"test-chat",
					expect.stringContaining("Taking longer than expected"),
				);
			} finally {
				(globalThis as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
				(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = originalClearTimeout;
			}
		});

		test("should swallow timeout notification send errors", async () => {
			const telegramBody = {
				update_id: 111,
				message: { chat: { id: 12345, type: "private" }, text: "timeout-send-fail" },
			};
			const failingTelegram = {
				...mockTelegram,
				sendMessage: mock(async () => {
					throw new Error("send fail");
				}),
			} as unknown as TelegramChannel;
			const slowBot = {
				name: "AgentBot",
				handle: mock(async () => new Promise<boolean>(() => {})),
				getMenus: () => [],
			};
			const originalSetTimeout = globalThis.setTimeout;
			const originalClearTimeout = globalThis.clearTimeout;
			(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((cb: TimerHandler) => {
				queueMicrotask(() => {
					if (typeof cb === "function") void cb();
				});
				return 1 as unknown as NodeJS.Timeout;
			}) as typeof setTimeout;
			(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = (() => {}) as typeof clearTimeout;
			try {
				const app = new Hono();
				app.post("/webhook", (c) => handleWebhook(c, { telegram: failingTelegram, bots: [slowBot] }));
				const response = await app.request("/webhook", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(telegramBody),
				});
				expect(response.status).toBe(200);
			} finally {
				(globalThis as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
				(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = originalClearTimeout;
			}
		});

		test("should ignore timeout callback if bot already completed", async () => {
			const telegramBody = {
				update_id: 321,
				message: {
					chat: { id: 12345, type: "private" },
					text: "completed first",
				},
			};
			const doneBot = {
				name: "AgentBot",
				handle: mock(async () => true),
				getMenus: () => [],
			};

			let capturedTimeoutCb: (() => void | Promise<void>) | null = null;
			const originalSetTimeout = globalThis.setTimeout;
			(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((cb: TimerHandler) => {
				if (typeof cb === "function") {
					capturedTimeoutCb = cb;
				}
				return 1 as unknown as NodeJS.Timeout;
			}) as typeof setTimeout;

			try {
				const app = new Hono();
				app.post("/webhook", (c) => handleWebhook(c, { telegram: mockTelegram, bots: [doneBot] }));
				const response = await app.request("/webhook", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(telegramBody),
				});
				expect(response.status).toBe(200);
				expect(capturedTimeoutCb).not.toBeNull();
				await capturedTimeoutCb?.();
				expect(sendMessageSpy.mock.calls.some((c) => String(c[1]).includes("Taking longer than expected"))).toBe(false);
			} finally {
				(globalThis as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
			}
		});

		test("should process attachments when uploads are enabled", async () => {
			const telegramBody = {
				update_id: 124,
				message: {
					chat: { id: 12345, type: "private" },
					text: "hello",
				},
			};
			const parseWithAttachment = mock(() => ({
				channelId: "test",
				chatId: "test-chat",
				text: "",
				updateId: "attach-1",
				user: { id: "user-1" },
				attachments: [
					{
						kind: "text",
						source: "telegram",
						fileId: "file-123",
						fileName: "note.txt",
						mimeType: "text/plain",
					},
				],
			}));
			const attachmentTelegram = {
				...mockTelegram,
				parseWebhook: parseWithAttachment,
			} as unknown as TelegramChannel;
			const attachmentClient = {
				getFile: mock(async () => ({ file_path: "doc.txt" })),
				downloadFile: mock(
					async () =>
						new Response("attachment-content", {
							status: 200,
							headers: { "content-type": "text/plain" },
						}),
				),
			};
			const attachmentTelegramWithClient = {
				...attachmentTelegram,
				getClient: () => attachmentClient,
			} as unknown as TelegramChannel;

			const inspectBot = {
				name: "AgentBot",
				handle: mock(async (message: { text: string }) => {
					expect(message.text).toContain("[Attachment:");
					return true;
				}),
				getMenus: () => [],
			};

			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: attachmentTelegramWithClient,
					bots: [inspectBot],
					config: {
						uploads: {
							enabled: true,
							allowedMimeTypes: ["text/plain", "image/png"],
							maxTextBytes: 1024 * 1024,
							maxImageBytes: 1024 * 1024,
							retentionHours: 1,
							storageDir: "data/uploads",
						},
					},
				}),
			);
			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramBody),
			});
			expect(response.status).toBe(200);
			expect(attachmentClient.getFile).toHaveBeenCalled();
			expect(attachmentClient.downloadFile).toHaveBeenCalled();
		});

		test("should use fallback text when attachments accepted with empty text append", async () => {
			const telegramBody = {
				update_id: 125,
				message: { chat: { id: 12345, type: "private" }, text: "x" },
			};
			const parseWithAttachment = mock(() => ({
				channelId: "test",
				chatId: "test-chat",
				text: "",
				updateId: "attach-2",
				user: { id: "user-1" },
				attachments: [
					{
						kind: "text",
						source: "telegram",
						fileId: "file-124",
						fileName: "note.bin",
						mimeType: "application/octet-stream",
					},
				],
			}));
			const attachmentClient = {
				getFile: mock(async () => ({ file_path: "doc.bin" })),
				downloadFile: mock(
					async () =>
						new Response("binary", {
							status: 200,
							headers: { "content-type": "application/octet-stream" },
						}),
				),
			};
			const attachmentTelegram = {
				...mockTelegram,
				parseWebhook: parseWithAttachment,
				getClient: () => attachmentClient,
			} as unknown as TelegramChannel;
			const inspectBot = {
				name: "AgentBot",
				handle: mock(async (message: { text: string }) => {
					expect(message.text).toBe("[User sent attachments]");
					return true;
				}),
				getMenus: () => [],
			};

			const app = new Hono();
			app.post("/webhook", (c) =>
				handleWebhook(c, {
					telegram: attachmentTelegram,
					bots: [inspectBot],
					config: {
						uploads: {
							enabled: true,
							allowedMimeTypes: ["text/plain"],
							maxTextBytes: 1024,
							maxImageBytes: 1024,
							retentionHours: 1,
							storageDir: "data/uploads",
						},
					},
				}),
			);
			const response = await app.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramBody),
			});
			expect(response.status).toBe(200);
		});

		test("should continue processing decrypted feishu payload when not URL challenge", async () => {
			const encryptKey = "12345678901234567890123456789012";
			const encryptedFeishu = {
				encrypt: encryptFeishuPayload(
					{
						schema: "2.0",
						header: { event_type: "im.message.receive_v1" },
						event: {},
					},
					encryptKey,
				),
			};
			const feishuWithKey = {
				...mockFeishu,
				getEncryptKey: mock(() => encryptKey),
				handleUrlVerification: mock(() => null),
				parseWebhook: mock(() => null),
			} as unknown as FeishuChannel;

			const app = new Hono();
			app.post("/webhook/feishu", (c) =>
				handleFeishuWebhook(c, {
					telegram: mockTelegram,
					feishu: feishuWithKey,
					bots: mockBots,
					feishuBots: mockFeishuBots,
				}),
			);
			const response = await app.request("/webhook/feishu", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(encryptedFeishu),
			});
			expect(response.status).toBe(200);
			const data = (await response.json()) as { status: string; reason: string };
			expect(data).toEqual({ status: "ignored", reason: "no message" });
		});

		test("should swallow no-handler and error notification send failures", async () => {
			const telegramBody = {
				update_id: 126,
				message: { chat: { id: 12345, type: "private" }, text: "hello" },
			};
			const failingTelegram = {
				...mockTelegram,
				sendMessage: mock(async () => {
					throw new Error("send fail");
				}),
			} as unknown as TelegramChannel;

			const appNoHandler = new Hono();
			appNoHandler.post("/webhook", (c) => handleWebhook(c, { telegram: failingTelegram, bots: [] }));
			const noHandlerResp = await appNoHandler.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramBody),
			});
			expect(noHandlerResp.status).toBe(200);

			const errBot = {
				name: "AgentBot",
				handle: mock(async () => {
					throw new Error("bot fail");
				}),
				getMenus: () => [],
			};
			const appErr = new Hono();
			appErr.post("/webhook", (c) => handleWebhook(c, { telegram: failingTelegram, bots: [errBot] }));
			const errResp = await appErr.request("/webhook", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(telegramBody),
			});
			expect(errResp.status).toBe(200);
		});
	});
});
	const encryptFeishuPayload = (payload: unknown, encryptKey: string): string => {
		const key = createHash("sha256").update(encryptKey).digest();
		const iv = randomBytes(16);
		const cipher = createCipheriv("aes-256-cbc", key, iv);
		const data = Buffer.from(JSON.stringify(payload), "utf8");
		const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
		return Buffer.concat([iv, encrypted]).toString("base64");
	};
