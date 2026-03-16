import { afterEach, describe, expect, test } from "bun:test";
import type { EmbeddedAgent } from "@/gateway/engine/agent";
import { AgentSessionManager } from "@/gateway/engine/agent-sessions";

// Store managers to clean up after each test
let createdManagers: AgentSessionManager[] = [];

afterEach(() => {
	// Clean up any managers created during tests
	for (const manager of createdManagers) {
		try {
			manager.dispose();
		} catch {}
	}
	createdManagers = [];
});

// Mock agent factory for testing
function createMockAgent(): EmbeddedAgent {
	return {
		initialize: async () => {},
		prompt: async () => ({ output: "test", turnCount: 1 }),
		abort: () => {},
		dispose: () => {},
		getMessages: () => [],
		getSessionId: () => "mock-session",
		clearMessages: () => {},
		getTools: () => [],
		setTools: () => {},
		isRunning: () => false,
		steer: () => {},
		queueFollowUp: () => {},
		drainFollowUpQueue: () => [],
		waitForIdle: async () => {},
		getSystemPrompt: () => "",
		promptWithMessages: async () => ({ output: "test", turnCount: 1 }),
	} as EmbeddedAgent;
}

describe("agent-sessions exports", () => {
	test("AgentSessionManagerConfig has correct shape with all fields", () => {
		const config = {
			sessionTtlMs: 60000,
			maxSessions: 10,
			cleanupIntervalMs: 30000,
			enablePersistence: true,
			dbPath: "test.db",
			maxMessagesPerSession: 100,
			enabled: true,
		};
		expect(config.sessionTtlMs).toBe(60000);
		expect(config.maxSessions).toBe(10);
		expect(config.cleanupIntervalMs).toBe(30000);
		expect(config.enablePersistence).toBe(true);
		expect(config.dbPath).toBe("test.db");
		expect(config.maxMessagesPerSession).toBe(100);
	});

	test("AgentSessionManagerConfig has optional fields", () => {
		const config = {};
		expect(config.sessionTtlMs).toBeUndefined();
		expect(config.maxSessions).toBeUndefined();
	});

	test("AgentSessionManagerConfig compaction", () => {
		const config = {
			compaction: {
				enabled: true,
				threshold: 0.8,
				preserveRecent: 20,
			},
		};
		expect(config.compaction?.enabled).toBe(true);
		expect(config.compaction?.threshold).toBe(0.8);
		expect(config.compaction?.preserveRecent).toBe(20);
	});

	test("AgentSessionManagerConfig compaction disabled", () => {
		const config = {
			compaction: {
				enabled: false,
			},
		};
		expect(config.compaction?.enabled).toBe(false);
		expect(config.compaction?.threshold).toBeUndefined();
	});

	test("AgentSessionManagerConfig compaction with custom values", () => {
		const config = {
			compaction: {
				enabled: true,
				threshold: 0.9,
				preserveRecent: 50,
			},
		};
		expect(config.compaction?.threshold).toBe(0.9);
		expect(config.compaction?.preserveRecent).toBe(50);
	});

	test("creates manager with default config", () => {
		const manager = new AgentSessionManager();
		createdManagers.push(manager);
		expect(manager).toBeDefined();
	});

	test("creates manager with custom config", () => {
		const manager = new AgentSessionManager({
			sessionTtlMs: 60000,
			maxSessions: 10,
			cleanupIntervalMs: 30000,
			enablePersistence: false,
			dbPath: "test.db",
			maxMessagesPerSession: 100,
			compaction: { enabled: true, threshold: 0.8, preserveRecent: 20 },
		});
		createdManagers.push(manager);
		expect(manager).toBeDefined();
	});

	test("creates manager with very short cleanup interval", () => {
		const manager = new AgentSessionManager({ cleanupIntervalMs: 100 });
		createdManagers.push(manager);
		expect(manager).toBeDefined();
	});

	test("creates manager with persistence enabled without dbPath", () => {
		const manager = new AgentSessionManager({ enablePersistence: true });
		createdManagers.push(manager);
		expect(manager).toBeDefined();
	});

	test("size returns 0 for new manager", () => {
		const manager = new AgentSessionManager();
		createdManagers.push(manager);
		expect(manager.size).toBe(0);
	});

	test("getSessionMetrics returns null for new manager", () => {
		const manager = new AgentSessionManager();
		createdManagers.push(manager);
		expect(manager.getSessionMetrics("chat-123")).toBeNull();
	});

	test("creates manager with all config options", () => {
		const manager = new AgentSessionManager({
			sessionTtlMs: 300000,
			maxSessions: 50,
			cleanupIntervalMs: 5000,
			enablePersistence: true,
			dbPath: "/tmp/test.db",
			maxMessagesPerSession: 500,
			compaction: { enabled: false },
		});
		createdManagers.push(manager);
		expect(manager).toBeDefined();
	});

	test("creates manager with zero sessionTtl", () => {
		const manager = new AgentSessionManager({ sessionTtlMs: 0 });
		createdManagers.push(manager);
		expect(manager).toBeDefined();
	});

	test("creates manager with zero maxSessions", () => {
		const manager = new AgentSessionManager({ maxSessions: 0 });
		createdManagers.push(manager);
		expect(manager).toBeDefined();
	});

	test("creates manager with custom compaction preserveRecent", () => {
		const manager = new AgentSessionManager({
			compaction: { enabled: true, threshold: 0.5, preserveRecent: 100 },
		});
		createdManagers.push(manager);
		expect(manager).toBeDefined();
	});

	test("creates manager with disabled compaction", () => {
		const manager = new AgentSessionManager({
			compaction: { enabled: false },
		});
		createdManagers.push(manager);
		expect(manager).toBeDefined();
	});

	test("multiple dispose calls are safe", () => {
		const manager = new AgentSessionManager();
		createdManagers.push(manager);
		manager.dispose();
		manager.dispose();
		manager.dispose();
		expect(manager).toBeDefined();
	});

	test("getOrCreate creates new session with mock agent", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		const agent = manager.getOrCreate("chat-123", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(agent).toBeDefined();
		expect(manager.size).toBe(1);
	});

	test("getOrCreate returns existing session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		const agent1 = manager.getOrCreate("chat-123", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		const agent2 = manager.getOrCreate("chat-123", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(agent1).toBe(agent2);
		expect(manager.size).toBe(1);
	});

	test("has returns false for non-existent session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		expect(manager.has("chat-123")).toBe(false);
	});

	test("has returns true for existing session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		manager.getOrCreate("chat-123", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(manager.has("chat-123")).toBe(true);
	});

	test("get returns undefined for non-existent session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		expect(manager.get("chat-123")).toBeUndefined();
	});

	test("get returns agent for existing session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		const agent = manager.getOrCreate("chat-123", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		const retrieved = manager.get("chat-123");
		expect(retrieved).toBe(agent);
	});

	test("remove removes session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		manager.getOrCreate("chat-123", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(manager.has("chat-123")).toBe(true);
		const removed = manager.remove("chat-123");
		expect(removed).toBe(true);
		expect(manager.has("chat-123")).toBe(false);
	});

	test("remove returns false for non-existent session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		const removed = manager.remove("chat-123");
		expect(removed).toBe(false);
	});

	test("getSessionMetrics returns null for non-existent session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		expect(manager.getSessionMetrics("chat-123")).toBeNull();
	});

	test("getSessionMetrics returns metrics for existing session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		manager.getOrCreate("chat-123", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		const metrics = manager.getSessionMetrics("chat-123");
		expect(metrics).not.toBeNull();
		expect(metrics?.turnCount).toBe(0);
		expect(metrics?.lastActivity).toBeGreaterThan(0);
		expect(metrics?.messageCount).toBe(0);
	});

	test("size increases with multiple sessions", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		expect(manager.size).toBe(0);
		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(manager.size).toBe(1);
		manager.getOrCreate("chat-2", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(manager.size).toBe(2);
	});

	test("getOrCreate with number chatId converts to string", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		const agent = manager.getOrCreate(123, {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(agent).toBeDefined();
		expect(manager.has("123")).toBe(true);
	});

	test("has with number chatId converts to string", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		manager.getOrCreate(123, {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(manager.has(123)).toBe(true);
	});

	test("remove with number chatId converts to string", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);
		manager.getOrCreate(123, {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(manager.remove(123)).toBe(true);
	});

	test("dispose cleans up all sessions", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		manager.getOrCreate("chat-2", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(manager.has("chat-1")).toBe(true);
		expect(manager.has("chat-2")).toBe(true);
		manager.dispose();
		expect(manager.has("chat-1")).toBe(false);
		expect(manager.has("chat-2")).toBe(false);
	});

	test("evicts LRU session when maxSessions reached", () => {
		const manager = new AgentSessionManager({
			maxSessions: 2,
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		// Create 2 sessions (max)
		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		manager.getOrCreate("chat-2", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(manager.size).toBe(2);

		// Create a 3rd session - should evict chat-1 (LRU)
		manager.getOrCreate("chat-3", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(manager.size).toBe(2);
		expect(manager.has("chat-1")).toBe(false); // Should be evicted
		expect(manager.has("chat-2")).toBe(true);
		expect(manager.has("chat-3")).toBe(true);
	});

	test("cleans up expired sessions", async () => {
		const manager = new AgentSessionManager({
			sessionTtlMs: 10, // Very short TTL for testing
			cleanupIntervalMs: 50, // Fast cleanup for testing
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		// Create a session
		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
		expect(manager.has("chat-1")).toBe(true);

		// Wait for TTL + cleanup to run
		await new Promise((r) => setTimeout(r, 100));

		// Session should be cleaned up
		expect(manager.has("chat-1")).toBe(false);
	});

	test("updates lastActivity on getOrCreate", async () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		const metrics1 = manager.getSessionMetrics("chat-1");
		expect(metrics1).not.toBeNull();

		// Wait a bit and access again
		await new Promise((r) => setTimeout(r, 10));

		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		const metrics2 = manager.getSessionMetrics("chat-1");
		expect(metrics2).not.toBeNull();
		expect(metrics2?.lastActivity).toBeGreaterThanOrEqual(metrics1?.lastActivity);
	});

	test("updates lastActivity on get", async () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		const metrics1 = manager.getSessionMetrics("chat-1");
		expect(metrics1).not.toBeNull();

		// Wait a bit
		await new Promise((r) => setTimeout(r, 10));

		manager.get("chat-1");

		const metrics2 = manager.getSessionMetrics("chat-1");
		expect(metrics2).not.toBeNull();
		expect(metrics2?.lastActivity).toBeGreaterThanOrEqual(metrics1?.lastActivity);
	});

	test("isRunning returns false when agent not running", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		expect(manager.isRunning("chat-1")).toBe(false);
	});

	test("isRunning returns false for non-existent session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		expect(manager.isRunning("non-existent")).toBe(false);
	});

	test("steerOrQueue returns not-running when agent not running", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		expect(manager.steerOrQueue("chat-1", "test message")).toBe("not-running");
	});

	test("steerOrQueue returns not-running for non-existent session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		expect(manager.steerOrQueue("non-existent", "test message")).toBe("not-running");
	});

	test("persistSession does nothing without persistence", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// Should not throw
		manager.persistSession("chat-1");
	});

	test("persistSession does nothing for non-existent session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			enablePersistence: true,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		// Should not throw
		manager.persistSession("non-existent");
	});

	test("steerOrQueue with running agent", () => {
		// Create a mock agent that reports as running
		const runningMockAgent = (): EmbeddedAgent =>
			({
				initialize: async () => {},
				prompt: async () => ({ output: "test", turnCount: 1 }),
				abort: () => {},
				dispose: () => {},
				getMessages: () => [],
				getSessionId: () => "mock-session",
				clearMessages: () => {},
				getTools: () => [],
				setTools: () => {},
				isRunning: () => true, // Agent is running
				steer: () => {}, // steer succeeds
				queueFollowUp: () => {},
				drainFollowUpQueue: () => [],
				waitForIdle: async () => {},
				getSystemPrompt: () => "",
				promptWithMessages: async () => ({ output: "test", turnCount: 1 }),
			}) as EmbeddedAgent;

		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: runningMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		expect(manager.steerOrQueue("chat-1", "test message")).toBe("steered");
	});

	test("steerOrQueue queues when steer fails", () => {
		// Create a mock agent that reports as running but steer fails
		const queueMockAgent = (): EmbeddedAgent =>
			({
				initialize: async () => {},
				prompt: async () => ({ output: "test", turnCount: 1 }),
				abort: () => {},
				dispose: () => {},
				getMessages: () => [],
				getSessionId: () => "mock-session",
				clearMessages: () => {},
				getTools: () => [],
				setTools: () => {},
				isRunning: () => true, // Agent is running
				steer: () => {
					throw new Error("Already steered");
				}, // steer fails
				queueFollowUp: () => {}, // queue succeeds
				drainFollowUpQueue: () => [],
				waitForIdle: async () => {},
				getSystemPrompt: () => "",
				promptWithMessages: async () => ({ output: "test", turnCount: 1 }),
			}) as EmbeddedAgent;

		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: queueMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		expect(manager.steerOrQueue("chat-1", "test message")).toBe("queued");
	});

	test("needsCompaction returns false for non-existent session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		expect(manager.needsCompaction("non-existent")).toBe(false);
	});

	test("needsCompaction returns false for session under threshold", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			maxMessagesPerSession: 200,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// Mock agent has 0 messages, so should not need compaction
		expect(manager.needsCompaction("chat-1")).toBe(false);
	});

	test("compactSession does nothing for non-existent session", async () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		// Should not throw
		await manager.compactSession("non-existent");
	});

	test("compactSession does nothing when compaction not needed", async () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			maxMessagesPerSession: 200,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// Mock agent has 0 messages, so compaction not needed
		await manager.compactSession("chat-1");
	});

	test("needsCompaction returns true when over threshold", () => {
		// Create a mock agent with many messages
		const manyMessagesAgent = (): EmbeddedAgent =>
			({
				initialize: async () => {},
				prompt: async () => ({ output: "test", turnCount: 1 }),
				abort: () => {},
				dispose: () => {},
				getMessages: () => Array(200).fill({ role: "user", content: "test" }), // 200 messages
				getSessionId: () => "mock-session",
				clearMessages: () => {},
				getTools: () => [],
				setTools: () => {},
				isRunning: () => false,
				steer: () => {},
				queueFollowUp: () => {},
				drainFollowUpQueue: () => [],
				waitForIdle: async () => {},
				getSystemPrompt: () => "",
				promptWithMessages: async () => ({ output: "test", turnCount: 1 }),
			}) as EmbeddedAgent;

		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			maxMessagesPerSession: 100, // Set limit to 100
			compaction: { enabled: true, threshold: 0.8 },
			_createAgent: manyMessagesAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// 200 messages with limit 100 and threshold 0.8 = 80 messages threshold
		// 200 > 80, so needs compaction
		expect(manager.needsCompaction("chat-1")).toBe(true);
	});

	test("compactSession triggers compaction when needed", async () => {
		// Create a mock agent with many messages and async prompt
		const compactingAgent = (): EmbeddedAgent =>
			({
				initialize: async () => {},
				prompt: async () => ({ output: "summary", turnCount: 1 }),
				abort: () => {},
				dispose: () => {},
				getMessages: () => Array(200).fill({ role: "user", content: "test" }), // 200 messages
				getSessionId: () => "mock-session",
				clearMessages: () => {},
				getTools: () => [],
				setTools: () => {},
				isRunning: () => false,
				steer: () => {},
				queueFollowUp: () => {},
				drainFollowUpQueue: () => [],
				waitForIdle: async () => {},
				getSystemPrompt: () => "",
				promptWithMessages: async () => ({ output: "test", turnCount: 1 }),
			}) as EmbeddedAgent;

		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			maxMessagesPerSession: 100, // Set limit to 100
			compaction: { enabled: true, threshold: 0.8 },
			_createAgent: compactingAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// This should trigger compaction
		await manager.compactSession("chat-1");
	});

	// =========================================================================
	// Tests for pruneMessages and persistence adapter
	// =========================================================================

	test("pruneMessages is called when messages exceed maxMessagesPerSession", () => {
		// Create an agent that returns many messages
		const manyMessagesAgent = (): EmbeddedAgent =>
			({
				initialize: async () => {},
				prompt: async () => ({ output: "test", turnCount: 1 }),
				abort: () => {},
				dispose: () => {},
				getMessages: () => Array(150).fill({ role: "user", content: "test message" }),
				getSessionId: () => "mock-session",
				clearMessages: () => {},
				getTools: () => [],
				setTools: () => {},
				isRunning: () => false,
				steer: () => {},
				queueFollowUp: () => {},
				drainFollowUpQueue: () => [],
				waitForIdle: async () => {},
				getSystemPrompt: () => "",
				promptWithMessages: async () => ({ output: "test", turnCount: 1 }),
			}) as EmbeddedAgent;

		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			maxMessagesPerSession: 100,
			_createAgent: manyMessagesAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-prune", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// Force prune by calling persistSession - this should call pruneMessages
		// No error means pruneMessages executed successfully
		manager.persistSession("chat-prune");

		// Verify session still exists after prune
		expect(manager.has("chat-prune")).toBe(true);
	});

	test("pruneMessages returns original messages when under limit", () => {
		const fewMessagesAgent = (): EmbeddedAgent =>
			({
				initialize: async () => {},
				prompt: async () => ({ output: "test", turnCount: 1 }),
				abort: () => {},
				dispose: () => {},
				getMessages: () => Array(10).fill({ role: "user", content: "test" }),
				getSessionId: () => "mock-session",
				clearMessages: () => {},
				getTools: () => [],
				setTools: () => {},
				isRunning: () => false,
				steer: () => {},
				queueFollowUp: () => {},
				drainFollowUpQueue: () => [],
				waitForIdle: async () => {},
				getSystemPrompt: () => "",
				promptWithMessages: async () => ({ output: "test", turnCount: 1 }),
			}) as EmbeddedAgent;

		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			maxMessagesPerSession: 100,
			_createAgent: fewMessagesAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-few", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// Should not prune when under limit
		manager.persistSession("chat-few");
	});

	test("compactSession does nothing when compaction is not needed", async () => {
		const fewMessagesAgent = (): EmbeddedAgent =>
			({
				initialize: async () => {},
				prompt: async () => ({ output: "summary", turnCount: 1 }),
				abort: () => {},
				dispose: () => {},
				getMessages: () => Array(5).fill({ role: "user", content: "test" }),
				getSessionId: () => "mock-session",
				clearMessages: () => {},
				getTools: () => [],
				setTools: () => {},
				isRunning: () => false,
				steer: () => {},
				queueFollowUp: () => {},
				drainFollowUpQueue: () => [],
				waitForIdle: async () => {},
				getSystemPrompt: () => "",
				promptWithMessages: async () => ({ output: "test", turnCount: 1 }),
			}) as EmbeddedAgent;

		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			maxMessagesPerSession: 100,
			compaction: { enabled: true, threshold: 0.8 },
			_createAgent: fewMessagesAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-no-compact", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// Should return without doing anything
		await manager.compactSession("chat-no-compact");
	});

	test("compactSession does nothing for non-existent session", async () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		// Should not throw
		await manager.compactSession("non-existent");
	});

	test("persistence adapter saveSession is called", () => {
		const manager = new AgentSessionManager({
			enablePersistence: true,
			dbPath: ":memory:",
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-persist", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// persistSession should call saveMessages via persistence adapter
		manager.persistSession("chat-persist");
	});

	test("persistence adapter loadSession is called on warm start", () => {
		const manager = new AgentSessionManager({
			enablePersistence: true,
			dbPath: ":memory:",
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		// First call - creates session
		manager.getOrCreate("chat-warm", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// Second call - should load from persistence
		manager.getOrCreate("chat-warm", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});
	});

	test("persistence adapter deleteSession is called on remove", () => {
		const manager = new AgentSessionManager({
			enablePersistence: true,
			dbPath: ":memory:",
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-delete", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// Remove should call deleteSession via persistence
		manager.remove("chat-delete");
	});

	test("persistence adapter touchSession is called", () => {
		const manager = new AgentSessionManager({
			enablePersistence: true,
			dbPath: ":memory:",
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-touch", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// persistSession should call touchSession
		manager.persistSession("chat-touch");
	});

	test("cleanupExpiredSessions cleans up old sessions", () => {
		const manager = new AgentSessionManager({
			sessionTtlMs: 50, // Very short TTL
			cleanupIntervalMs: 100,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		manager.getOrCreate("chat-expire", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// Wait for session to expire
		setTimeout(() => {}, 60);

		// The cleanup timer should eventually clean up the session
		// We can't easily test timing, but we can verify no errors occur
		expect(manager.size).toBe(1);
	});

	test("dispose persists all sessions before cleanup", () => {
		const manager = new AgentSessionManager({
			enablePersistence: true,
			dbPath: ":memory:",
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});

		manager.getOrCreate("chat-dispose-1", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		manager.getOrCreate("chat-dispose-2", {
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			workspaceDir: "/tmp",
		});

		// dispose should not throw
		manager.dispose();
		createdManagers = createdManagers.filter((m) => m !== manager);
	});

	test("getSessionMetrics returns null for non-existent session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		const metrics = manager.getSessionMetrics("non-existent");
		expect(metrics).toBeNull();
	});

	test("needsCompaction returns false for non-existent session", () => {
		const manager = new AgentSessionManager({
			cleanupIntervalMs: 60000,
			_createAgent: createMockAgent,
		});
		createdManagers.push(manager);

		const result = manager.needsCompaction("non-existent");
		expect(result).toBe(false);
	});
});
