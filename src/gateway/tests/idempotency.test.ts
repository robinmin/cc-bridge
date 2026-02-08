import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IdempotencyService } from "@/gateway/services/IdempotencyService";

describe("IdempotencyService", () => {
	let service: IdempotencyService;

	beforeEach(() => {
		service = new IdempotencyService({
			maxSize: 100,
			ttlMs: 1000,
			cleanupIntervalMs: 10000,
		});
	});

	afterEach(() => {
		service.stopCleanup();
	});

	test("should track and detect duplicate requests", () => {
		const requestId = "test-request-001";
		const chatId = "123456";
		const workspace = "test-workspace";

		// First request should not be duplicate
		expect(service.isDuplicate(requestId)).toBe(false);

		// Mark as processed
		service.markProcessed(requestId, chatId, workspace);

		// Second request should be detected as duplicate
		expect(service.isDuplicate(requestId)).toBe(true);

		// Different request should not be duplicate
		expect(service.isDuplicate("other-request")).toBe(false);
	});

	test("should retrieve processed request details", () => {
		const requestId = "test-request-002";
		const chatId = "789012";
		const workspace = "my-workspace";

		service.markProcessed(requestId, chatId, workspace);

		const processed = service.getProcessed(requestId);
		expect(processed).toBeDefined();
		expect(processed?.requestId).toBe(requestId);
		expect(processed?.chatId).toBe(chatId);
		expect(processed?.workspace).toBe(workspace);
		expect(processed?.timestamp).toBeGreaterThan(0);
	});

	test("should return undefined for non-existent request", () => {
		const processed = service.getProcessed("non-existent");
		expect(processed).toBeUndefined();
	});

	test("should expire old entries", async () => {
		const requestId = "test-request-003";
		service.markProcessed(requestId, "123", "test");

		// Should be duplicate immediately
		expect(service.isDuplicate(requestId)).toBe(true);

		// Wait for expiration (TTL is 1000ms)
		await new Promise((resolve) => setTimeout(resolve, 1100));

		// Should no longer be duplicate after TTL
		expect(service.isDuplicate(requestId)).toBe(false);
	});

	test("should return correct statistics", () => {
		expect(service.getStats().size).toBe(0);

		// Add 5 requests
		for (let i = 0; i < 5; i++) {
			service.markProcessed(`req-${i}`, "123", "test");
		}

		const stats = service.getStats();
		expect(stats.size).toBe(5);
		expect(stats.maxSize).toBe(100);
		expect(stats.hitRate).toBeGreaterThan(0);
	});

	test("should evict oldest entries when at capacity", () => {
		// Fill the cache to capacity
		const maxSize = 100;
		const service2 = new IdempotencyService({
			maxSize,
			ttlMs: 10000,
			cleanupIntervalMs: 10000,
		});

		// Add maxSize + 1 entries
		for (let i = 0; i <= maxSize; i++) {
			service2.markProcessed(`req-${i}`, "123", "test");
		}

		// First entry should have been evicted
		expect(service2.isDuplicate("req-0")).toBe(false);

		// Most recent entry should still exist
		expect(service2.isDuplicate(`req-${maxSize}`)).toBe(true);

		service2.stopCleanup();
	});

	test("should clear all entries", () => {
		service.markProcessed("req-1", "123", "test");
		service.markProcessed("req-2", "456", "test");

		expect(service.getStats().size).toBe(2);

		service.clear();

		expect(service.getStats().size).toBe(0);
		expect(service.isDuplicate("req-1")).toBe(false);
	});

	test("should handle string and number chat IDs", () => {
		const stringChatId = "123456";
		const numberChatId = 789012;

		service.markProcessed("req-string", stringChatId, "test");
		service.markProcessed("req-number", numberChatId, "test");

		const processedString = service.getProcessed("req-string");
		const processedNumber = service.getProcessed("req-number");

		expect(processedString?.chatId).toBe("123456");
		expect(processedNumber?.chatId).toBe(789012);
	});

	test("should track multiple workspaces", () => {
		service.markProcessed("req-1", "123", "workspace-1");
		service.markProcessed("req-2", "456", "workspace-2");
		service.markProcessed("req-3", "789", "workspace-1");

		expect(service.getStats().size).toBe(3);

		const req1 = service.getProcessed("req-1");
		const req2 = service.getProcessed("req-2");
		const req3 = service.getProcessed("req-3");

		expect(req1?.workspace).toBe("workspace-1");
		expect(req2?.workspace).toBe("workspace-2");
		expect(req3?.workspace).toBe("workspace-1");
	});
});
