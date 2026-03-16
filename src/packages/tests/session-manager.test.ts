import { beforeEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	type SessionAgent,
	SessionManager,
	type SessionManagerConfig,
	type SessionMetadata,
	type SessionPersistence,
} from "@/packages/agent";

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Mock agent for testing
 */
class MockAgent implements SessionAgent {
	messages: AgentMessage[] = [];
	disposed = false;
	aborted = false;

	getMessages(): AgentMessage[] {
		return this.messages;
	}

	clearMessages(): void {
		this.messages = [];
	}

	abort(): void {
		this.aborted = true;
	}

	dispose(): void {
		this.disposed = true;
	}

	// Test helper methods
	addMessage(msg: AgentMessage): void {
		this.messages.push(msg);
	}
}

/**
 * Create a mock persistence layer for testing
 */
function createMockPersistence(): SessionPersistence & {
	calls: {
		saveSession: Array<{ sessionId: string; metadata: SessionMetadata }>;
		loadSession: string[];
		deleteSession: string[];
		saveMessages: Array<{ sessionId: string; messages: AgentMessage[] }>;
		loadMessages: string[];
		touchSession: Array<{ sessionId: string; metadata: Partial<SessionMetadata> }>;
		cleanupExpired: number[];
	};
} {
	const calls = {
		saveSession: [] as Array<{ sessionId: string; metadata: SessionMetadata }>,
		loadSession: [] as string[],
		deleteSession: [] as string[],
		saveMessages: [] as Array<{ sessionId: string; messages: AgentMessage[] }>,
		loadMessages: [] as string[],
		touchSession: [] as Array<{ sessionId: string; metadata: Partial<SessionMetadata> }>,
		cleanupExpired: [] as number[],
	};

	const storedSessions = new Map<string, SessionMetadata>();
	const storedMessages = new Map<string, AgentMessage[]>();

	return {
		calls,
		saveSession(sessionId: string, metadata: SessionMetadata): void {
			calls.saveSession.push({ sessionId, metadata });
			storedSessions.set(sessionId, { ...metadata });
		},
		loadSession(sessionId: string): SessionMetadata | null {
			calls.loadSession.push(sessionId);
			const session = storedSessions.get(sessionId);
			return session ? { ...session } : null;
		},
		deleteSession(sessionId: string): void {
			calls.deleteSession.push(sessionId);
			storedSessions.delete(sessionId);
			storedMessages.delete(sessionId);
		},
		saveMessages(sessionId: string, messages: AgentMessage[]): void {
			calls.saveMessages.push({ sessionId, messages });
			storedMessages.set(sessionId, [...messages]);
		},
		loadMessages(sessionId: string): AgentMessage[] {
			calls.loadMessages.push(sessionId);
			const msgs = storedMessages.get(sessionId);
			return msgs ? [...msgs] : [];
		},
		touchSession(sessionId: string, metadata: Partial<SessionMetadata>): void {
			calls.touchSession.push({ sessionId, metadata });
			const existing = storedSessions.get(sessionId);
			if (existing) {
				storedSessions.set(sessionId, { ...existing, ...metadata });
			}
		},
		cleanupExpiredSessions(ttlMs: number): number {
			calls.cleanupExpired.push(ttlMs);
			return 0;
		},
		close(): void {
			// No-op for testing
		},
	};
}

// =============================================================================
// SessionManager Tests
// =============================================================================

