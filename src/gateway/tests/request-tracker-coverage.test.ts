import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs, { rm } from "node:fs/promises";
import path from "node:path";
import type { RequestState } from "@/gateway/schemas/request-state";
import { RequestTracker } from "@/gateway/services/RequestTracker";

describe("RequestTracker - Coverage for Uncovered Lines", () => {
	let tracker: RequestTracker;
	let testStateDir: string;

	beforeEach(async () => {
		testStateDir = `/tmp/test-request-tracker-coverage-${Date.now()}`;
		tracker = new RequestTracker({ stateBaseDir: testStateDir });
		await tracker.start();
	});

	afterEach(async () => {
		await tracker.stop();
		await rm(testStateDir, { recursive: true, force: true });
	});

	// Test stale request cleanup (lines 266-270 in recoverState)
	describe("Stale request cleanup", () => {
		test("should clean up requests older than 24 hours", async () => {
			// Create a request with old timestamp
			const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago

			await tracker.createRequest({
				requestId: "req-stale-001",
				chatId: "123",
				workspace: "stale-test",
			});

			// Manually update the state file to have old timestamp
			const statePath = path.join(testStateDir, "requests", "req-stale-001.json");
			const content = await fs.readFile(statePath, "utf-8");
			const state: RequestState = JSON.parse(content);

			state.lastUpdatedAt = oldTime;
			state.createdAt = oldTime;

			await fs.writeFile(statePath, JSON.stringify(state, null, 2));

			// Restart tracker to trigger recovery
			await tracker.stop();
			const tracker2 = new RequestTracker({ stateBaseDir: testStateDir });
			await tracker2.start();

			// Request should have been cleaned up
			const recovered = await tracker2.getRequest("req-stale-001");
			expect(recovered).toBeNull();

			await tracker2.stop();
		});

		test("should keep requests newer than 24 hours", async () => {
			// Create a request with recent timestamp
			const recentTime = Date.now() - 23 * 60 * 60 * 1000; // 23 hours ago

			await tracker.createRequest({
				requestId: "req-recent-001",
				chatId: "123",
				workspace: "recent-test",
			});

			// Manually update the state file
			const statePath = path.join(testStateDir, "requests", "req-recent-001.json");
			const content = await fs.readFile(statePath, "utf-8");
			const state: RequestState = JSON.parse(content);

			state.lastUpdatedAt = recentTime;
			state.createdAt = recentTime;

			await fs.writeFile(statePath, JSON.stringify(state, null, 2));

			// Restart tracker
			await tracker.stop();
			const tracker2 = new RequestTracker({ stateBaseDir: testStateDir });
			await tracker2.start();

			// Request should still exist
			const recovered = await tracker2.getRequest("req-recent-001");
			expect(recovered).not.toBeNull();
			expect(recovered?.requestId).toBe("req-recent-001");

			await tracker2.stop();
		});

		test("should clean up exactly 24 hour old requests", async () => {
			// Create a request with exactly 24 hour old timestamp
			const staleThreshold = 24 * 60 * 60 * 1000;
			const oldTime = Date.now() - staleThreshold - 1; // Just over 24 hours

			await tracker.createRequest({
				requestId: "req-exactly-stale-001",
				chatId: "123",
				workspace: "exactly-stale-test",
			});

			// Manually update the state file
			const statePath = path.join(testStateDir, "requests", "req-exactly-stale-001.json");
			const content = await fs.readFile(statePath, "utf-8");
			const state: RequestState = JSON.parse(content);

			state.lastUpdatedAt = oldTime;
			state.createdAt = oldTime;

			await fs.writeFile(statePath, JSON.stringify(state, null, 2));

			// Restart tracker
			await tracker.stop();
			const tracker2 = new RequestTracker({ stateBaseDir: testStateDir });
			await tracker2.start();

			// Request should be cleaned up
			const recovered = await tracker2.getRequest("req-exactly-stale-001");
			expect(recovered).toBeNull();

			await tracker2.stop();
		});

		test("should handle multiple stale requests in cleanup", async () => {
			const oldTime = Date.now() - 25 * 60 * 60 * 1000;

			// Create multiple stale requests
			for (let i = 0; i < 5; i++) {
				await tracker.createRequest({
					requestId: `req-stale-multi-${i}`,
					chatId: "123",
					workspace: "stale-multi-test",
				});

				// Update timestamp
				const statePath = path.join(testStateDir, "requests", `req-stale-multi-${i}.json`);
				const content = await fs.readFile(statePath, "utf-8");
				const state: RequestState = JSON.parse(content);

				state.lastUpdatedAt = oldTime;
				state.createdAt = oldTime;

				await fs.writeFile(statePath, JSON.stringify(state, null, 2));
			}

			// Restart tracker
			await tracker.stop();
			const tracker2 = new RequestTracker({ stateBaseDir: testStateDir });
			await tracker2.start();

			// All stale requests should be cleaned up
			for (let i = 0; i < 5; i++) {
				const recovered = await tracker2.getRequest(`req-stale-multi-${i}`);
				expect(recovered).toBeNull();
			}

			await tracker2.stop();
		});
	});

	// Test hung request detection (lines 273-292 in recoverState)
	describe("Hung request detection", () => {
		test("should mark processing requests over 1 hour as timeout", async () => {
			const hungThreshold = 60 * 60 * 1000; // 1 hour
			const oldProcessingTime = Date.now() - hungThreshold - 1; // Just over 1 hour

			await tracker.createRequest({
				requestId: "req-hung-new-001",
				chatId: "123",
				workspace: "hung-new-test",
			});

			// Update to processing with old timestamp
			const statePath = path.join(testStateDir, "requests", "req-hung-new-001.json");
			const content = await fs.readFile(statePath, "utf-8");
			const state: RequestState = JSON.parse(content);

			state.state = "processing";
			state.processingStartedAt = oldProcessingTime;
			state.lastUpdatedAt = oldProcessingTime;

			await fs.writeFile(statePath, JSON.stringify(state, null, 2));

			// Restart tracker to trigger recovery
			await tracker.stop();
			const tracker2 = new RequestTracker({ stateBaseDir: testStateDir });
			await tracker2.start();

			// Request should be marked as timeout
			const timedOut = await tracker2.getRequest("req-hung-new-001");
			expect(timedOut?.state).toBe("timeout");
			expect(timedOut?.timedOut).toBe(true);
			expect(timedOut?.previousState).toBe("processing");

			await tracker2.stop();
		});

		test("should not mark processing requests under 1 hour as timeout", async () => {
			const recentProcessingTime = Date.now() - 59 * 60 * 1000; // 59 minutes ago

			await tracker.createRequest({
				requestId: "req-processing-recent-001",
				chatId: "123",
				workspace: "processing-recent-test",
			});

			// Update to processing with recent timestamp
			const statePath = path.join(testStateDir, "requests", "req-processing-recent-001.json");
			const content = await fs.readFile(statePath, "utf-8");
			const state: RequestState = JSON.parse(content);

			state.state = "processing";
			state.processingStartedAt = recentProcessingTime;
			state.lastUpdatedAt = recentProcessingTime;

			await fs.writeFile(statePath, JSON.stringify(state, null, 2));

			// Restart tracker
			await tracker.stop();
			const tracker2 = new RequestTracker({ stateBaseDir: testStateDir });
			await tracker2.start();

			// Request should still be in processing state
			const recovered = await tracker2.getRequest("req-processing-recent-001");
			expect(recovered?.state).toBe("processing");
			expect(recovered?.timedOut).toBe(false);

			await tracker2.stop();
		});

		test("should handle non-processing requests without processingStartedAt", async () => {
			// Create a completed request without processingStartedAt
			await tracker.createRequest({
				requestId: "req-completed-001",
				chatId: "123",
				workspace: "completed-test",
			});

			// Update to completed
			await tracker.updateState("req-completed-001", {
				state: "completed",
				completedAt: Date.now(),
				exitCode: 0,
			});

			// Restart tracker - should not crash on missing processingStartedAt
			await tracker.stop();
			const tracker2 = new RequestTracker({ stateBaseDir: testStateDir });
			await tracker2.start();

			const recovered = await tracker2.getRequest("req-completed-001");
			expect(recovered?.state).toBe("completed");

			await tracker2.stop();
		});

		test("should update lastUpdatedAt when marking as timeout", async () => {
			const oldTime = Date.now() - 61 * 60 * 1000; // 61 minutes ago

			await tracker.createRequest({
				requestId: "req-timeout-update-001",
				chatId: "123",
				workspace: "timeout-update-test",
			});

			// Update to processing with old timestamp
			const statePath = path.join(testStateDir, "requests", "req-timeout-update-001.json");
			const content = await fs.readFile(statePath, "utf-8");
			const state: RequestState = JSON.parse(content);

			state.state = "processing";
			state.processingStartedAt = oldTime;
			state.lastUpdatedAt = oldTime;

			await fs.writeFile(statePath, JSON.stringify(state, null, 2));

			// Wait a bit to ensure timestamp difference
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Restart tracker
			await tracker.stop();
			const tracker2 = new RequestTracker({ stateBaseDir: testStateDir });
			await tracker2.start();

			// lastUpdatedAt should be updated
			const timedOut = await tracker2.getRequest("req-timeout-update-001");
			expect(timedOut?.lastUpdatedAt).toBeGreaterThan(oldTime);
			expect(timedOut?.timedOut).toBe(true);

			await tracker2.stop();
		});
	});

	// Test cache disabled behavior
	describe("Cache disabled behavior", () => {
		test("should not cache requests when enableCache is false", async () => {
			const tracker2 = new RequestTracker({
				stateBaseDir: testStateDir,
				enableCache: false,
			});
			await tracker2.start();

			await tracker2.createRequest({
				requestId: "req-no-cache-001",
				chatId: "123",
				workspace: "no-cache-test",
			});

			// Check stats - should have 0 cached items
			const stats = tracker2.getStats();
			expect(stats.totalCached).toBe(0);

			// But request should still be retrievable from disk
			const retrieved = await tracker2.getRequest("req-no-cache-001");
			expect(retrieved).not.toBeNull();
			expect(retrieved?.requestId).toBe("req-no-cache-001");

			// Stats should still show 0 as cache is disabled
			const statsAfter = tracker2.getStats();
			expect(statsAfter.totalCached).toBe(0);

			await tracker2.stop();
		});

		test("should not update cache when enableCache is false", async () => {
			const tracker2 = new RequestTracker({
				stateBaseDir: testStateDir,
				enableCache: false,
			});
			await tracker2.start();

			await tracker2.createRequest({
				requestId: "req-no-cache-update-001",
				chatId: "123",
				workspace: "no-cache-update-test",
			});

			await tracker2.updateState("req-no-cache-update-001", {
				state: "processing",
				processingStartedAt: Date.now(),
			});

			// Cache should still be empty
			const stats = tracker2.getStats();
			expect(stats.totalCached).toBe(0);

			await tracker2.stop();
		});

		test("should handle custom cacheTtlMs", async () => {
			const tracker2 = new RequestTracker({
				stateBaseDir: testStateDir,
				enableCache: true,
				cacheTtlMs: 1000, // 1 second
			});
			await tracker2.start();

			// Create a request
			await tracker2.createRequest({
				requestId: "req-cache-ttl-001",
				chatId: "123",
				workspace: "cache-ttl-test",
			});

			// Should be in cache
			const stats = tracker2.getStats();
			expect(stats.totalCached).toBe(1);

			await tracker2.stop();
		});
	});

	// Test listRequests with chatId filter (line 179)
	describe("List requests with filters", () => {
		test("should filter by chatId", async () => {
			// Create requests with different chatIds
			await tracker.createRequest({
				requestId: "req-chat-1a",
				chatId: "chat-aaa",
				workspace: "chat-filter-test",
			});

			await tracker.createRequest({
				requestId: "req-chat-1b",
				chatId: "chat-bbb",
				workspace: "chat-filter-test",
			});

			await tracker.createRequest({
				requestId: "req-chat-2a",
				chatId: "chat-aaa",
				workspace: "chat-filter-test",
			});

			const aaaRequests = await tracker.listRequests("chat-filter-test", {
				chatId: "chat-aaa",
			});

			const bbbRequests = await tracker.listRequests("chat-filter-test", {
				chatId: "chat-bbb",
			});

			expect(aaaRequests).toHaveLength(2);
			expect(bbbRequests).toHaveLength(1);
			expect(aaaRequests.map((r) => r.requestId)).toContain("req-chat-1a");
			expect(aaaRequests.map((r) => r.requestId)).toContain("req-chat-2a");
			expect(bbbRequests[0].requestId).toBe("req-chat-1b");
		});

		test("should filter by both state and chatId", async () => {
			await tracker.createRequest({
				requestId: "req-combo-1",
				chatId: "chat-combo",
				workspace: "combo-test",
			});

			await tracker.updateState("req-combo-1", {
				state: "processing",
				processingStartedAt: Date.now(),
			});

			await tracker.createRequest({
				requestId: "req-combo-2",
				chatId: "chat-combo",
				workspace: "combo-test",
			});

			const processingCombo = await tracker.listRequests("combo-test", {
				state: "processing",
				chatId: "chat-combo",
			});

			const createdCombo = await tracker.listRequests("combo-test", {
				state: "created",
				chatId: "chat-combo",
			});

			expect(processingCombo).toHaveLength(1);
			expect(createdCombo).toHaveLength(1);
			expect(processingCombo[0].requestId).toBe("req-combo-1");
			expect(createdCombo[0].requestId).toBe("req-combo-2");
		});
	});

	// Test error handling in listRequests (line 190)
	describe("List requests error handling", () => {
		test("should handle corrupted state files gracefully", async () => {
			await tracker.createRequest({
				requestId: "req-good-001",
				chatId: "123",
				workspace: "corrupt-test",
			});

			// Create a corrupted file
			const corruptedPath = path.join(testStateDir, "requests", "by-workspace", "corrupt-test", "req-corrupted.json");
			await fs.mkdir(path.dirname(corruptedPath), { recursive: true });
			await fs.writeFile(corruptedPath, "invalid json content", "utf-8");

			// Should skip the corrupted file and return valid requests
			const requests = await tracker.listRequests("corrupt-test");

			// Should only return the valid request
			expect(requests).toHaveLength(1);
			expect(requests[0].requestId).toBe("req-good-001");
		});

		test("should handle non-existent workspace directory", async () => {
			// List requests for workspace that doesn't exist
			const requests = await tracker.listRequests("non-existent-workspace");

			expect(requests).toEqual([]);
		});

		test("should skip non-JSON files in workspace directory", async () => {
			await tracker.createRequest({
				requestId: "req-non-json-001",
				chatId: "123",
				workspace: "non-json-test",
			});

			// Create a non-JSON file
			const wsDir = path.join(testStateDir, "requests", "by-workspace", "non-json-test");
			await fs.mkdir(wsDir, { recursive: true });
			await fs.writeFile(path.join(wsDir, "readme.txt"), "just a text file", "utf-8");

			const requests = await tracker.listRequests("non-json-test");

			// Should only return the JSON request
			expect(requests).toHaveLength(1);
			expect(requests[0].requestId).toBe("req-non-json-001");
		});
	});

	// Test getRequest with corrupted file (lines 153-156)
	describe("Get request error handling", () => {
		test("should return null for corrupted state file", async () => {
			// Create a request
			await tracker.createRequest({
				requestId: "req-corrupt-get-001",
				chatId: "123",
				workspace: "corrupt-get-test",
			});

			// Corrupt the file
			const statePath = path.join(testStateDir, "requests", "req-corrupt-get-001.json");
			await fs.writeFile(statePath, "corrupted json", "utf-8");

			// Clear cache so it reads from disk
			tracker.stop();
			const tracker2 = new RequestTracker({ stateBaseDir: testStateDir });
			await tracker2.start();

			const retrieved = await tracker2.getRequest("req-corrupt-get-001");
			expect(retrieved).toBeNull();

			await tracker2.stop();
		});

		test("should return null for non-existent request", async () => {
			const retrieved = await tracker.getRequest("definitely-does-not-exist-12345");
			expect(retrieved).toBeNull();
		});
	});
});
