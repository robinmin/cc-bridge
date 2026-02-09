import { beforeEach, describe, expect, test } from "bun:test";
import { FeishuChannel, isEncryptedFeishuWebhook } from "@/gateway/channels/feishu";

describe("Feishu Encryption - URL Verification", () => {
	describe("isEncryptedFeishuWebhook", () => {
		test("should return true for encrypted webhook with encrypt field", () => {
			const encryptedWebhook = {
				encrypt: "base64-encoded-string",
			};
			expect(isEncryptedFeishuWebhook(encryptedWebhook)).toBe(true);
		});

		test("should return false for non-encrypted Feishu webhook", () => {
			const normalWebhook = {
				schema: "2.0",
				header: {
					event_id: "test",
					event_type: "im.message.receive_v1",
				},
			};
			expect(isEncryptedFeishuWebhook(normalWebhook)).toBe(false);
		});

		test("should return false for Telegram webhook", () => {
			const telegramWebhook = {
				update_id: 123,
			};
			expect(isEncryptedFeishuWebhook(telegramWebhook)).toBe(false);
		});

		test("should return false for null/undefined", () => {
			expect(isEncryptedFeishuWebhook(null)).toBe(false);
			expect(isEncryptedFeishuWebhook(undefined)).toBe(false);
		});

		test("should return false for non-object values", () => {
			expect(isEncryptedFeishuWebhook("string")).toBe(false);
			expect(isEncryptedFeishuWebhook(123)).toBe(false);
			expect(isEncryptedFeishuWebhook([])).toBe(false);
		});
	});

	describe("FeishuChannel - URL Verification", () => {
		let feishuChannel: FeishuChannel;

		beforeEach(() => {
			feishuChannel = new FeishuChannel("test-app-id", "test-app-secret", "lark", "test-encrypt-key");
		});

		test("should get encrypt key from channel", () => {
			expect(feishuChannel.getEncryptKey()).toBe("test-encrypt-key");
		});

		test("should return undefined when no encrypt key is set", () => {
			const channelWithoutKey = new FeishuChannel("test-app-id", "test-app-secret");
			expect(channelWithoutKey.getEncryptKey()).toBeUndefined();
		});

		test("should handle URL verification challenge", () => {
			const decryptedPayload = {
				challenge: "test-challenge-string",
			};

			const result = feishuChannel.handleUrlVerification(decryptedPayload);

			expect(result).not.toBeNull();
			expect(result?.challenge).toBe("test-challenge-string");
		});

		test("should return null for non-challenge payload", () => {
			const normalPayload = {
				schema: "2.0",
				header: {
					event_id: "test",
					event_type: "im.message.receive_v1",
				},
			};

			const result = feishuChannel.handleUrlVerification(normalPayload);

			expect(result).toBeNull();
		});

		test("should return null for empty payload", () => {
			const result = feishuChannel.handleUrlVerification({});
			expect(result).toBeNull();
		});
	});
});
