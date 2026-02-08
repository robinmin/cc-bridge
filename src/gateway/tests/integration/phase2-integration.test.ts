import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileCleanupService } from "@/gateway/services/file-cleanup";
import { IdempotencyService } from "@/gateway/services/IdempotencyService";
import { RateLimitService } from "@/gateway/services/RateLimitService";
import { ResponseFileReader } from "@/gateway/services/ResponseFileReader";
import { SessionPoolService } from "@/gateway/services/SessionPoolService";
import type { TmuxManager } from "@/gateway/services/tmux-manager";

// Mock TmuxManager for testing
class MockTmuxManager {
	public sessions: Map<string, boolean> = new Map();
	public killedSessions: string[] = [];

	async createWorkspaceSession(_containerId: string, sessionName: string, _workspace: string): Promise<void> {
		this.sessions.set(sessionName, true);
	}

	async killWorkspaceSession(_containerId: string, sessionName: string): Promise<void> {
		this.killedSessions.push(sessionName);
		this.sessions.delete(sessionName);
	}

	async listAllSessions(_containerId: string): Promise<string[]> {
		return Array.from(this.sessions.keys());
	}
}

describe("Phase 2 Integration Tests", () => {
	let testBaseDir: string;
	let mockTmux: MockTmuxManager;

	beforeEach(async () => {
		testBaseDir = `/tmp/test-phase2-${Date.now()}`;
		mockTmux = new MockTmuxManager();
	});

	afterEach(async () => {
		await rm(testBaseDir, { recursive: true, force: true });
	});

	describe("File Cleanup Integration", () => {
		test("should cleanup old files across multiple workspaces", async () => {
			const cleanupService = new FileCleanupService({
				baseDir: testBaseDir,
				ttlMs: 1000, // 1 second TTL for testing
				cleanupIntervalMs: 10000,
				enabled: false, // Manual control
			});

			// Create files in multiple workspaces
			const workspaces = ["workspace-a", "workspace-b", "workspace-c"];

			for (const workspace of workspaces) {
				const workspaceDir = path.join(testBaseDir, workspace, "responses");
				await mkdir(workspaceDir, { recursive: true });

				// Create old file (simulate age via timestamp)
				const oldFile = path.join(workspaceDir, "old-request.json");
				await writeFile(oldFile, JSON.stringify({ test: true }));
				const oldTime = Date.now() / 1000 - 10; // 10 seconds ago
				// Use utimes to set file modification time
				await utimes(oldFile, oldTime, oldTime);

				// Create new file
				const newFile = path.join(workspaceDir, "new-request.json");
				await writeFile(newFile, JSON.stringify({ test: true }));
			}

			// Run cleanup
			await cleanupService.runCleanup();

			// Verify old files were deleted, new files remain
			for (const workspace of workspaces) {
				const oldFile = path.join(testBaseDir, workspace, "responses", "old-request.json");
				const newFile = path.join(testBaseDir, workspace, "responses", "new-request.json");

				let oldExists = true;
				try {
					await readFile(oldFile);
				} catch {
					oldExists = false;
				}

				const newContent = await readFile(newFile, "utf-8");
				expect(JSON.parse(newContent)).toEqual({ test: true });
				expect(oldExists).toBe(false);
			}
		});

		test("should handle cleanup errors gracefully", async () => {
			const cleanupService = new FileCleanupService({
				baseDir: testBaseDir,
				ttlMs: 1000,
				cleanupIntervalMs: 10000,
				enabled: false,
			});

			// Create a directory structure
			const workspaceDir = path.join(testBaseDir, "test-workspace", "responses");
			await mkdir(workspaceDir, { recursive: true });
			await writeFile(path.join(workspaceDir, "test.json"), "{}");

			// Run cleanup - should complete without throwing
			const result = await cleanupService.runCleanup();
			expect(result).toBeDefined();
			expect(result.errors).toBe(0);
		});
	});

	describe("Callback Services Integration", () => {
		test("should integrate idempotency, rate limiting, and file reading", async () => {
			const idempotencyService = new IdempotencyService({
				maxSize: 100,
				ttlMs: 60000,
				cleanupIntervalMs: 30000,
			});

			const rateLimitService = new RateLimitService({
				workspaceLimit: 10,
				ipLimit: 20,
				windowMs: 60000,
				cleanupIntervalMs: 60000,
			});

			const responseFileReader = new ResponseFileReader({
				ipcBasePath: testBaseDir,
				maxFileSize: 1024 * 100, // 100KB
				maxReadRetries: 3,
				readRetryDelayMs: 10,
			});

			// Create a test response file
			const workspace = "test-workspace";
			const requestId = "test-request-001";
			const responseDir = path.join(testBaseDir, workspace, "responses");
			await mkdir(responseDir, { recursive: true });

			const responseData = {
				requestId,
				chatId: "123",
				workspace,
				timestamp: new Date().toISOString(),
				output: "Test response",
				exitCode: 0,
			};

			await writeFile(path.join(responseDir, `${requestId}.json`), JSON.stringify(responseData));

			// Test rate limiting
			const rateLimitKey1 = `${workspace}:${requestId}`;
			const _rateLimitKey2 = `${workspace}:123.45.67.89`;

			// First request should pass
			const limit1 = rateLimitService.checkLimit(rateLimitKey1, "workspace");
			expect(limit1.allowed).toBe(true);

			// Test idempotency
			const isDuplicate1 = idempotencyService.isDuplicate(requestId);
			expect(isDuplicate1).toBe(false);

			// Mark as processed
			idempotencyService.markProcessed(requestId);

			// Second check should detect duplicate
			const isDuplicate2 = idempotencyService.isDuplicate(requestId);
			expect(isDuplicate2).toBe(true);

			// Test file reading
			const readResponse = await responseFileReader.readResponseFile(workspace, requestId);
			expect(readResponse).toEqual(responseData);

			// Cleanup
			idempotencyService.stopCleanup();
			rateLimitService.stopCleanup();
		});

		test("should handle concurrent callback processing", async () => {
			const idempotencyService = new IdempotencyService({ maxSize: 1000 });
			const rateLimitService = new RateLimitService({ workspaceLimit: 100 });
			const responseFileReader = new ResponseFileReader({
				ipcBasePath: testBaseDir,
				maxFileSize: 1024 * 100,
			});

			// Create multiple response files
			const numRequests = 10;
			const workspace = "concurrent-test";

			for (let i = 0; i < numRequests; i++) {
				const responseDir = path.join(testBaseDir, workspace, "responses");
				await mkdir(responseDir, { recursive: true });

				const responseData = {
					requestId: `concurrent-${i}`,
					chatId: "123",
					workspace,
					timestamp: new Date().toISOString(),
					output: `Response ${i}`,
					exitCode: 0,
				};

				await writeFile(path.join(responseDir, `concurrent-${i}.json`), JSON.stringify(responseData));
			}

			// Process all concurrently
			const results = await Promise.allSettled(
				Array.from({ length: numRequests }, async (_, i) => {
					const requestId = `concurrent-${i}`;

					// Check rate limit
					const limit = rateLimitService.checkLimit(`${workspace}:${requestId}`, "workspace");
					if (!limit.allowed) throw new Error("Rate limited");

					// Check idempotency
					if (idempotencyService.isDuplicate(requestId)) {
						return { duplicate: true };
					}
					idempotencyService.markProcessed(requestId);

					// Read response
					return await responseFileReader.readResponseFile(workspace, requestId);
				}),
			);

			// All should succeed
			const successCount = results.filter((r) => r.status === "fulfilled").length;
			expect(successCount).toBe(numRequests);

			// Cleanup
			idempotencyService.stopCleanup();
			rateLimitService.stopCleanup();
		});
	});

	describe("Session Pool Integration", () => {
		test("should manage sessions across multiple workspaces", async () => {
			const containerId = "test-container";
			const sessionPool = new SessionPoolService(mockTmux as unknown as TmuxManager, {
				containerId,
				maxSessions: 10,
				inactivityTimeoutMs: 5000,
				enableAutoCleanup: false,
			});

			await sessionPool.start();

			// Create sessions for multiple workspaces
			const workspaces = ["project-a", "project-b", "project-c"];

			for (const workspace of workspaces) {
				const session = await sessionPool.getOrCreateSession(workspace);
				expect(session.workspace).toBe(workspace);
				expect(session.sessionName).toBe(`claude-${workspace}`);
			}

			// Verify all sessions exist
			const sessions = sessionPool.listSessions();
			expect(sessions).toHaveLength(3);

			// Track some requests
			sessionPool.trackRequestStart("project-a");
			sessionPool.trackRequestStart("project-b");

			const stats = sessionPool.getStats();
			expect(stats.activeRequests).toBe(2);
			expect(stats.totalRequests).toBe(2);

			// Complete requests
			sessionPool.trackRequestComplete("project-a");
			sessionPool.trackRequestComplete("project-b");

			const stats2 = sessionPool.getStats();
			expect(stats2.activeRequests).toBe(0);
			expect(stats2.totalRequests).toBe(2);

			await sessionPool.stop();
		});

		test("should cleanup inactive sessions", async () => {
			const containerId = "test-container-cleanup";
			const sessionPool = new SessionPoolService(mockTmux as unknown as TmuxManager, {
				containerId,
				maxSessions: 10,
				inactivityTimeoutMs: 1000, // 1 second
				enableAutoCleanup: false,
			});

			await sessionPool.start();

			// Create sessions
			await sessionPool.getOrCreateSession("temp-session-1");
			await sessionPool.getOrCreateSession("temp-session-2");

			// Manually age one session
			const session = sessionPool.getSession("temp-session-1");
			if (session) {
				session.lastActivityAt = Date.now() - 2000; // 2 seconds ago
			}

			// Run cleanup
			await sessionPool.cleanupInactiveSessions();

			// Verify temp-session-1 was cleaned up
			expect(sessionPool.getSession("temp-session-1")).toBeUndefined();
			expect(sessionPool.getSession("temp-session-2")).toBeDefined();

			await sessionPool.stop();
		});
	});

	describe("End-to-End Workflow", () => {
		test("should handle complete request lifecycle", async () => {
			const workspace = "e2e-test";
			const requestId = "e2e-request-001";
			const chatId = "e2e-chat-123";

			// 1. Initialize services
			const idempotencyService = new IdempotencyService({ maxSize: 100 });
			const rateLimitService = new RateLimitService({ workspaceLimit: 10 });
			const responseFileReader = new ResponseFileReader({
				ipcBasePath: testBaseDir,
				maxFileSize: 1024 * 100,
			});
			const cleanupService = new FileCleanupService({
				baseDir: testBaseDir,
				ttlMs: 5000,
				cleanupIntervalMs: 10000,
				enabled: false,
			});

			// 2. Simulate request processing (would be done by Agent)
			const responseDir = path.join(testBaseDir, workspace, "responses");
			await mkdir(responseDir, { recursive: true });

			const responseData = {
				requestId,
				chatId,
				workspace,
				timestamp: new Date().toISOString(),
				output: "End-to-end test completed successfully",
				exitCode: 0,
			};

			await writeFile(path.join(responseDir, `${requestId}.json`), JSON.stringify(responseData));

			// 3. Process callback (would be done by Gateway)
			// Check rate limit
			const rateLimitResult = rateLimitService.checkLimit(`${workspace}:${requestId}`, "workspace");
			expect(rateLimitResult.allowed).toBe(true);

			// Check idempotency
			const isDuplicate = idempotencyService.isDuplicate(requestId);
			expect(isDuplicate).toBe(false);
			idempotencyService.markProcessed(requestId);

			// Read response file
			const readResponse = await responseFileReader.readResponseFile(workspace, requestId);
			expect(readResponse.output).toContain("successfully");

			// 4. Cleanup (eventual file deletion)
			// Age the file
			const oldTime = Date.now() / 1000 - 10;
			await utimes(path.join(responseDir, `${requestId}.json`), oldTime, oldTime);

			await cleanupService.runCleanup();

			// Verify file was cleaned up
			let fileExists = true;
			try {
				await readFile(path.join(responseDir, `${requestId}.json`));
			} catch {
				fileExists = false;
			}
			expect(fileExists).toBe(false);

			// Cleanup services
			idempotencyService.stopCleanup();
			rateLimitService.stopCleanup();
		});

		test("should handle duplicate callback requests", async () => {
			const idempotencyService = new IdempotencyService({ maxSize: 100 });
			const responseFileReader = new ResponseFileReader({
				ipcBasePath: testBaseDir,
				maxFileSize: 1024 * 100,
			});

			const workspace = "duplicate-test";
			const requestId = "duplicate-001";

			// Create response file
			const responseDir = path.join(testBaseDir, workspace, "responses");
			await mkdir(responseDir, { recursive: true });

			const responseData = {
				requestId,
				chatId: "123",
				workspace,
				timestamp: new Date().toISOString(),
				output: "Duplicate test",
				exitCode: 0,
			};

			await writeFile(path.join(responseDir, `${requestId}.json`), JSON.stringify(responseData));

			// First callback
			const isDuplicate1 = idempotencyService.isDuplicate(requestId);
			expect(isDuplicate1).toBe(false);
			idempotencyService.markProcessed(requestId);

			// Read response
			const response1 = await responseFileReader.readResponseFile(workspace, requestId);
			expect(response1.requestId).toBe(requestId);

			// Second callback (duplicate)
			const isDuplicate2 = idempotencyService.isDuplicate(requestId);
			expect(isDuplicate2).toBe(true);

			// Cleanup
			idempotencyService.stopCleanup();
		});
	});
});