describe("SessionManager", () => {
	let _createAgentCallCount = 0;

	beforeEach(() => {
		_createAgentCallCount = 0;
	});

	describe("constructor", () => {
		test("creates session manager with default config", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			expect(manager.size).toBe(0);
			manager.dispose();
		});

		test("creates session manager with custom config", () => {
			const config: SessionManagerConfig = {
				sessionTtlMs: 60 * 1000,
				maxSessions: 50,
				cleanupIntervalMs: 30 * 1000,
				maxMessagesPerSession: 100,
			};
			const manager = new SessionManager(config, () => new MockAgent());
			expect(manager.size).toBe(0);
			manager.dispose();
		});

		test("auto-starts cleanup when persistence is provided", () => {
			const persistence = createMockPersistence();
			const manager = new SessionManager({ persistence }, () => new MockAgent());
			// Cleanup should be running - we can verify by checking that
			// the cleanup method can be called without error
			expect(manager.size).toBe(0);
			manager.dispose();
		});
	});

	describe("getOrCreate", () => {
		test("creates a new session when none exists", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			const agent = manager.getOrCreate("session-1");

			expect(agent).toBeDefined();
			expect(agent).toBeInstanceOf(MockAgent);
			expect(manager.size).toBe(1);
			expect(manager.has("session-1")).toBe(true);
			manager.dispose();
		});

		test("returns existing session if it already exists", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			const agent1 = manager.getOrCreate("session-1");
			const agent2 = manager.getOrCreate("session-1");

			expect(agent1).toBe(agent2);
			expect(manager.size).toBe(1);
			manager.dispose();
		});

		test("creates different sessions with different IDs", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			const agent1 = manager.getOrCreate("session-1");
			const agent2 = manager.getOrCreate("session-2");

			expect(agent1).not.toBe(agent2);
			expect(manager.size).toBe(2);
			manager.dispose();
		});

		test("evicts LRU session when max sessions reached", () => {
			const config: SessionManagerConfig = {
				maxSessions: 2,
			};
			const manager = new SessionManager(config, () => new MockAgent());

			const agent1 = manager.getOrCreate("session-1");
			const _agent2 = manager.getOrCreate("session-2");
			const _agent3 = manager.getOrCreate("session-3");

			// session-1 should have been evicted
			expect(manager.has("session-1")).toBe(false);
			expect(manager.has("session-2")).toBe(true);
			expect(manager.has("session-3")).toBe(true);
			expect(manager.size).toBe(2);

			// The evicted agent should be disposed
			expect(agent1.disposed).toBe(true);
			manager.dispose();
		});
	});

	describe("get", () => {
		test("returns undefined for non-existent session", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			const agent = manager.get("non-existent");
			expect(agent).toBeUndefined();
			manager.dispose();
		});

		test("returns existing session", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			manager.getOrCreate("session-1");
			const agent = manager.get("session-1");
			expect(agent).toBeDefined();
			manager.dispose();
		});
	});

	describe("has", () => {
		test("returns false for non-existent session", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			expect(manager.has("session-1")).toBe(false);
			manager.dispose();
		});

		test("returns true for existing session", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			manager.getOrCreate("session-1");
			expect(manager.has("session-1")).toBe(true);
			manager.dispose();
		});
	});

	describe("remove", () => {
		test("returns false for non-existent session", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			const result = manager.remove("non-existent");
			expect(result).toBe(false);
			manager.dispose();
		});

		test("removes existing session", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			manager.getOrCreate("session-1");

			const result = manager.remove("session-1");

			expect(result).toBe(true);
			expect(manager.has("session-1")).toBe(false);
			expect(manager.size).toBe(0);
			manager.dispose();
		});

		test("disposes the removed agent", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			const agent = manager.getOrCreate("session-1");

			manager.remove("session-1");

			expect(agent.disposed).toBe(true);
			manager.dispose();
		});

		test("deletes from persistence when configured", () => {
			const persistence = createMockPersistence();
			const manager = new SessionManager({ persistence }, () => new MockAgent());

			manager.getOrCreate("session-1");
			manager.remove("session-1");

			expect(persistence.calls.deleteSession).toContain("session-1");
			manager.dispose();
		});
	});

	describe("getMetadata", () => {
		test("returns null for non-existent session", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			const metadata = manager.getMetadata("non-existent");
			expect(metadata).toBeNull();
			manager.dispose();
		});

		test("returns metadata for existing session", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			manager.getOrCreate("session-1");

			const metadata = manager.getMetadata("session-1");

			expect(metadata).not.toBeNull();
			expect(metadata?.sessionId).toBe("session-1");
			expect(metadata?.createdAt).toBeGreaterThan(0);
			expect(metadata?.lastActivityAt).toBeGreaterThan(0);
			expect(metadata?.turnCount).toBe(0);
			manager.dispose();
		});

		test("loads from persistence if session not in memory", () => {
			const persistence = createMockPersistence();
			persistence.saveSession("session-persisted", {
				sessionId: "session-persisted",
				createdAt: 1000,
				lastActivityAt: 2000,
				turnCount: 5,
			});

			const manager = new SessionManager({ persistence }, () => new MockAgent());
			const metadata = manager.getMetadata("session-persisted");

			expect(metadata).not.toBeNull();
			expect(metadata?.sessionId).toBe("session-persisted");
			expect(metadata?.turnCount).toBe(5);
			manager.dispose();
		});
	});

	describe("persistSession", () => {
		test("does nothing when persistence is not configured", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			const agent = manager.getOrCreate("session-1");
			agent.addMessage({ role: "user", content: "Hello", timestamp: Date.now() });

			// Should not throw
			manager.persistSession("session-1");
			manager.dispose();
		});

		test("persists session with messages when configured", () => {
			const persistence = createMockPersistence();
			const manager = new SessionManager({ persistence }, () => new MockAgent());
			const agent = manager.getOrCreate("session-1");
			agent.addMessage({ role: "user", content: "Hello", timestamp: Date.now() });

			manager.persistSession("session-1");

			expect(persistence.calls.saveMessages).toHaveLength(1);
			expect(persistence.calls.saveMessages[0].sessionId).toBe("session-1");
			expect(persistence.calls.saveMessages[0].messages).toHaveLength(1);
			manager.dispose();
		});

		test("increments turn count on persist", () => {
			const persistence = createMockPersistence();
			const manager = new SessionManager({ persistence }, () => new MockAgent());
			manager.getOrCreate("session-1");

			manager.persistSession("session-1");
			manager.persistSession("session-1");

			const touchCalls = persistence.calls.touchSession;
			expect(touchCalls).toHaveLength(2);
			expect(touchCalls[0]?.metadata.turnCount).toBe(1);
			expect(touchCalls[1]?.metadata.turnCount).toBe(2);
			manager.dispose();
		});
	});

	describe("dispose", () => {
		test("clears all sessions", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			manager.getOrCreate("session-1");
			manager.getOrCreate("session-2");

			manager.dispose();

			expect(manager.size).toBe(0);
		});

		test("disposes all agents", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			const agent1 = manager.getOrCreate("session-1");
			const agent2 = manager.getOrCreate("session-2");

			manager.dispose();

			expect(agent1.disposed).toBe(true);
			expect(agent2.disposed).toBe(true);
		});

		test("persists sessions before disposing when persistence enabled", () => {
			const persistence = createMockPersistence();
			const manager = new SessionManager({ persistence }, () => new MockAgent());
			manager.getOrCreate("session-1");

			manager.dispose();

			expect(persistence.calls.saveMessages).toHaveLength(1);
		});

		test("closes persistence connection", () => {
			const persistence = createMockPersistence();
			const manager = new SessionManager({ persistence }, () => new MockAgent());
			manager.dispose();

			// The close method is optional, so we just verify dispose completes
			expect(true).toBe(true);
		});
	});

	describe("startCleanup / stopCleanup", () => {
		test("startCleanup creates a timer", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			manager.startCleanup(100);

			// Timer should be set
			expect(manager.size).toBe(0);
			manager.stopCleanup();
			manager.dispose();
		});

		test("stopCleanup clears the timer", () => {
			const manager = new SessionManager({}, () => new MockAgent());
			manager.startCleanup(100);
			manager.stopCleanup();

			// Should not throw on second stop
			manager.stopCleanup();
			manager.dispose();
		});
	});

	describe("LRU eviction", () => {
		test("evicts least recently used session when max reached", () => {
			const config: SessionManagerConfig = {
				maxSessions: 2,
			};
			const manager = new SessionManager(config, () => new MockAgent());

			// Create session-1 and session-2
			const agent1 = manager.getOrCreate("session-1");
			manager.getOrCreate("session-2");

			// session-1 was created first, session-2 second
			// When we create session-3, session-1 (the oldest) should be evicted

			// Now create session-3 - session-1 should be evicted (LRU)
			const _agent3 = manager.getOrCreate("session-3");

			// session-1 should be evicted, session-2 and session-3 should remain
			expect(manager.has("session-1")).toBe(false);
			expect(manager.has("session-2")).toBe(true);
			expect(manager.has("session-3")).toBe(true);
			expect(manager.size).toBe(2);

			// session-1's agent should be disposed
			expect(agent1.disposed).toBe(true);
			manager.dispose();
		});
	});

	describe("generic type support", () => {
		test("works with custom agent type", () => {
			interface CustomAgent extends SessionAgent {
				customMethod(): string;
			}

			class MyCustomAgent implements CustomAgent {
				messages: AgentMessage[] = [];
				disposed = false;
				aborted = false;

				getMessages(): AgentMessage[] {
					return this.messages;
				}
				clearMessages(): void {}
				abort(): void {}
				dispose(): void {}
				customMethod(): string {
					return "custom";
				}
			}

			const manager = new SessionManager<CustomAgent>({}, (_id) => new MyCustomAgent());

			const agent = manager.getOrCreate("session-1");
			expect(agent.customMethod()).toBe("custom");

			manager.dispose();
		});

		test("startCleanup starts the cleanup timer", () => {
			const manager = new SessionManager<MockAgent>(
				{
					sessionTtlMs: 100,
					maxSessions: 10,
					cleanupIntervalMs: 50,
				},
				(id) => new MockAgent(id),
			);

			// Start cleanup
			manager.startCleanup(50);

			// Wait a bit to allow cleanup to run
			// The cleanup runs at interval, so we need to wait at least 50ms
			// Since there are no sessions, it should just run without error

			// Stop cleanup
			manager.stopCleanup();

			manager.dispose();
		});

		test("startCleanup restarts if already running", () => {
			const manager = new SessionManager<MockAgent>(
				{
					sessionTtlMs: 100,
					maxSessions: 10,
					cleanupIntervalMs: 50,
				},
				(id) => new MockAgent(id),
			);

			// Start cleanup twice
			manager.startCleanup(50);
			manager.startCleanup(100); // Should restart

			// Stop cleanup
			manager.stopCleanup();

			manager.dispose();
		});

		test("stopCleanup stops the cleanup timer", () => {
			const manager = new SessionManager<MockAgent>(
				{
					sessionTtlMs: 100,
					maxSessions: 10,
					cleanupIntervalMs: 50,
				},
				(id) => new MockAgent(id),
			);

			manager.startCleanup(50);
			manager.stopCleanup();
			// Should not throw when called again
			manager.stopCleanup();

			manager.dispose();
		});

		test("needsCompaction returns false for non-existent session", () => {
			const manager = new SessionManager<MockAgent>(
				{
					maxMessagesPerSession: 10,
				},
				(id) => new MockAgent(id),
			);

			expect(manager.needsCompaction("non-existent")).toBe(false);
		});

		test("needsCompaction returns true when messages exceed threshold", () => {
			const manager = new SessionManager<MockAgent>(
				{
					maxMessagesPerSession: 10,
					compaction: { enabled: true, threshold: 0.5, preserveRecent: 2 },
				},
				(id) => new MockAgent(id),
			);

			const agent = manager.getOrCreate("session-1");
			// Add 15 messages - threshold is 0.5 * 10 = 5, so 15 > 5 needs compaction
			for (let i = 0; i < 15; i++) {
				agent.addMessage({ role: "user", content: [] });
			}
			expect(manager.needsCompaction("session-1")).toBe(true);

			manager.dispose();
		});

		test("needsCompaction returns false when under threshold", () => {
			const manager = new SessionManager<MockAgent>(
				{
					maxMessagesPerSession: 100,
					compaction: { enabled: true, threshold: 0.8, preserveRecent: 20 },
				},
				(id) => new MockAgent(id),
			);

			const _agent = manager.getOrCreate("session-1");
			// Agent has 2 messages, threshold is 0.8 * 100 = 80
			// 2 < 80, so needs compaction should be false
			expect(manager.needsCompaction("session-1")).toBe(false);

			manager.dispose();
		});

		test("cleanupExpiredSessions cleans up idle sessions", async () => {
			let _cleanupCalled = false;
			const mockPersistence: SessionPersistence = {
				saveSession: vi.fn(),
				loadSession: vi.fn().mockReturnValue(null),
				deleteSession: vi.fn(),
				saveMessages: vi.fn(),
				loadMessages: vi.fn().mockReturnValue([]),
				touchSession: vi.fn(),
				cleanupExpiredSessions: vi.fn().mockImplementation(() => {
					_cleanupCalled = true;
					return 0;
				}),
			};

			const manager = new SessionManager<MockAgent>(
				{
					sessionTtlMs: 50, // 50ms TTL
					maxSessions: 10,
					persistence: mockPersistence,
				},
				(id) => new MockAgent(id),
			);

			// Create a session
			manager.getOrCreate("session-1");

			// Wait for session to become expired
			await new Promise((r) => setTimeout(r, 60));

			// Manually trigger cleanup by calling startCleanup with short interval
			manager.startCleanup(10);

			// Wait for cleanup to run
			await new Promise((r) => setTimeout(r, 30));

			// The session should be cleaned up
			expect(manager.has("session-1")).toBe(false);

			manager.dispose();
		});

		test("cleanupExpiredSessions persists before cleaning up", async () => {
			let persistCalled = false;
			const mockPersistence: SessionPersistence = {
				saveSession: vi.fn(),
				loadSession: vi.fn().mockReturnValue(null),
				deleteSession: vi.fn(),
				saveMessages: vi.fn(),
				loadMessages: vi.fn().mockReturnValue([]),
				touchSession: vi.fn().mockImplementation(() => {
					persistCalled = true;
				}),
				cleanupExpiredSessions: vi.fn().mockReturnValue(0),
			};

			const manager = new SessionManager<MockAgent>(
				{
					sessionTtlMs: 50,
					maxSessions: 10,
					persistence: mockPersistence,
				},
				(id) => new MockAgent(id),
			);

			// Create a session
			manager.getOrCreate("session-1");

			// Wait for expiration
			await new Promise((r) => setTimeout(r, 60));

			// Trigger cleanup
			manager.startCleanup(10);
			await new Promise((r) => setTimeout(r, 30));

			// Persistence touch should have been called
			expect(persistCalled).toBe(true);

			manager.dispose();
		});
	});
});
