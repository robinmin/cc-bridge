import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { FeishuChannel, decryptFeishuWebhook } from "@/gateway/channels/feishu";

// Mock fetch globally
const originalFetch = globalThis.fetch;

describe("FeishuChannel", () => {
	let feishu: FeishuChannel;
	const testAppId = "cli_test123456";
	const testAppSecret = "test-secret-12345";
	let mockCalls: Array<{ url: string; body?: unknown; headers?: Record<string, string> }> = [];

	beforeEach(() => {
		mockCalls = [];
		// @ts-expect-error - mock fetch
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const body = init?.body ? JSON.parse(init.body as string) : undefined;
			const headers = init?.headers as Record<string, string> | undefined;

			mockCalls.push({ url, body, headers });

			if (url.includes("tenant_access_token")) {
				return {
					ok: true,
					json: async () => ({ code: 0, tenant_access_token: "test-token-123", expire: 7200 }),
					text: async () => "OK",
				} as Response;
			}

			if (url.includes("messages")) {
				return {
					ok: true,
					json: async () => ({ code: 0, msg: "success" }),
					text: async () => "OK",
				} as Response;
			}

			return {
				ok: false,
				json: async () => ({ code: -1, msg: "Test error" }),
				text: async () => "Error",
			} as Response;
		};

		feishu = new FeishuChannel(testAppId, testAppSecret);
	});

	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	describe("sendMessage", () => {
		test("should send message to user", async () => {
			await feishu.sendMessage("oc_test12345", "Hello test");

			expect(mockCalls.length).toBeGreaterThanOrEqual(1);
			const sendMessageCall = mockCalls.find((call) => call.url.includes("messages"));
			expect(sendMessageCall).toBeDefined();
		});

		test("should handle numeric chat IDs", async () => {
			await feishu.sendMessage(12345, "Test");

			expect(mockCalls.length).toBeGreaterThanOrEqual(1);
			const sendMessageCall = mockCalls.find((call) => call.url.includes("messages"));
			expect(sendMessageCall).toBeDefined();
		});

		test("should include authorization header", async () => {
			await feishu.sendMessage("oc_test12345", "Test");

			const sendMessageCall = mockCalls.find((call) => call.url.includes("messages"));
			expect(sendMessageCall?.headers?.["Authorization"]).toContain("Bearer");
		});

		test("should include proper message content format", async () => {
			await feishu.sendMessage("oc_test12345", "Test message");

			const sendMessageCall = mockCalls.find((call) => call.url.includes("messages"));
			expect(sendMessageCall?.body?.msg_type).toBe("text");
			expect(sendMessageCall?.body?.receive_id).toBe("oc_test12345");
		});

		test("should reuse cached token across sends", async () => {
			await feishu.sendMessage("oc_test12345", "one");
			await feishu.sendMessage("oc_test12345", "two");
			const tokenCalls = mockCalls.filter((call) => call.url.includes("tenant_access_token"));
			expect(tokenCalls.length).toBe(1);
		});
	});

	describe("showTyping", () => {
		test("should handle typing indicator (no-op for Feishu)", async () => {
			// Feishu doesn't support typing indicators, so this should complete without error
			await feishu.showTyping("oc_test12345");

			// Test passes if we get here without throwing
			expect(true).toBe(true);
		});
	});

	describe("parseWebhook", () => {
		test("should parse valid message webhook", () => {
			const webhookBody = {
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
							union_id: "on_test456",
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

			const message = feishu.parseWebhook(webhookBody);

			expect(message).not.toBeNull();
			expect(message?.chatId).toBe("oc_test12345");
			expect(message?.text).toBe("Hello bot");
			expect(message?.updateId).toBe("event_test_123");
			expect(message?.user?.id).toBe("ou_test123");
			expect(message?.channelId).toBe("feishu");
		});

		test("should parse post format messages", () => {
			const webhookBody = {
				schema: "2.0",
				header: {
					event_id: "event_test_124",
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
						content: JSON.stringify({
							post: {
								zh_cn: {
									content: [
										[
											{
												tag: "text",
												text: "Post message content",
											},
										],
									],
								},
							},
						}),
						message_type: "post",
					},
				},
			};

			const message = feishu.parseWebhook(webhookBody);

			expect(message).not.toBeNull();
			expect(message?.text).toBe("Post message content");
		});

		test("should return null for non-message events", () => {
			const webhookBody = {
				schema: "2.0",
				header: {
					event_id: "event_test_125",
					timestamp: "1640000000000",
					event_type: "im.message.status_read_v1",
					tenant_key: "test_tenant",
					app_id: "cli_test123456",
				},
				event: {},
			};

			const message = feishu.parseWebhook(webhookBody);
			expect(message).toBeNull();
		});

		test("should return null for empty webhook body", () => {
			const message = feishu.parseWebhook(null);
			expect(message).toBeNull();
		});

		test("should return null for webhook without schema", () => {
			const webhookBody = {
				update_id: 123,
				message: {
					message_id: 456,
				},
			};

			const message = feishu.parseWebhook(webhookBody);
			expect(message).toBeNull();
		});

		test("should handle missing optional fields", () => {
			const webhookBody = {
				schema: "2.0",
				header: {
					event_id: "event_test_126",
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
						chat_type: "private",
						content: '{"text":"Test"}',
						message_type: "text",
					},
				},
			};

			const message = feishu.parseWebhook(webhookBody);

			expect(message).not.toBeNull();
			expect(message?.user?.id).toBe("ou_test123");
			expect(message?.text).toBe("Test");
		});

		test("should handle invalid content JSON gracefully", () => {
			const webhookBody = {
				schema: "2.0",
				header: {
					event_id: "event_test_127",
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
						chat_type: "private",
						content: "invalid-json{",
						message_type: "text",
					},
				},
			};

			const message = feishu.parseWebhook(webhookBody);

			// Should still parse, using content as-is
			expect(message).not.toBeNull();
			expect(message?.text).toBe("invalid-json{");
		});

		test("should parse image attachment", () => {
			const webhookBody = {
				schema: "2.0",
				header: {
					event_id: "event_img",
					timestamp: "1640000000000",
					event_type: "im.message.receive_v1",
					tenant_key: "test_tenant",
					app_id: "cli_test123456",
				},
				event: {
					sender: {
						sender_id: { open_id: "ou_test123" },
						sender_type: "user",
						tenant_key: "test_tenant",
					},
					message: {
						message_id: "om_image",
						chat_id: "oc_test12345",
						chat_type: "group",
						content: '{"image_key":"img-key","image_size":123}',
						message_type: "image",
					},
				},
			};
			const message = feishu.parseWebhook(webhookBody);
			expect(message?.attachments?.[0]?.fileId).toBe("img-key");
			expect(message?.attachments?.[0]?.remoteType).toBe("image");
		});

		test("should parse file attachment", () => {
			const webhookBody = {
				schema: "2.0",
				header: {
					event_id: "event_file",
					timestamp: "1640000000000",
					event_type: "im.message.receive_v1",
					tenant_key: "test_tenant",
					app_id: "cli_test123456",
				},
				event: {
					sender: {
						sender_id: { open_id: "ou_test123" },
						sender_type: "user",
						tenant_key: "test_tenant",
					},
					message: {
						message_id: "om_file",
						chat_id: "oc_test12345",
						chat_type: "group",
						content: '{"file_key":"f-key","file_name":"a.txt","mime_type":"text/plain","file_size":55}',
						message_type: "file",
					},
				},
			};
			const message = feishu.parseWebhook(webhookBody);
			expect(message?.attachments?.[0]?.fileId).toBe("f-key");
			expect(message?.attachments?.[0]?.remoteType).toBe("file");
		});

		test("should return null on unexpected payload shape", () => {
			const message = feishu.parseWebhook({
				schema: "2.0",
				header: { event_id: "bad", event_type: "im.message.receive_v1" },
				event: {
					message: { content: "{}", chat_id: "c", message_type: "text", message_id: "m", chat_type: "p" },
				},
			});
			expect(message).toBeNull();
		});
	});

	describe("getStatus", () => {
		test("should return channel status", async () => {
			const status = await feishu.getStatus();

			expect(status).toBeDefined();
			expect(status).toHaveProperty("appId", testAppId);
			expect(status).toHaveProperty("domain", "feishu");
		});
	});

	describe("domain configuration", () => {
		test("should use feishu domain by default", async () => {
			const channel = new FeishuChannel(testAppId, testAppSecret);
			const status = await channel.getStatus();

			expect(status).toHaveProperty("domain", "feishu");
		});

		test("should use lark domain when specified", async () => {
			const channel = new FeishuChannel(testAppId, testAppSecret, "lark");
			const status = await channel.getStatus();

			expect(status).toHaveProperty("domain", "lark");
		});

		test("should expose client and encrypt key", () => {
			const channel = new FeishuChannel(testAppId, testAppSecret, "feishu", "enc-key");
			expect(channel.getClient()).toBeDefined();
			expect(channel.getEncryptKey()).toBe("enc-key");
		});
	});

	describe("client error and resource paths", () => {
		test("should throw when token endpoint returns non-ok", async () => {
			// @ts-expect-error - mock fetch
			globalThis.fetch = async (input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.includes("tenant_access_token")) {
					return {
						ok: false,
						text: async () => "token-down",
					} as Response;
				}
				return {
					ok: true,
					json: async () => ({ code: 0, msg: "ok" }),
					text: async () => "OK",
				} as Response;
			};

			await expect(feishu.sendMessage("oc_test12345", "x")).rejects.toThrow(
				"Feishu API error (getTenantAccessToken): token-down",
			);
		});

		test("should throw when token payload has non-zero code", async () => {
			// @ts-expect-error - mock fetch
			globalThis.fetch = async () =>
				({
					ok: true,
					json: async () => ({ code: 999, msg: "bad token" }),
					text: async () => "OK",
				}) as Response;

			await expect(feishu.sendMessage("oc_test12345", "x")).rejects.toThrow("Feishu API error: bad token (code: 999)");
		});

		test("should throw when sendMessage endpoint returns non-ok", async () => {
			// @ts-expect-error - mock fetch
			globalThis.fetch = async (input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.includes("tenant_access_token")) {
					return {
						ok: true,
						json: async () => ({ code: 0, tenant_access_token: "t", expire: 7200 }),
						text: async () => "OK",
					} as Response;
				}
				return {
					ok: false,
					text: async () => "send-down",
				} as Response;
			};
			await expect(feishu.sendMessage("oc_test12345", "x")).rejects.toThrow("Feishu API error (sendMessage): send-down");
		});

		test("should throw when sendMessage payload code is non-zero", async () => {
			// @ts-expect-error - mock fetch
			globalThis.fetch = async (input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.includes("tenant_access_token")) {
					return {
						ok: true,
						json: async () => ({ code: 0, tenant_access_token: "t", expire: 7200 }),
						text: async () => "OK",
					} as Response;
				}
				return {
					ok: true,
					json: async () => ({ code: 99, msg: "send bad" }),
					text: async () => "OK",
				} as Response;
			};
			await expect(feishu.sendMessage("oc_test12345", "x")).rejects.toThrow("Feishu API error: send bad (code: 99)");
		});

		test("should download resource with bearer token", async () => {
			// @ts-expect-error - mock fetch
			globalThis.fetch = async (input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.includes("tenant_access_token")) {
					return {
						ok: true,
						json: async () => ({ code: 0, tenant_access_token: "token-r", expire: 7200 }),
						text: async () => "OK",
					} as Response;
				}
				return {
					ok: true,
					text: async () => "file-content",
				} as Response;
			};

			const response = await feishu.getClient().downloadResource("m1", "f1", "file");
			expect(response.ok).toBe(true);
		});
	});
});

describe("Feishu decrypt", () => {
	function encryptPayload(payload: unknown, keyText: string): string {
		const key = createHash("sha256").update(keyText).digest();
		const iv = randomBytes(16);
		const cipher = createCipheriv("aes-256-cbc", key, iv);
		const body = Buffer.from(JSON.stringify(payload), "utf8");
		const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
		return Buffer.concat([iv, encrypted]).toString("base64");
	}

	test("should decrypt encrypted payload", () => {
		const encrypted = encryptPayload({ challenge: "abc123" }, "encrypt-key");
		const result = decryptFeishuWebhook(encrypted, "encrypt-key") as { challenge: string };
		expect(result.challenge).toBe("abc123");
	});

	test("should reject short encrypted payload", () => {
		expect(() => decryptFeishuWebhook("abcd", "encrypt-key")).toThrow("Encrypted payload too short");
	});

	test("should throw on invalid decrypted json", () => {
		const encrypted = encryptPayload("plain-string", "encrypt-key");
		expect(() => decryptFeishuWebhook(encrypted, "wrong-key")).toThrow();
	});
});
