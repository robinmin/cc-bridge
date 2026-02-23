import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { RequestTracker } from "@/gateway/services/RequestTracker";

describe("RequestTracker", () => {
	let tracker: RequestTracker;
	let testStateDir: string;

	beforeEach(async () => {
		testStateDir = `/tmp/test-request-tracker-${Date.now()}`;
		tracker = new RequestTracker({ stateBaseDir: testStateDir });
		await tracker.start();
	});

	afterEach(async () => {
		await tracker.stop();
		await rm(testStateDir, { recursive: true, force: true });
	});

	test("should report running status transitions", async () => {
		expect(tracker.isRunning()).toBe(true);
		await tracker.stop();
		expect(tracker.isRunning()).toBe(false);
	});

	describe("Request Creation", () => {
		test("should create request with initial state", async () => {
			const state = await tracker.createRequest({
				requestId: "req-001",
				chatId: "123",
				workspace: "test-workspace",
				prompt: "Hello world",
			});

			expect(state.state).toBe("created");
			expect(state.requestId).toBe("req-001");
			expect(state.chatId).toBe("123");
			expect(state.workspace).toBe("test-workspace");
			expect(state.prompt).toBe("Hello world");
			expect(state.createdAt).toBeDefined();
			expect(state.lastUpdatedAt).toBeDefined();
			expect(state.timedOut).toBe(false);
		});

		test("should store request in cache", async () => {
			await tracker.createRequest({
				requestId: "req-cache-001",
				chatId: "456",
				workspace: "cache-test",
			});

			const retrieved = await tracker.getRequest("req-cache-001");
			expect(retrieved).toBeDefined();
			expect(retrieved?.requestId).toBe("req-cache-001");
		});
	});

	describe("State Transitions", () => {
		test("should transition from created to processing", async () => {
			await tracker.createRequest({
				requestId: "req-transition-001",
				chatId: "123",
				workspace: "test",
			});

			const updated = await tracker.updateState("req-transition-001", {
				state: "processing",
				processingStartedAt: Date.now(),
			});

			expect(updated).toBeDefined();
			expect(updated?.state).toBe("processing");
			expect(updated?.previousState).toBe("created");
			expect(updated?.processingStartedAt).toBeDefined();
		});

		test("should transition to completed state", async () => {
			await tracker.createRequest({
				requestId: "req-complete-001",
				chatId: "123",
				workspace: "test",
			});

			await tracker.updateState("req-complete-001", {
				state: "processing",
				processingStartedAt: Date.now(),
			});

			const completed = await tracker.updateState("req-complete-001", {
				state: "completed",
				completedAt: Date.now(),
				exitCode: 0,
				output: "Success!",
			});

			expect(completed?.state).toBe("completed");
			expect(completed?.previousState).toBe("processing");
			expect(completed?.exitCode).toBe(0);
			expect(completed?.output).toBe("Success!");
		});

		test("should transition to failed state", async () => {
			await tracker.createRequest({
				requestId: "req-fail-001",
				chatId: "123",
				workspace: "test",
			});

			const _failed = await tracker.updateState("req-fail-001", {
				state: "processing",
				processingStartedAt: Date.now(),
			});

			await tracker.updateState("req-fail-001", {
				state: "failed",
				completedAt: Date.now(),
				exitCode: 1,
				error: "Command failed",
			});

			const final = await tracker.getRequest("req-fail-001");
			expect(final?.state).toBe("failed");
			expect(final?.error).toBe("Command failed");
		});
	});

	describe("Request Lookup", () => {
		test("should get request by ID", async () => {
			await tracker.createRequest({
				requestId: "req-lookup-001",
				chatId: "789",
				workspace: "lookup-test",
			});

			const retrieved = await tracker.getRequest("req-lookup-001");
			expect(retrieved).toBeDefined();
			expect(retrieved?.requestId).toBe("req-lookup-001");
		});

		test("should return null for non-existent request", async () => {
			const retrieved = await tracker.getRequest("non-existent");
			expect(retrieved).toBeNull();
		});
	});

	describe("Listing Requests", () => {
		test("should list requests by workspace", async () => {
			// Create requests in different workspaces
			await tracker.createRequest({
				requestId: "req-list-a1",
				chatId: "123",
				workspace: "workspace-a",
			});

			await tracker.createRequest({
				requestId: "req-list-a2",
				chatId: "123",
				workspace: "workspace-a",
			});

			await tracker.createRequest({
				requestId: "req-list-b1",
				chatId: "123",
				workspace: "workspace-b",
			});

			const wsA = await tracker.listRequests("workspace-a");
			const wsB = await tracker.listRequests("workspace-b");

			expect(wsA).toHaveLength(2);
			expect(wsB).toHaveLength(1);
			expect(wsA.map((r) => r.requestId)).toContain("req-list-a1");
			expect(wsA.map((r) => r.requestId)).toContain("req-list-a2");
			expect(wsB[0].requestId).toBe("req-list-b1");
		});

		test("should filter requests by state", async () => {
			await tracker.createRequest({
				requestId: "req-filter-001",
				chatId: "123",
				workspace: "filter-test",
			});

			await tracker.updateState("req-filter-001", {
				state: "processing",
				processingStartedAt: Date.now(),
			});

			await tracker.createRequest({
				requestId: "req-filter-002",
				chatId: "123",
				workspace: "filter-test",
			});

			const processing = await tracker.listRequests("filter-test", {
				state: "processing",
			});
			const created = await tracker.listRequests("filter-test", {
				state: "created",
			});

			expect(processing).toHaveLength(1);
			expect(created).toHaveLength(1);
		});

		test("should limit number of results", async () => {
			for (let i = 0; i < 5; i++) {
				await tracker.createRequest({
					requestId: `req-limit-${i}`,
					chatId: "123",
					workspace: "limit-test",
				});
			}

			const limited = await tracker.listRequests("limit-test", {
				limit: 3,
			});

			expect(limited).toHaveLength(3);
		});

		test("should sort requests by creation time (newest first)", async () => {
			// Create requests with slight delay to ensure different timestamps
			await tracker.createRequest({
				requestId: "req-sort-1",
				chatId: "123",
				workspace: "sort-test",
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			await tracker.createRequest({
				requestId: "req-sort-2",
				chatId: "123",
				workspace: "sort-test",
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			await tracker.createRequest({
				requestId: "req-sort-3",
				chatId: "123",
				workspace: "sort-test",
			});

			const requests = await tracker.listRequests("sort-test");

			// Should be sorted newest first
			expect(requests[0].requestId).toBe("req-sort-3");
			expect(requests[1].requestId).toBe("req-sort-2");
			expect(requests[2].requestId).toBe("req-sort-1");
		});
	});

	describe("State Persistence", () => {
		test("should persist state to filesystem", async () => {
			await tracker.createRequest({
				requestId: "req-persist-001",
				chatId: "123",
				workspace: "persist-test",
				prompt: "Persist me",
			});

			// Create a new RequestTracker instance to force disk read
			const newTracker = new RequestTracker({
				stateBaseDir: testStateDir,
			});
			await newTracker.start();

			const retrieved = await newTracker.getRequest("req-persist-001");
			expect(retrieved).toBeDefined();
			expect(retrieved?.prompt).toBe("Persist me");

			await newTracker.stop();
		});

		test("should use atomic writes (temp file + rename)", async () => {
			await tracker.createRequest({
				requestId: "req-atomic-001",
				chatId: "123",
				workspace: "atomic-test",
			});

			// Check that temp file doesn't exist (should be renamed)
			const tempFile = path.join(testStateDir, "requests", "req-atomic-001.json.tmp");
			const exists = await Bun.file(tempFile).exists();
			expect(exists).toBe(false);

			// Check that main file exists
			const mainFile = path.join(testStateDir, "requests", "req-atomic-001.json");
			const mainExists = await Bun.file(mainFile).exists();
			expect(mainExists).toBe(true);
		});

		test("should index by workspace", async () => {
			await tracker.createRequest({
				requestId: "req-index-001",
				chatId: "123",
				workspace: "index-test",
			});

			// Check workspace-indexed file exists
			const wsFile = path.join(testStateDir, "requests", "by-workspace", "index-test", "req-index-001.json");
			const exists = await Bun.file(wsFile).exists();
			expect(exists).toBe(true);
		});
	});

	describe("Crash Recovery", () => {
		test("should recover state after restart", async () => {
			// Create a request
			await tracker.createRequest({
				requestId: "req-recover-001",
				chatId: "123",
				workspace: "recover-test",
			});

			// Update to processing
			await tracker.updateState("req-recover-001", {
				state: "processing",
				processingStartedAt: Date.now(),
			});

			// Stop and restart tracker (simulate crash)
			await tracker.stop();
			const tracker2 = new RequestTracker({ stateBaseDir: testStateDir });
			await tracker2.start();

			// Request should be recovered
			const recovered = await tracker2.getRequest("req-recover-001");
			expect(recovered).toBeDefined();
			expect(recovered?.state).toBe("processing");
			expect(recovered?.requestId).toBe("req-recover-001");

			await tracker2.stop();
		});

		test("should detect and mark hung requests as timeout", async () => {
			// Create a request in processing state
			const tracker2 = new RequestTracker({ stateBaseDir: testStateDir });
			await tracker2.start();

			await tracker2.createRequest({
				requestId: "req-hung-001",
				chatId: "123",
				workspace: "hung-test",
			});

			const oldTime = Date.now() - 61 * 60 * 1000; // 61 minutes ago

			await tracker2.updateState("req-hung-001", {
				state: "processing",
				processingStartedAt: oldTime,
			});

			// Verify the state was written with the old processingStartedAt
			const beforeRestart = await tracker2.getRequest("req-hung-001");
			expect(beforeRestart?.processingStartedAt).toBe(oldTime);
			const processingStartedAt = beforeRestart?.processingStartedAt;
			expect(processingStartedAt).toBeDefined();
			// Safe to access aftertoBeDefined check
			const startTime = processingStartedAt as number;
			expect(Date.now() - startTime).toBeGreaterThan(60 * 60 * 1000);

			// Restart - should detect hung request
			await tracker2.stop();
			const tracker3 = new RequestTracker({ stateBaseDir: testStateDir });
			await tracker3.start();

			const timedOut = await tracker3.getRequest("req-hung-001");
			expect(timedOut?.state).toBe("timeout");
			expect(timedOut?.timedOut).toBe(true);

			await tracker3.stop();
		});
	});

	describe("Deletion", () => {
		test("should delete request state", async () => {
			await tracker.createRequest({
				requestId: "req-delete-001",
				chatId: "123",
				workspace: "delete-test",
			});

			expect(await tracker.getRequest("req-delete-001")).toBeDefined();

			await tracker.deleteRequest("req-delete-001");

			expect(await tracker.getRequest("req-delete-001")).toBeNull();
		});

		test("should handle deletion of non-existent request gracefully", async () => {
			// Should not throw when deleting non-existent request
			await tracker.deleteRequest("non-existent");

			// Verify it doesn't affect actual requests
			await tracker.createRequest({
				requestId: "req-graceful-001",
				chatId: "123",
				workspace: "graceful-test",
			});

			expect(await tracker.getRequest("req-graceful-001")).toBeDefined();
		});
	});

	describe("Statistics", () => {
		test("should return accurate statistics", async () => {
			// Create requests in different states
			await tracker.createRequest({
				requestId: "req-stat-1",
				chatId: "123",
				workspace: "stat-test",
			});

			await tracker.createRequest({
				requestId: "req-stat-2",
				chatId: "123",
				workspace: "stat-test",
			});

			await tracker.updateState("req-stat-1", {
				state: "processing",
				processingStartedAt: Date.now(),
			});

			const stats = tracker.getStats();

			expect(stats.totalCached).toBe(2);
			expect(stats.byState.created).toBe(1);
			expect(stats.byState.processing).toBe(1);
		});
	});

	describe("Callback Metadata", () => {
		test("should update callback metadata", async () => {
			await tracker.createRequest({
				requestId: "req-callback-001",
				chatId: "123",
				workspace: "callback-test",
			});

			const updated = await tracker.updateState("req-callback-001", {
				state: "completed",
				callback: {
					success: true,
					attempts: 1,
					retryTimestamps: ["2024-01-01T00:00:00Z"],
				},
			});

			expect(updated?.callback?.success).toBe(true);
			expect(updated?.callback?.attempts).toBe(1);
			expect(updated?.callback?.retryTimestamps).toEqual(["2024-01-01T00:00:00Z"]);
		});
	});

	describe("Edge Cases", () => {
		test("should not update non-existent request", async () => {
			const result = await tracker.updateState("non-existent", {
				state: "processing",
				processingStartedAt: Date.now(),
			});

			expect(result).toBeNull();
		});

		test("should handle empty workspace gracefully", async () => {
			const requests = await tracker.listRequests("empty-workspace");
			expect(requests).toEqual([]);
		});
	});
});
