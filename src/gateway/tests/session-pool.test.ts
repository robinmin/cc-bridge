import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionPoolService } from "@/gateway/services/SessionPoolService";
import { TmuxManager } from "@/gateway/services/tmux-manager";

// Mock TmuxManager
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

describe("SessionPoolService", () => {
	let sessionPool: SessionPoolService;
	let mockTmux: MockTmuxManager;
	const containerId = "test-container-123";

	beforeEach(async () => {
		mockTmux = new MockTmuxManager();
		sessionPool = new SessionPoolService(mockTmux as unknown as TmuxManager, {
			containerId,
			maxSessions: 5,
			inactivityTimeoutMs: 1000,
			enableAutoCleanup: false, // Disable auto cleanup for tests
		});
		await sessionPool.start();
	});

	afterEach(async () => {
		await sessionPool.stop();
	});

	test("should create session on first request", async () => {
		const session = await sessionPool.getOrCreateSession("test-workspace");

		expect(session.workspace).toBe("test-workspace");
		expect(session.sessionName).toBe("claude-test-workspace");
		expect(session.containerId).toBe(containerId);
		expect(session.activeRequests).toBe(0);
		expect(session.totalRequests).toBe(0);
		expect(session.status).toBe("active");

		// Verify tmux session was created
		expect(mockTmux.sessions.has("claude-test-workspace")).toBe(true);
	});

	test("should reuse existing session", async () => {
		const session1 = await sessionPool.getOrCreateSession("project-a");
		const session2 = await sessionPool.getOrCreateSession("project-a");

		// Should be the same session (same createdAt)
		expect(session1.sessionName).toBe(session2.sessionName);
		expect(session1.createdAt).toBe(session2.createdAt);

		// totalRequests is only incremented by trackRequestStart
		// Since we haven't called trackRequestStart, it should be 0
		expect(session1.totalRequests).toBe(0);
		expect(session2.totalRequests).toBe(0);

		// Should only create one tmux session
		expect(mockTmux.sessions.size).toBe(1);
	});

	test("should reject invalid workspace names", async () => {
		const invalidNames = [
			"../etc/passwd",
			"workspace with spaces",
			"workspace@special",
			"../../etc",
			"",
			"a".repeat(100), // Too long
		];

		for (const name of invalidNames) {
			await expect(sessionPool.getOrCreateSession(name)).rejects.toThrow("Invalid workspace name");
		}
	});

	test("should enforce session limit", async () => {
		// Create 5 sessions (at limit)
		for (let i = 0; i < 5; i++) {
			await sessionPool.getOrCreateSession(`workspace-${i}`);
		}

		expect(sessionPool.getStats().totalSessions).toBe(5);

		// 6th session should fail
		await expect(sessionPool.getOrCreateSession("workspace-too-many")).rejects.toThrow("Session limit reached");
	});

	test("should track request start and complete", async () => {
		const session = await sessionPool.getOrCreateSession("test-workspace");

		expect(session.activeRequests).toBe(0);

		sessionPool.trackRequestStart("test-workspace");
		expect(session.activeRequests).toBe(1);
		expect(session.totalRequests).toBe(1);
		expect(session.status).toBe("active");

		sessionPool.trackRequestComplete("test-workspace");
		expect(session.activeRequests).toBe(0);
		expect(session.totalRequests).toBe(1);
		expect(session.status).toBe("idle");
	});

	test("should delete session", async () => {
		await sessionPool.getOrCreateSession("temp-workspace");

		expect(sessionPool.getSession("temp-workspace")).toBeDefined();

		await sessionPool.deleteSession("temp-workspace");

		expect(sessionPool.getSession("temp-workspace")).toBeUndefined();
		expect(mockTmux.killedSessions).toContain("claude-temp-workspace");
	});

	test("should not delete session with active requests", async () => {
		const _session = await sessionPool.getOrCreateSession("active-workspace");

		sessionPool.trackRequestStart("active-workspace");

		await expect(sessionPool.deleteSession("active-workspace")).rejects.toThrow("active requests");

		// Release request
		sessionPool.trackRequestComplete("active-workspace");

		// Now should be deletable
		await sessionPool.deleteSession("active-workspace");
	});

	test("should fail to delete non-existent session", async () => {
		await expect(sessionPool.deleteSession("non-existent")).rejects.toThrow("Session not found");
	});

	test("should list all sessions", async () => {
		await sessionPool.getOrCreateSession("workspace-1");
		await sessionPool.getOrCreateSession("workspace-2");
		await sessionPool.getOrCreateSession("workspace-3");

		const sessions = sessionPool.listSessions();

		expect(sessions).toHaveLength(3);
		expect(sessions.map((s) => s.workspace)).toEqual(
			expect.arrayContaining(["workspace-1", "workspace-2", "workspace-3"]),
		);
	});

	test("should get session metadata", async () => {
		await sessionPool.getOrCreateSession("my-workspace");

		const session = sessionPool.getSession("my-workspace");

		expect(session).toBeDefined();
		expect(session?.workspace).toBe("my-workspace");
		expect(session?.sessionName).toBe("claude-my-workspace");
	});

	test("should return undefined for non-existent session", () => {
		const session = sessionPool.getSession("non-existent");
		expect(session).toBeUndefined();
	});

	test("should return correct statistics", async () => {
		await sessionPool.getOrCreateSession("ws-1");
		await sessionPool.getOrCreateSession("ws-2");

		sessionPool.trackRequestStart("ws-1");
		sessionPool.trackRequestStart("ws-2");
		sessionPool.trackRequestStart("ws-1");

		const stats = sessionPool.getStats();

		expect(stats.totalSessions).toBe(2);
		expect(stats.activeSessions).toBe(2);
		expect(stats.idleSessions).toBe(0);
		expect(stats.totalRequests).toBe(3); // 3 trackRequestStart calls
		expect(stats.activeRequests).toBe(3);
		expect(stats.maxSessions).toBe(5);
	});

	test("should discover existing sessions on startup", async () => {
		// Pre-populate tmux with sessions
		mockTmux.sessions.set("claude-existing-1", true);
		mockTmux.sessions.set("claude-existing-2", true);

		// Create new session pool service
		const pool2 = new SessionPoolService(mockTmux as unknown as TmuxManager, {
			containerId,
			maxSessions: 10,
			enableAutoCleanup: false,
		});

		await pool2.start();

		// Should discover existing sessions
		expect(pool2.getSession("existing-1")).toBeDefined();
		expect(pool2.getSession("existing-2")).toBeDefined();

		// Should create claude-* sessions
		expect(pool2.getSession("existing-1")?.sessionName).toBe("claude-existing-1");
		expect(pool2.getSession("existing-2")?.sessionName).toBe("claude-existing-2");

		await pool2.stop();
	});

	test("should cleanup inactive sessions", async () => {
		// Create a session
		const session = await sessionPool.getOrCreateSession("temp-session");

		// Manually set last activity to old time
		session.lastActivityAt = Date.now() - 2000; // 2 seconds ago (timeout is 1000ms)
		session.activeRequests = 0;

		// Run cleanup
		await sessionPool.cleanupInactiveSessions();

		// Session should be deleted
		expect(sessionPool.getSession("temp-session")).toBeUndefined();
		expect(mockTmux.killedSessions).toContain("claude-temp-session");
	});

	test("should not cleanup sessions with active requests", async () => {
		const session = await sessionPool.getOrCreateSession("active-session");

		// Set old time but with active requests
		session.lastActivityAt = Date.now() - 2000;
		session.activeRequests = 3;

		// Run cleanup
		await sessionPool.cleanupInactiveSessions();

		// Session should still exist
		expect(sessionPool.getSession("active-session")).toBeDefined();
	});

	test("should stop service and terminate all sessions", async () => {
		await sessionPool.getOrCreateSession("ws-1");
		await sessionPool.getOrCreateSession("ws-2");

		expect(sessionPool.getStats().totalSessions).toBe(2);

		await sessionPool.stop();

		// All sessions should be killed
		expect(mockTmux.killedSessions).toContain("claude-ws-1");
		expect(mockTmux.killedSessions).toContain("claude-ws-2");
		expect(sessionPool.getStats().totalSessions).toBe(0);
	});

	test("should not start twice", async () => {
		expect(sessionPool.isRunning()).toBe(true);

		await sessionPool.start();

		// Should not start again (returns early, doesn't discover new sessions)
		const _initialSessionCount = mockTmux.sessions.size;
		mockTmux.sessions.set("claude-pre-existing", true);

		await sessionPool.start();

		// Session pool already started, so pre-existing session is NOT discovered
		// (start() returns early when already started)
		expect(sessionPool.getSession("pre-existing")).toBeUndefined();
	});

	test("should throw error without containerId", () => {
		const tmux = new TmuxManager();

		expect(
			() =>
				new SessionPoolService(tmux, {
					maxSessions: 5,
				}),
		).toThrow("containerId is required");
	});
});
