import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { FileCleanupService } from "@/gateway/services/file-cleanup";

describe("FileCleanupService", () => {
	let testDir: string;
	let service: FileCleanupService;

	beforeEach(async () => {
		testDir = `/tmp/cleanup-test-${Date.now()}`;
		service = new FileCleanupService({
			baseDir: testDir,
			ttlMs: 3600000, // 1 hour
			cleanupIntervalMs: 300000, // 5 minutes
			enabled: true,
		});
	});

	afterEach(async () => {
		if (service.cleanupTimer) {
			clearInterval(service.cleanupTimer);
		}
		if (existsSync(testDir)) {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	test("should start and stop cleanup service", async () => {
		await service.start();

		const status = service.getStatus();

		expect(status.config.enabled).toBe(true);
		expect(status.activeRequests).toBe(0);
		expect(service.cleanupTimer).not.toBeNull();

		await service.stop();

		expect(service.cleanupTimer).toBeNull();
	});

	test("should delete files older than TTL", async () => {
		// Create a short TTL service for faster testing
		const shortTtlService = new FileCleanupService({
			baseDir: testDir,
			ttlMs: 60000, // 1 minute TTL
			cleanupIntervalMs: 300000,
			enabled: true,
		});

		const workspace = "test-workspace";

		// Create old file (2 minutes ago)
		const oldFile = path.join(testDir, workspace, "responses", "old-request.json");
		await mkdir(path.dirname(oldFile), { recursive: true });
		await Bun.write(oldFile, JSON.stringify({ data: "old" }));
		const oldTime = Date.now() / 1000 - 120; // 2 minutes ago
		await utimes(oldFile, oldTime, oldTime);

		// Create recent file (30 seconds ago)
		const recentFile = path.join(testDir, workspace, "responses", "recent-request.json");
		await Bun.write(recentFile, JSON.stringify({ data: "recent" }));
		const recentTime = Date.now() / 1000 - 30; // 30 seconds ago
		await utimes(recentFile, recentTime, recentTime);

		// Wait a bit to ensure timestamps are set
		await new Promise((resolve) => setTimeout(resolve, 10));

		const stats = await shortTtlService.runCleanup();

		expect(stats.filesScanned).toBe(2);
		expect(stats.filesDeleted).toBe(1);
		expect(existsSync(oldFile)).toBe(false); // Deleted
		expect(existsSync(recentFile)).toBe(true); // Exists
	});

	test("should never delete files for active requests", async () => {
		const workspace = "test-workspace";
		const activeRequestId = "active-001";
		const file = path.join(testDir, workspace, "responses", `${activeRequestId}.json`);

		// Create old file (2 hours ago)
		await mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, JSON.stringify({ data: "active" }));
		const oldTime = Date.now() / 1000 - 7200;
		await utimes(file, oldTime, oldTime);

		// Track as active request
		service.trackRequest(activeRequestId);

		const stats = await service.runCleanup();

		expect(stats.filesDeleted).toBe(0);
		expect(existsSync(file)).toBe(true); // Still exists

		// Untrack and cleanup should now delete it
		service.untrackRequest(activeRequestId);
		const stats2 = await service.runCleanup();

		expect(stats2.filesDeleted).toBe(1);
		expect(existsSync(file)).toBe(false);
	});

	test("should detect and clean orphaned files", async () => {
		// Use the existing service with default 15 min grace period
		const workspace = "test-workspace";

		// Create young orphan file (10 minutes ago, not tracked)
		const orphanFile = path.join(testDir, workspace, "responses", "orphan-001.json");
		await mkdir(path.dirname(orphanFile), { recursive: true });
		await Bun.write(orphanFile, JSON.stringify({ data: "orphan" }));
		const orphanTime = Date.now() / 1000 - 600; // 10 minutes ago
		await utimes(orphanFile, orphanTime, orphanTime);

		// Create old orphan file (20 minutes ago)
		const oldOrphanFile = path.join(testDir, workspace, "responses", "old-orphan.json");
		await Bun.write(oldOrphanFile, JSON.stringify({ data: "old-orphan" }));
		const oldOrphanTime = Date.now() / 1000 - 1200; // 20 minutes ago
		await utimes(oldOrphanFile, oldOrphanTime, oldOrphanTime);

		// Wait a bit to ensure timestamps are set
		await new Promise((resolve) => setTimeout(resolve, 10));

		// First check - list files to verify they exist
		const filesBefore = await service.listFiles();
		expect(filesBefore.length).toBeGreaterThanOrEqual(2);

		const stats = await service.runCleanup();

		// At least the old orphan should be deleted (20 min > 15 min grace period)
		expect(stats.orphansFound).toBeGreaterThanOrEqual(1);
		expect(stats.filesDeleted).toBeGreaterThanOrEqual(1);
		expect(existsSync(oldOrphanFile)).toBe(false);
	});

	test("should run startup cleanup with grace period", async () => {
		const workspace = "test-workspace";

		// Create file 10 minutes ago (within 5 min startup grace)
		const recentFile = path.join(testDir, workspace, "responses", "recent-request.json");
		await mkdir(path.dirname(recentFile), { recursive: true });
		await Bun.write(recentFile, JSON.stringify({ data: "recent" }));
		const recentTime = Date.now() / 1000 - 600; // 10 minutes ago
		await utimes(recentFile, recentTime, recentTime);

		// Create file 10 minutes ago (within 5 min startup grace)
		// Startup cleanup should delete files older than 5 minutes
		const stats = await service.runCleanup({ onStartup: true });

		expect(stats.filesDeleted).toBe(1);
		expect(existsSync(recentFile)).toBe(false);
	});

	test("should handle dry-run mode", async () => {
		const workspace = "test-workspace";
		const oldFile = path.join(testDir, workspace, "responses", "old-request.json");

		await mkdir(path.dirname(oldFile), { recursive: true });
		await Bun.write(oldFile, JSON.stringify({ data: "old" }));
		const oldTime = Date.now() / 1000 - 7200;
		await utimes(oldFile, oldTime, oldTime);

		const stats = await service.runCleanup({ dryRun: true });

		expect(stats.filesDeleted).toBe(1);
		expect(stats.bytesFreed).toBe(0); // No bytes freed in dry-run
		expect(existsSync(oldFile)).toBe(true); // File still exists
	});

	test("should handle force mode", async () => {
		const workspace = "test-workspace";
		const requestId = "test-request";
		const file = path.join(testDir, workspace, "responses", `${requestId}.json`);

		await mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, JSON.stringify({ data: "test" }));

		// Track as active
		service.trackRequest(requestId);

		const stats = await service.runCleanup({ force: true });

		// Force mode should delete even active requests
		expect(stats.filesDeleted).toBe(1);
		expect(existsSync(file)).toBe(false);
	});

	test("should list all response files with metadata", async () => {
		const workspace = "test-workspace";

		const file1 = path.join(testDir, workspace, "responses", "req-001.json");
		const file2 = path.join(testDir, workspace, "responses", "req-002.json");

		await mkdir(path.dirname(file1), { recursive: true });
		await Bun.write(file1, JSON.stringify({ data: "test1" }));
		await Bun.write(file2, JSON.stringify({ data: "test2" }));

		const files = await service.listFiles();

		expect(files.length).toBe(2);

		// Sort by requestId for consistent ordering
		files.sort((a, b) => a.requestId.localeCompare(b.requestId));

		expect(files[0].requestId).toBe("req-001");
		expect(files[1].requestId).toBe("req-002");
		expect(files[0].workspace).toBe(workspace);
		expect(files[0].isOrphan).toBe(true);
		expect(files[0].sizeBytes).toBeGreaterThan(0);
	});

	test("should filter by workspace", async () => {
		const workspace1 = "workspace-1";
		const workspace2 = "workspace-2";

		const file1 = path.join(testDir, workspace1, "responses", "req-001.json");
		const file2 = path.join(testDir, workspace2, "responses", "req-002.json");

		await mkdir(path.dirname(file1), { recursive: true });
		await mkdir(path.dirname(file2), { recursive: true });
		await Bun.write(file1, JSON.stringify({ data: "test1" }));
		await Bun.write(file2, JSON.stringify({ data: "test2" }));

		const files = await service.listFiles(workspace1);

		expect(files.length).toBe(1);
		expect(files[0].workspace).toBe(workspace1);
	});

	test("should handle concurrent cleanup attempts safely", async () => {
		const workspace = "test-workspace";
		const file = path.join(testDir, workspace, "responses", "req-001.json");

		await mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, JSON.stringify({ data: "test" }));

		// Start two cleanups simultaneously
		const cleanup1 = service.runCleanup();
		const cleanup2 = service.runCleanup();

		const [stats1, stats2] = await Promise.all([cleanup1, cleanup2]);

		// One should complete, one should skip
		expect(stats1.filesScanned + stats2.filesScanned).toBeGreaterThan(0);
		// At least one should have scanned files
		expect(Math.max(stats1.filesScanned, stats2.filesScanned)).toBe(1);
	});

	test("should calculate cleanup stats correctly", async () => {
		const workspace = "test-workspace";

		// Create 3 old files
		for (let i = 0; i < 3; i++) {
			const file = path.join(testDir, workspace, "responses", `req-00${i}.json`);
			await mkdir(path.dirname(file), { recursive: true });
			await Bun.write(file, JSON.stringify({ data: `test${i}` }));
			const oldTime = Date.now() / 1000 - 7200;
			await utimes(file, oldTime, oldTime);
		}

		// Create 1 recent file
		const recentFile = path.join(testDir, workspace, "responses", "recent.json");
		await Bun.write(recentFile, JSON.stringify({ data: "recent" }));

		const stats = await service.runCleanup();

		expect(stats.filesScanned).toBe(4);
		expect(stats.filesDeleted).toBe(3);
		expect(stats.errors).toBe(0);
		expect(stats.durationMs).toBeLessThan(1000);
	});

	test("should handle non-existent directory gracefully", async () => {
		const nonExistentDir = "/tmp/non-existent-cleanup-test";
		const testService = new FileCleanupService({
			baseDir: nonExistentDir,
			ttlMs: 3600000,
			enabled: true,
		});

		const stats = await testService.runCleanup();

		expect(stats.filesScanned).toBe(0);
		expect(stats.filesDeleted).toBe(0);
	});

	test("should clean up specific workspace", async () => {
		const workspace1 = "workspace-1";
		const workspace2 = "workspace-2";

		const file1 = path.join(testDir, workspace1, "responses", "req-001.json");
		const file2 = path.join(testDir, workspace2, "responses", "req-002.json");

		await mkdir(path.dirname(file1), { recursive: true });
		await mkdir(path.dirname(file2), { recursive: true });
		await Bun.write(file1, JSON.stringify({ data: "test1" }));
		await Bun.write(file2, JSON.stringify({ data: "test2" }));

		// Both files should exist
		expect(existsSync(file1)).toBe(true);
		expect(existsSync(file2)).toBe(true);

		// Clean only workspace-1
		const stats = await service.runCleanup({
			workspace: workspace1,
			force: true,
		});

		expect(stats.filesScanned).toBe(1);
		expect(stats.filesDeleted).toBe(1);
		expect(existsSync(file1)).toBe(false); // Deleted
		expect(existsSync(file2)).toBe(true); // Still exists
	});

	test("should track and untrack requests", () => {
		const requestId = "test-request";

		expect(service.getStatus().activeRequests).toBe(0);

		service.trackRequest(requestId);

		expect(service.getStatus().activeRequests).toBe(1);

		service.trackRequest("another-request");

		expect(service.getStatus().activeRequests).toBe(2);

		service.untrackRequest(requestId);

		expect(service.getStatus().activeRequests).toBe(1);

		// Untracking non-existent request should be safe
		service.untrackRequest("non-existent");

		expect(service.getStatus().activeRequests).toBe(1);
	});
});
