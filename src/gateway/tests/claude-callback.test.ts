import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { TelegramChannel } from "@/gateway/channels/telegram";
import { handleCallbackHealth, handleClaudeCallback } from "@/gateway/routes/claude-callback";
import type { ResponseFile } from "@/gateway/schemas/callback";
import { IdempotencyService } from "@/gateway/services/IdempotencyService";
import { RateLimitService } from "@/gateway/services/RateLimitService";
import { ResponseFileReader } from "@/gateway/services/ResponseFileReader";

// Mock TelegramChannel that implements the interface
class MockTelegramChannel extends TelegramChannel {
	name = "mock-telegram" as const;
	calls: Array<{
		chatId: string | number;
		text: string;
		options?: { parseMode?: string };
	}> = [];

	constructor() {
		super("mock-token");
	}

	async sendMessage(chatId: string | number, text: string, options?: unknown): Promise<void> {
		this.calls.push({ chatId, text, options: options as { parseMode?: string } | undefined });
	}

	async showTyping(): Promise<void> {
		// No-op for mock
	}

	reset() {
		this.calls = [];
	}
}

describe("handleClaudeCallback (Hardened)", () => {
	let app: Hono;
	let mockTelegram: MockTelegramChannel;
	let idempotencyService: IdempotencyService;
	let rateLimitService: RateLimitService;
	let testIpcDir: string;

	beforeEach(async () => {
		mockTelegram = new MockTelegramChannel();
		idempotencyService = new IdempotencyService({ maxSize: 1000 });
		rateLimitService = new RateLimitService({
			workspaceLimit: 100,
			ipLimit: 200,
		});

		// Create test IPC directory
		testIpcDir = `/tmp/test-callback-${Date.now()}`;
		await mkdir(path.join(testIpcDir, "test-workspace", "responses"), {
			recursive: true,
		});

		const responseFileReader = new ResponseFileReader({
			ipcBasePath: testIpcDir,
			maxFileSize: 1024 * 100, // 100KB
		});

		app = new Hono();
		app.post("/claude-callback", (c) =>
			handleClaudeCallback(c, {
				telegram: mockTelegram,
				idempotencyService,
				rateLimitService,
				responseFileReader,
			}),
		);
		app.get("/callback-health", (c) =>
			handleCallbackHealth(c, {
				telegram: mockTelegram,
				idempotencyService,
				rateLimitService,
				responseFileReader,
			}),
		);
	});

	afterEach(async () => {
		mockTelegram.reset();
		idempotencyService.stopCleanup();
		rateLimitService.stopCleanup();
		await rm(testIpcDir, { recursive: true, force: true });
	});

	describe("Valid Callback", () => {
		test("should accept valid callback and return 202", async () => {
			const mockResponse: ResponseFile = {
				requestId: "req-001",
				chatId: "123",
				workspace: "test-workspace",
				timestamp: new Date().toISOString(),
				output: "Hello from Claude!",
				exitCode: 0,
			};

			await writeFile(
				path.join(testIpcDir, "test-workspace", "responses", "req-001.json"),
				JSON.stringify(mockResponse),
			);

			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "req-001",
					chatId: "123",
					workspace: "test-workspace",
				}),
			});

			expect(response.status).toBe(202);
			expect(await response.json()).toEqual({ status: "accepted" });
			expect(response.headers.get("X-Request-Id")).toBe("req-001");
		});

		test("should accept negative chatId for Telegram group chats", async () => {
			const mockResponse: ResponseFile = {
				requestId: "req-neg-001",
				chatId: -123456789,
				workspace: "test-workspace",
				timestamp: new Date().toISOString(),
				output: "Group chat response",
				exitCode: 0,
			};

			await writeFile(
				path.join(testIpcDir, "test-workspace", "responses", "req-neg-001.json"),
				JSON.stringify(mockResponse),
			);

			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "req-neg-001",
					chatId: -123456789,
					workspace: "test-workspace",
				}),
			});

			expect(response.status).toBe(202);
			expect(await response.json()).toEqual({ status: "accepted" });
		});

		test("should process callback asynchronously", async () => {
			const mockResponse: ResponseFile = {
				requestId: "req-002",
				chatId: "456",
				workspace: "test-workspace",
				timestamp: new Date().toISOString(),
				output: "Async response!",
				exitCode: 0,
			};

			await writeFile(
				path.join(testIpcDir, "test-workspace", "responses", "req-002.json"),
				JSON.stringify(mockResponse),
			);

			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "req-002",
					chatId: "456",
					workspace: "test-workspace",
				}),
			});

			// Response returns immediately (202)
			expect(response.status).toBe(202);

			// Wait for async processing
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify async processing happened
			expect(mockTelegram.calls.length).toBe(1);
			expect(mockTelegram.calls[0].chatId).toBe("456");
			expect(mockTelegram.calls[0].text).toBe("Async response!");
		});
	});

	describe("Request Validation", () => {
		test("should reject missing requestId", async () => {
			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chatId: "123",
					workspace: "test-workspace",
				}),
			});

			expect(response.status).toBe(400);
			const json = await response.json();
			expect(json.error).toBe("Validation failed");
		});

		test("should reject missing chatId", async () => {
			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "req-001",
					workspace: "test-workspace",
				}),
			});

			expect(response.status).toBe(400);
		});

		test("should reject missing workspace", async () => {
			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "req-001",
					chatId: "123",
				}),
			});

			expect(response.status).toBe(400);
		});

		test("should reject invalid requestId format", async () => {
			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "../../../etc/passwd",
					chatId: "123",
					workspace: "test-workspace",
				}),
			});

			expect(response.status).toBe(400);
			const json = await response.json();
			expect(json.error).toBe("Validation failed");
		});

		test("should reject invalid JSON", async () => {
			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "invalid json{",
			});

			expect(response.status).toBe(400);
			const json = await response.json();
			expect(json.error).toBe("Invalid JSON");
		});
	});

	describe("Idempotency", () => {
		test("should detect duplicate callbacks", async () => {
			const mockResponse: ResponseFile = {
				requestId: "req-duplicate",
				chatId: "123",
				workspace: "test-workspace",
				timestamp: new Date().toISOString(),
				output: "Duplicate test",
				exitCode: 0,
			};

			await writeFile(
				path.join(testIpcDir, "test-workspace", "responses", "req-duplicate.json"),
				JSON.stringify(mockResponse),
			);

			const payload = {
				requestId: "req-duplicate",
				chatId: "123",
				workspace: "test-workspace",
			};

			// First request
			const response1 = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			// Wait a bit for idempotency to register
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Second request (duplicate)
			const response2 = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			expect(response1.status).toBe(202);
			expect(response2.status).toBe(200);

			const json2 = await response2.json();
			expect(json2.success).toBe(true);
			expect(json2.duplicate).toBe(true);
		});
	});

	describe("File Read Errors", () => {
		test("should return 404 for missing response file", async () => {
			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "nonexistent",
					chatId: "123",
					workspace: "test-workspace",
				}),
			});

			expect(response.status).toBe(404);
			const json = await response.json();
			expect(json.error).toBe("Response file not found");
		});

		test("should return 422 for corrupted JSON file", async () => {
			await writeFile(path.join(testIpcDir, "test-workspace", "responses", "corrupted.json"), "not valid json {");

			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "corrupted",
					chatId: "123",
					workspace: "test-workspace",
				}),
			});

			expect(response.status).toBe(422);
			const json = await response.json();
			expect(json.error).toBe("Corrupted response file");
		});

		test("should return 422 for schema validation failure", async () => {
			const invalidResponse = {
				requestId: "invalid-schema",
				// Missing required fields
			};

			await writeFile(
				path.join(testIpcDir, "test-workspace", "responses", "invalid-schema.json"),
				JSON.stringify(invalidResponse),
			);

			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "invalid-schema",
					chatId: "123",
					workspace: "test-workspace",
				}),
			});

			expect(response.status).toBe(422);
			const json = await response.json();
			expect(json.error).toBe("Corrupted response file");
		});
	});

	describe("Output Formatting", () => {
		test("should truncate very long outputs", async () => {
			const longOutput = "x".repeat(5000); // 5000 chars

			const mockResponse: ResponseFile = {
				requestId: "req-long",
				chatId: "123",
				workspace: "test-workspace",
				timestamp: new Date().toISOString(),
				output: longOutput,
				exitCode: 0,
			};

			await writeFile(
				path.join(testIpcDir, "test-workspace", "responses", "req-long.json"),
				JSON.stringify(mockResponse),
			);

			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "req-long",
					chatId: "123",
					workspace: "test-workspace",
				}),
			});

			expect(response.status).toBe(202);

			// Wait for async processing
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify output was truncated
			const sentMessage = mockTelegram.calls[0].text;
			expect(sentMessage.length).toBeLessThan(4096);
			expect(sentMessage).toContain("... (output truncated)");
		});

		test("should include error suffix for non-zero exit codes", async () => {
			const mockResponse: ResponseFile = {
				requestId: "req-error",
				chatId: "123",
				workspace: "test-workspace",
				timestamp: new Date().toISOString(),
				output: "Command failed",
				exitCode: 1,
				error: "Something went wrong",
			};

			await writeFile(
				path.join(testIpcDir, "test-workspace", "responses", "req-error.json"),
				JSON.stringify(mockResponse),
			);

			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "req-error",
					chatId: "123",
					workspace: "test-workspace",
				}),
			});

			expect(response.status).toBe(202);

			// Wait for async processing
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify error message included
			const sentMessage = mockTelegram.calls[0].text;
			expect(sentMessage).toContain("Error: Something went wrong");
			expect(sentMessage).toContain("Exit code: 1");
		});

		test("should include callback metadata when callback failed", async () => {
			const mockResponse: ResponseFile = {
				requestId: "req-callback-fail",
				chatId: "123",
				workspace: "test-workspace",
				timestamp: new Date().toISOString(),
				output: "Output with callback failure",
				exitCode: 0,
				callback: {
					success: false,
					attempts: 3,
					error: "server_error: HTTP 500",
					retryTimestamps: ["2024-01-01T00:00:01Z", "2024-01-01T00:00:03Z", "2024-01-01T00:00:07Z"],
				},
			};

			await writeFile(
				path.join(testIpcDir, "test-workspace", "responses", "req-callback-fail.json"),
				JSON.stringify(mockResponse),
			);

			const response = await app.request("/claude-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "req-callback-fail",
					chatId: "123",
					workspace: "test-workspace",
				}),
			});

			expect(response.status).toBe(202);

			// Wait for async processing
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify callback metadata included
			const sentMessage = mockTelegram.calls[0].text;
			expect(sentMessage).toContain("Callback failed after 3 attempts");
			expect(sentMessage).toContain("server_error: HTTP 500");
		});
	});

	describe("Health Check", () => {
		test("should return service health status", async () => {
			const response = await app.request("/callback-health", {
				method: "GET",
			});

			expect(response.status).toBe(200);

			const json = await response.json();
			expect(json.status).toBe("healthy");
			expect(json.services).toBeDefined();
			expect(json.services.idempotency).toBeDefined();
			expect(json.services.rateLimit).toBeDefined();
		});
	});

	describe("Rate Limiting", () => {
		test("should enforce workspace rate limit", async () => {
			// Create a service with very low limit for testing
			const strictRateLimit = new RateLimitService({
				workspaceLimit: 2,
				ipLimit: 100,
			});

			app.post("/callback-strict", (c) =>
				handleClaudeCallback(c, {
					telegram: mockTelegram,
					idempotencyService,
					rateLimitService: strictRateLimit,
					responseFileReader: new ResponseFileReader({
						ipcBasePath: testIpcDir,
					}),
				}),
			);

			const mockResponse: ResponseFile = {
				requestId: "req-rate-limit",
				chatId: "123",
				workspace: "test-workspace",
				timestamp: new Date().toISOString(),
				output: "Test",
				exitCode: 0,
			};

			// First 2 requests should succeed
			for (let i = 0; i < 2; i++) {
				await writeFile(
					path.join(testIpcDir, "test-workspace", "responses", `req-rate-${i}.json`),
					JSON.stringify({ ...mockResponse, requestId: `req-rate-${i}` }),
				);

				const response = await app.request("/callback-strict", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						requestId: `req-rate-${i}`,
						chatId: "123",
						workspace: "test-workspace",
					}),
				});

				expect(response.status).toBe(202);
			}

			// 3rd request should be rate limited
			await writeFile(
				path.join(testIpcDir, "test-workspace", "responses", "req-rate-2.json"),
				JSON.stringify({ ...mockResponse, requestId: "req-rate-2" }),
			);

			const response = await app.request("/callback-strict", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "req-rate-2",
					chatId: "123",
					workspace: "test-workspace",
				}),
			});

			expect(response.status).toBe(429);
			const json = await response.json();
			expect(json.error).toBe("Rate limit exceeded");
			expect(json.reason).toBe("workspace_limit_exceeded");
			expect(response.headers.get("Retry-After")).toBeDefined();

			strictRateLimit.stopCleanup();
		});
	});
});
