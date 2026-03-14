import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { TmuxManager } from "@/gateway/services/tmux-manager";

// Mock TmuxManager
const mockTmuxManager = {
	createWorkspaceSession: mock(async () => {}),
	killWorkspaceSession: mock(async () => {}),
	listAllSessions: mock(async () => []),
};

mock.module("./tmux-manager", () => ({
	TmuxManager: class MockTmuxManager {
		constructor() {
			// biome-ignore lint/correctness/noConstructorReturn: intentional mock - returns existing object for test isolation
			return mockTmuxManager as unknown as MockTmuxManager;
		}
	},
}));

// Now import after mocking
import { type SessionPoolConfig, SessionPoolService } from "@/gateway/services/SessionPoolService";

describe("SessionPoolService", () => {
	const mockTmux = {
		createWorkspaceSession: mock(async () => {}),
		killWorkspaceSession: mock(async () => {}),
		listAllSessions: mock(async () => []),
	};

	beforeEach(() => {
		mockTmux.createWorkspaceSession.mockClear();
		mockTmux.killWorkspaceSession.mockClear();
		mockTmux.listAllSessions.mockClear();
	});

	describe("constructor", () => {
		test("throws error when containerId is missing", () => {
			expect(() => new SessionPoolService({} as TmuxManager, {})).toThrow("containerId is required");
		});

		test("creates service with default config", () => {
			const service = new SessionPoolService({} as TmuxManager, { containerId: "test-container" });
			expect(service).toBeDefined();
		});

		test("creates service with custom config", () => {
			const config: Partial<SessionPoolConfig> = {
				containerId: "test-container",
				maxSessions: 10,
				inactivityTimeoutMs: 60000,
				cleanupIntervalMs: 30000,
				enableAutoCleanup: false,
			};
			const service = new SessionPoolService({} as TmuxManager, config);
			expect(service).toBeDefined();
		});

		test("applies default values for missing config", () => {
			const service = new SessionPoolService({} as TmuxManager, { containerId: "test-container" });
			expect((service as unknown as { config: SessionPoolConfig }).config.maxSessions).toBe(50);
			expect((service as unknown as { config: SessionPoolConfig }).config.inactivityTimeoutMs).toBe(3600000);
			expect((service as unknown as { config: SessionPoolConfig }).config.cleanupIntervalMs).toBe(300000);
			expect((service as unknown as { config: SessionPoolConfig }).config.enableAutoCleanup).toBe(true);
		});
	});

	describe("start", () => {
		test("does nothing if already started", async () => {
			mockTmux.listAllSessions.mockClear();
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			(service as unknown as { started: boolean }).started = true;

			await service.start();

			expect(mockTmux.listAllSessions).not.toHaveBeenCalled();
		});

		test("starts service and discovers existing sessions", async () => {
			mockTmux.listAllSessions.mockResolvedValue([]);

			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, {
				containerId: "test",
				enableAutoCleanup: false,
			});
			await service.start();

			expect(service.isRunning()).toBe(true);
		});

		test("starts cleanup timer when autoCleanup enabled", async () => {
			mockTmux.listAllSessions.mockResolvedValue([]);
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, {
				containerId: "test",
				enableAutoCleanup: true,
			});
			await service.start();

			expect(service.isRunning()).toBe(true);
			await service.stop();
		});
	});

	describe("stop", () => {
		test("does nothing if not started", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			await service.stop();

			expect(service.isRunning()).toBe(false);
		});

		test("stops service and clears timer", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, {
				containerId: "test",
				enableAutoCleanup: true,
			});
			await service.start();
			await service.stop();

			expect(service.isRunning()).toBe(false);
			expect((service as unknown as { cleanupTimer: ReturnType<typeof setInterval> | null }).cleanupTimer).toBeNull();
		});

		test("terminates all sessions on stop", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, {
				containerId: "test",
				enableAutoCleanup: false,
			});
			await service.start();
			await service.getOrCreateSession("test-workspace");
			await service.stop();

			expect(mockTmux.killWorkspaceSession).toHaveBeenCalled();
		});
	});

	describe("cleanup", () => {
		test("does nothing if already destroyed", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			(service as unknown as { destroyed: boolean }).destroyed = true;

			await service.cleanup();

			expect(mockTmux.killWorkspaceSession).not.toHaveBeenCalled();
		});

		test("clears all sessions and resources", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, {
				containerId: "test",
				enableAutoCleanup: true,
			});
			await service.start();
			await service.cleanup();

			expect(service.isDestroyed()).toBe(true);
			expect(service.isRunning()).toBe(false);
		});
	});

	describe("getOrCreateSession", () => {
		test("throws error for invalid workspace name", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });

			await expect(service.getOrCreateSession("")).rejects.toThrow("Invalid workspace name");
			await expect(service.getOrCreateSession("invalid name")).rejects.toThrow("Invalid workspace name");
			await expect(service.getOrCreateSession("a".repeat(65))).rejects.toThrow("Invalid workspace name");
		});

		test("reuses existing session", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			await service.start();

			const session1 = await service.getOrCreateSession("my-workspace");
			const session2 = await service.getOrCreateSession("my-workspace");

			expect(session1).toBe(session2);
			expect(mockTmux.createWorkspaceSession).toHaveBeenCalledTimes(1);
		});

		test("creates new session when none exists", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			await service.start();

			const session = await service.getOrCreateSession("new-workspace");

			expect(session.workspace).toBe("new-workspace");
			expect(session.sessionName).toBe("claude-new-workspace");
			expect(session.status).toBe("active");
			expect(mockTmux.createWorkspaceSession).toHaveBeenCalled();
		});

		test("throws error when session limit reached", async () => {
			mockTmux.listAllSessions.mockResolvedValue([]);
			const limitedTmux = {
				...mockTmux,
				createWorkspaceSession: mock(async () => {}),
			};
			const service = new SessionPoolService(limitedTmux as unknown as TmuxManager, {
				containerId: "test",
				maxSessions: 1,
			});
			await service.start();
			await service.getOrCreateSession("workspace1");

			await expect(service.getOrCreateSession("workspace2")).rejects.toThrow("Session limit reached");
		});

		test("handles concurrent creation requests", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			await service.start();

			// Create two sessions concurrently
			const [session1, session2] = await Promise.all([
				service.getOrCreateSession("concurrent-ws"),
				service.getOrCreateSession("concurrent-ws"),
			]);

			// Should be the same session
			expect(session1).toBe(session2);
			expect(mockTmux.createWorkspaceSession).toHaveBeenCalledTimes(1);
		});
	});

	describe("getSession", () => {
		test("returns undefined for non-existent session", () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });

			expect(service.getSession("nonexistent")).toBeUndefined();
		});

		test("returns session metadata", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			await service.start();
			await service.getOrCreateSession("my-workspace");

			const session = service.getSession("my-workspace");
			expect(session).toBeDefined();
			expect(session?.workspace).toBe("my-workspace");
		});
	});

	describe("listSessions", () => {
		test("returns empty array when no sessions", () => {
			mockTmux.listAllSessions.mockResolvedValue([]);
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });

			expect(service.listSessions()).toEqual([]);
		});

		test("returns all sessions", async () => {
			mockTmux.listAllSessions.mockResolvedValue([]);
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			await service.start();
			await service.getOrCreateSession("ws1");
			await service.getOrCreateSession("ws2");

			const sessions = service.listSessions();
			expect(sessions.length).toBe(2);
		});
	});

	describe("switchWorkspace", () => {
		test("switches to target workspace", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			await service.start();

			const session = await service.switchWorkspace("current", "target");

			expect(session.workspace).toBe("target");
		});
	});

	describe("deleteSession", () => {
		test("throws error for non-existent session", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			await service.start();

			await expect(service.deleteSession("nonexistent")).rejects.toThrow("Session not found");
		});

		test("throws error when session has active requests", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			await service.start();
			await service.getOrCreateSession("active-ws");
			service.trackRequestStart("active-ws");

			await expect(service.deleteSession("active-ws")).rejects.toThrow("Cannot delete session with active requests");
		});

		test("deletes session successfully", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			await service.start();
			await service.getOrCreateSession("to-delete");

			await service.deleteSession("to-delete");

			expect(service.getSession("to-delete")).toBeUndefined();
			expect(mockTmux.killWorkspaceSession).toHaveBeenCalled();
		});
	});

	describe("trackRequestStart/trackRequestComplete", () => {
		test("tracks request start", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			await service.start();
			await service.getOrCreateSession("tracking-ws");

			service.trackRequestStart("tracking-ws");

			const session = service.getSession("tracking-ws");
			expect(session?.activeRequests).toBe(1);
			expect(session?.totalRequests).toBe(1);
			expect(session?.status).toBe("active");
		});

		test("tracks request completion", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });
			await service.start();
			await service.getOrCreateSession("tracking-ws");
			service.trackRequestStart("tracking-ws");

			service.trackRequestComplete("tracking-ws");

			const session = service.getSession("tracking-ws");
			expect(session?.activeRequests).toBe(0);
			expect(session?.status).toBe("idle");
		});

		test("handles trackRequestComplete for non-existent session", () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });

			// Should not throw
			service.trackRequestComplete("nonexistent");
		});
	});

	describe("getStats", () => {
		test("returns correct statistics", async () => {
			mockTmux.listAllSessions.mockResolvedValue([]);
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, {
				containerId: "test",
				maxSessions: 100,
			});
			await service.start();
			await service.getOrCreateSession("ws1");
			service.trackRequestStart("ws1");

			const stats = service.getStats();

			expect(stats.totalSessions).toBe(1);
			expect(stats.activeSessions).toBe(1);
			expect(stats.idleSessions).toBe(0);
			expect(stats.totalRequests).toBe(1);
			expect(stats.activeRequests).toBe(1);
			expect(stats.maxSessions).toBe(100);
			expect(stats.destroyed).toBe(false);
			expect(stats.started).toBe(true);
		});
	});

	describe("isRunning/isDestroyed", () => {
		test("returns correct state", async () => {
			const service = new SessionPoolService(mockTmux as unknown as TmuxManager, { containerId: "test" });

			expect(service.isRunning()).toBe(false);
			expect(service.isDestroyed()).toBe(false);

			await service.start();
			expect(service.isRunning()).toBe(true);

			await service.stop();
			expect(service.isRunning()).toBe(false);
		});
	});
});
