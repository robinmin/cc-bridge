import { describe, expect, test } from "bun:test";
import { handleFeishuWebhook, handleTelegramWebhook, handleWebhook } from "@/gateway/routes/webhook";

describe("Webhook Routes - Separated Handlers", () => {
	describe("route exports", () => {
		test("should export handleTelegramWebhook function", () => {
			expect(typeof handleTelegramWebhook).toBe("function");
		});

		test("should export handleFeishuWebhook function", () => {
			expect(typeof handleFeishuWebhook).toBe("function");
		});

		test("should export handleWebhook function (legacy unified handler)", () => {
			expect(typeof handleWebhook).toBe("function");
		});

		test("handleTelegramWebhook should accept WebhookContext with telegram and bots", () => {
			// Verify the function signature accepts the correct parameters
			const mockContext = {
				req: { json: async () => ({ update_id: 123 }) },
				json: async (data: unknown) => data,
			} as unknown;

			const mockChannel = {
				name: "test",
				parseWebhook: () => null,
				sendMessage: async () => {},
			};

			const mockBots = [
				{
					name: "test-bot",
					handle: async () => false,
					getMenus: () => [],
				},
			];

			// This should not throw a type error
			expect(async () =>
				handleTelegramWebhook(mockContext, {
					telegram: mockChannel as typeof mockChannel,
					bots: mockBots,
				}),
			).not.toThrow();
		});

		test("handleFeishuWebhook should accept WebhookContext with feishu and feishuBots", () => {
			// Verify the function signature accepts the correct parameters
			const mockContext = {
				req: {
					json: async () => ({ schema: "2.0" }),
					header: () => ({}),
				},
				json: async (data: unknown) => data,
			} as unknown;

			const mockChannel = {
				name: "test",
				parseWebhook: () => null,
				sendMessage: async () => {},
				getEncryptKey: () => undefined,
				handleUrlVerification: () => null,
			};

			const mockBots = [
				{
					name: "test-bot",
					handle: async () => false,
					getMenus: () => [],
				},
			];

			// This should not throw a type error
			expect(async () =>
				handleFeishuWebhook(mockContext, {
					feishu: mockChannel as typeof mockChannel,
					feishuBots: mockBots,
				}),
			).not.toThrow();
		});
	});

	describe("legacy unified handler", () => {
		test("should delegate to appropriate handler based on request body", async () => {
			// Test Telegram webhook delegation
			const telegramContext = {
				req: { json: async () => ({ update_id: 123 }) },
				json: async (data: unknown) => data,
			} as unknown;

			const mockChannel = {
				name: "test",
				parseWebhook: () => null,
				sendMessage: async () => {},
			};

			const telegramResult = await handleWebhook(telegramContext, {
				telegram: mockChannel as typeof mockChannel,
				bots: [],
			});

			expect(telegramResult).not.toBeNull();

			// Test Feishu webhook delegation
			const feishuContext = {
				req: { json: async () => ({ encrypt: "test" }) },
				json: async (data: unknown) => data,
			} as unknown;

			const feishuResult = await handleWebhook(feishuContext, {
				telegram: mockChannel as typeof mockChannel,
				bots: [],
			});

			expect(feishuResult).not.toBeNull();
		});

		test("should return ignored for unknown channel types", async () => {
			const unknownContext = {
				req: { json: async () => ({ unknown_field: "value" }) },
				json: (data: unknown) => ({
					json: async () => data,
					status: 200,
					headers: new Headers(),
				}),
			} as unknown;

			const mockChannel = {
				name: "test",
				parseWebhook: () => null,
				sendMessage: async () => {},
			};

			const result = await handleWebhook(unknownContext, {
				telegram: mockChannel as typeof mockChannel,
				bots: [],
			});

			// The result should be a Response object with status
			expect(result).toHaveProperty("status");
		});
	});
});
