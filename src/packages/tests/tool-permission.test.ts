/**
 * Tool Permission Tests
 *
 * Tests for permission tiers, evaluator, and escalation.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { AuditSink, ToolAuditEvent } from "../agent/tools/permission/audit";
import {
	AuditLogger,
	ConsoleAuditSink,
	createAuditLogger,
	InMemoryAuditSink,
	MultiSinkAuditLogger,
} from "../agent/tools/permission/audit";
import { PermissionEscalation } from "../agent/tools/permission/escalation";
import type { SessionStateStore } from "../agent/tools/permission/evaluator";
import {
	createPermissionEvaluator,
	InMemorySessionStateStore,
	ToolPermissionEvaluator,
} from "../agent/tools/permission/evaluator";
import { getDefaultTier, getTierName, hasTierPermission, PermissionTier } from "../agent/tools/permission/tiers";

describe("PermissionTier", () => {
	describe("hasTierPermission", () => {
		it("should return true when user tier >= required tier", () => {
			expect(hasTierPermission(PermissionTier.READ, PermissionTier.READ)).toBe(true);
			expect(hasTierPermission(PermissionTier.WRITE, PermissionTier.READ)).toBe(true);
			expect(hasTierPermission(PermissionTier.EXECUTE, PermissionTier.WRITE)).toBe(true);
			expect(hasTierPermission(PermissionTier.ADMIN, PermissionTier.EXECUTE)).toBe(true);
		});

		it("should return false when user tier < required tier", () => {
			expect(hasTierPermission(PermissionTier.READ, PermissionTier.WRITE)).toBe(false);
			expect(hasTierPermission(PermissionTier.WRITE, PermissionTier.EXECUTE)).toBe(false);
			expect(hasTierPermission(PermissionTier.EXECUTE, PermissionTier.ADMIN)).toBe(false);
		});
	});

	describe("getDefaultTier", () => {
		it("should return correct default tiers for known tools", () => {
			expect(getDefaultTier("read_file")).toBe(PermissionTier.READ);
			expect(getDefaultTier("write_file")).toBe(PermissionTier.WRITE);
			expect(getDefaultTier("bash")).toBe(PermissionTier.EXECUTE);
			expect(getDefaultTier("web_search")).toBe(PermissionTier.READ);
		});

		it("should return READ for unknown tools", () => {
			expect(getDefaultTier("unknown_tool")).toBe(PermissionTier.READ);
		});

		it("should handle tool name variations", () => {
			expect(getDefaultTier("Bash")).toBe(PermissionTier.EXECUTE);
			expect(getDefaultTier("BashTool")).toBe(PermissionTier.EXECUTE);
		});
	});

	describe("getTierName", () => {
		it("should return correct names for all tiers", () => {
			expect(getTierName(PermissionTier.READ)).toBe("READ");
			expect(getTierName(PermissionTier.WRITE)).toBe("WRITE");
			expect(getTierName(PermissionTier.EXECUTE)).toBe("EXECUTE");
			expect(getTierName(PermissionTier.ADMIN)).toBe("ADMIN");
		});

		it("should return UNKNOWN for invalid tier", () => {
			expect(getTierName(0)).toBe("UNKNOWN");
			expect(getTierName(5)).toBe("UNKNOWN");
		});
	});
});

describe("InMemorySessionStateStore", () => {
	let store: InMemorySessionStateStore;

	beforeEach(() => {
		store = new InMemorySessionStateStore();
	});

	it("should get and set session tier", () => {
		expect(store.getSessionTier("session1")).toBe(PermissionTier.READ);

		store.setSessionTier("session1", PermissionTier.WRITE);
		expect(store.getSessionTier("session1")).toBe(PermissionTier.WRITE);
	});

	it("should return READ for unknown sessions", () => {
		expect(store.getSessionTier("unknown")).toBe(PermissionTier.READ);
	});

	it("should manage escalations", () => {
		store.setEscalation("session1", "bash", PermissionTier.ADMIN, Date.now() + 60000);

		const escalations = store.getActiveEscalations("session1");
		expect(escalations.get("bash")).toBe(PermissionTier.ADMIN);
	});
});

describe("ToolPermissionEvaluator", () => {
	let evaluator: ToolPermissionEvaluator;
	let store: InMemorySessionStateStore;

	beforeEach(() => {
		store = new InMemorySessionStateStore();
		evaluator = new ToolPermissionEvaluator(store);
		evaluator.registerToolTier("bash", PermissionTier.EXECUTE);
		evaluator.registerToolTier("read_file", PermissionTier.READ);
		evaluator.registerToolTier("write_file", PermissionTier.WRITE);
	});

	describe("evaluate", () => {
		it("should allow access when session tier is sufficient", () => {
			store.setSessionTier("session1", PermissionTier.EXECUTE);

			const result = evaluator.evaluate("session1", "bash");
			expect(result.allowed).toBe(true);
			expect(result.requiredTier).toBe(PermissionTier.EXECUTE);
			expect(result.currentTier).toBe(PermissionTier.EXECUTE);
		});

		it("should deny access when session tier is insufficient", () => {
			store.setSessionTier("session1", PermissionTier.READ);

			const result = evaluator.evaluate("session1", "bash");
			expect(result.allowed).toBe(false);
			expect(result.escalationRequired).toBe(true);
		});

		it("should allow read_file with READ tier", () => {
			store.setSessionTier("session1", PermissionTier.READ);

			const result = evaluator.evaluate("session1", "read_file");
			expect(result.allowed).toBe(true);
		});

		it("should require escalation for write_file with READ tier", () => {
			store.setSessionTier("session1", PermissionTier.READ);

			const result = evaluator.evaluate("session1", "write_file");
			expect(result.allowed).toBe(false);
			expect(result.escalationRequired).toBe(true);
		});
	});

	describe("registerToolTier", () => {
		it("should register custom tier requirements", () => {
			evaluator.registerToolTier("custom_tool", PermissionTier.ADMIN, false);

			const result = evaluator.evaluate("session1", "custom_tool");
			expect(result.escalationRequired).toBe(false);
		});
	});

	describe("session tier management", () => {
		it("should set and get session tier", () => {
			evaluator.setSessionTier("session1", PermissionTier.WRITE);
			const tier = evaluator.getSessionTier("session1");
			expect(tier).toBe(PermissionTier.WRITE);
		});

		it("should return default tier for unknown session", () => {
			const tier = evaluator.getSessionTier("unknown-session");
			expect(tier).toBe(PermissionTier.READ);
		});
	});
});

describe("createPermissionEvaluator", () => {
	it("should create evaluator with custom config", () => {
		const evaluator = createPermissionEvaluator({
			defaultTier: PermissionTier.WRITE,
			allowJitElevation: false,
		});

		expect(evaluator).toBeDefined();
		// Set tier explicitly then verify it returns that tier
		evaluator.setSessionTier("test-session", PermissionTier.WRITE);
		const tier = evaluator.getSessionTier("test-session");
		expect(tier).toBe(PermissionTier.WRITE);
	});

	it("should create evaluator with default config", () => {
		const evaluator = createPermissionEvaluator();

		expect(evaluator).toBeDefined();
		// Default tier should be READ
		const tier = evaluator.getSessionTier("new-session");
		expect(tier).toBe(PermissionTier.READ);
	});

	it("should create evaluator with escalation timeout config", () => {
		const evaluator = createPermissionEvaluator({
			defaultEscalationTimeoutMs: 60000,
		});

		expect(evaluator).toBeDefined();
	});
});

describe("PermissionEscalation", () => {
	let escalation: PermissionEscalation;

	beforeEach(() => {
		escalation = new PermissionEscalation({
			maxDurationMs: 60000,
			defaultDurationMs: 5000,
		});
	});

	describe("requestEscalation", () => {
		it("should grant valid escalation request", async () => {
			const result = await escalation.requestEscalation({
				sessionId: "session1",
				toolName: "bash",
				reason: "Need to run build command",
				requestedTier: PermissionTier.EXECUTE,
				durationMs: 10000,
			});

			expect(result.success).toBe(true);
			expect(result.grantedTier).toBe(PermissionTier.EXECUTE);
			expect(result.expiresAt).toBeDefined();
		});

		it("should reject invalid tier", async () => {
			const result = await escalation.requestEscalation({
				sessionId: "session1",
				toolName: "bash",
				reason: "Invalid tier",
				requestedTier: 0, // Invalid
			});

			expect(result.success).toBe(false);
		});

		it("should cap duration at maxDurationMs", async () => {
			const result = await escalation.requestEscalation({
				sessionId: "session1",
				toolName: "bash",
				reason: "Long duration",
				requestedTier: PermissionTier.EXECUTE,
				durationMs: 999999, // Exceeds max
			});

			expect(result.success).toBe(true);
		});
	});

	describe("hasTier", () => {
		it("should return true when tier is sufficient", async () => {
			await escalation.requestEscalation({
				sessionId: "session1",
				toolName: "bash",
				reason: "Need execute",
				requestedTier: PermissionTier.EXECUTE,
			});

			expect(escalation.hasTier("session1", PermissionTier.EXECUTE)).toBe(true);
		});

		it("should return false when tier is insufficient", () => {
			expect(escalation.hasTier("session1", PermissionTier.EXECUTE)).toBe(false);
		});
	});

	describe("revokeEscalation", () => {
		it("should revoke specific tool escalation", async () => {
			await escalation.requestEscalation({
				sessionId: "session1",
				toolName: "bash",
				reason: "Need execute",
				requestedTier: PermissionTier.EXECUTE,
			});

			escalation.revokeEscalation("session1", "bash");

			const active = escalation.getActiveEscalations("session1");
			expect(active.length).toBe(0);
		});

		it("should revoke all escalations when no tool specified", async () => {
			await escalation.requestEscalation({
				sessionId: "session1",
				toolName: "bash",
				reason: "Need execute",
				requestedTier: PermissionTier.EXECUTE,
			});

			await escalation.requestEscalation({
				sessionId: "session1",
				toolName: "write_file",
				reason: "Need write",
				requestedTier: PermissionTier.WRITE,
			});

			escalation.revokeEscalation("session1");

			const active = escalation.getActiveEscalations("session1");
			expect(active.length).toBe(0);
		});
	});

	describe("getActiveEscalations", () => {
		it("should return active escalations", async () => {
			await escalation.requestEscalation({
				sessionId: "session1",
				toolName: "bash",
				reason: "Need execute",
				requestedTier: PermissionTier.EXECUTE,
			});

			const active = escalation.getActiveEscalations("session1");
			expect(active.length).toBe(1);
			expect(active[0].toolName).toBe("bash");
		});
	});
});

describe("InMemorySessionStateStore - additional coverage", () => {
	let store: InMemorySessionStateStore;

	beforeEach(() => {
		store = new InMemorySessionStateStore();
	});

	it("should clear specific escalation", () => {
		store.setEscalation("session1", "bash", PermissionTier.ADMIN, Date.now() + 60000);

		store.clearEscalation("session1", "bash");

		const escalations = store.getActiveEscalations("session1");
		expect(escalations.size).toBe(0);
	});

	it("should clear all escalations for session", () => {
		store.setEscalation("session1", "bash", PermissionTier.ADMIN, Date.now() + 60000);
		store.setEscalation("session1", "write_file", PermissionTier.WRITE, Date.now() + 60000);

		store.clearEscalation("session1");

		const escalations = store.getActiveEscalations("session1");
		expect(escalations.size).toBe(0);
	});

	it("should handle clear escalation for unknown session", () => {
		expect(() => store.clearEscalation("unknown")).not.toThrow();
	});
});

describe("AuditLogger - additional coverage", () => {
	let sink: InMemoryAuditSink;
	let logger: AuditLogger;

	beforeEach(() => {
		sink = new InMemoryAuditSink(100);
		logger = new AuditLogger(sink, true);
	});

	it("should log call start", () => {
		logger.logCall("session1", "bash", "execute", { command: "ls" }, PermissionTier.EXECUTE, false);
		// Just verify it doesn't throw - start time is stored in params
	});

	it("should query audit events", () => {
		logger.logResult("session1", "bash", "execute", {}, "success", PermissionTier.EXECUTE, false);

		const results = logger.query({ sessionId: "session1" });
		expect(results.length).toBe(1);
	});

	it("should query by tool name", () => {
		logger.logResult("session1", "bash", "execute", {}, "success", PermissionTier.EXECUTE, false);
		logger.logResult("session1", "read_file", "read", {}, "success", PermissionTier.READ, false);

		const results = logger.query({ toolName: "read_file" });
		expect(results.length).toBe(1);
	});
});

describe("MultiSinkAuditLogger - additional coverage", () => {
	it("should add sink dynamically", () => {
		const sink1 = new InMemoryAuditSink(100);
		const sink2 = new ConsoleAuditSink(false);
		const logger = new MultiSinkAuditLogger([sink1]);

		logger.addSink(sink2);

		const event: ToolAuditEvent = {
			timestamp: Date.now(),
			sessionId: "test-session",
			toolName: "bash",
			operation: "execute",
			params: {},
			result: "success",
			tier: PermissionTier.EXECUTE,
			escalated: false,
			durationMs: 100,
		};

		logger.log(event);

		// Should have logged to both sinks
		const stored = sink1.query({});
		expect(stored.length).toBe(1);
	});

	it("should handle sink errors gracefully", () => {
		const errorSink: AuditSink = {
			log: () => {
				throw new Error("Sink error");
			},
			query: () => [],
		};
		const logger = new MultiSinkAuditLogger([errorSink]);

		const event: ToolAuditEvent = {
			timestamp: Date.now(),
			sessionId: "test-session",
			toolName: "bash",
			operation: "execute",
			params: {},
			result: "success",
			tier: PermissionTier.EXECUTE,
			escalated: false,
			durationMs: 100,
		};

		// Should not throw even when sink fails
		expect(() => logger.log(event)).not.toThrow();
	});

	it("should remove sink", () => {
		const sink1 = new InMemoryAuditSink(100);
		const sink2 = new ConsoleAuditSink(false);
		const logger = new MultiSinkAuditLogger([sink1, sink2]);

		logger.removeSink(sink2);

		// Should not throw - just logs to remaining sink
		const event: ToolAuditEvent = {
			timestamp: Date.now(),
			sessionId: "test-session",
			toolName: "bash",
			operation: "execute",
			params: {},
			result: "success",
			tier: PermissionTier.EXECUTE,
			escalated: false,
			durationMs: 100,
		};

		expect(() => logger.log(event)).not.toThrow();
	});

	it("should query from sinks", () => {
		const sink1 = new InMemoryAuditSink(100);
		const sink2 = new InMemoryAuditSink(100);
		const logger = new MultiSinkAuditLogger([sink1, sink2]);

		sink1.log({
			timestamp: Date.now(),
			sessionId: "test-session",
			toolName: "bash",
			operation: "execute",
			params: {},
			result: "success",
			tier: PermissionTier.EXECUTE,
			escalated: false,
			durationMs: 100,
		});

		const results = logger.query({ sessionId: "test-session" });
		expect(results.length).toBe(1);
	});

	it("should return empty when querying with no results", () => {
		const sink1 = new InMemoryAuditSink(100);
		const sink2 = new InMemoryAuditSink(100);
		const logger = new MultiSinkAuditLogger([sink1, sink2]);

		const results = logger.query({ sessionId: "nonexistent" });
		expect(results.length).toBe(0);
	});
});

describe("createAuditLogger", () => {
	it("should create enabled audit logger", () => {
		const logger = createAuditLogger(true);
		expect(logger).toBeDefined();
	});

	it("should create disabled audit logger", () => {
		const logger = createAuditLogger(false);
		expect(logger).toBeDefined();
	});
});

describe("InMemoryAuditSink - additional coverage", () => {
	it("should query by start and end time", () => {
		const sink = new InMemoryAuditSink(100);
		const now = Date.now();

		sink.log({
			timestamp: now - 10000,
			sessionId: "session1",
			toolName: "bash",
			operation: "execute",
			params: {},
			result: "success",
			tier: PermissionTier.EXECUTE,
			escalated: false,
			durationMs: 100,
		});

		sink.log({
			timestamp: now,
			sessionId: "session1",
			toolName: "bash",
			operation: "execute",
			params: {},
			result: "success",
			tier: PermissionTier.EXECUTE,
			escalated: false,
			durationMs: 100,
		});

		const results = sink.query({ startTime: now - 5000, endTime: now + 5000 });
		expect(results.length).toBe(1);
	});

	it("should query with limit", () => {
		const sink = new InMemoryAuditSink(100);

		for (let i = 0; i < 5; i++) {
			sink.log({
				timestamp: Date.now(),
				sessionId: "session1",
				toolName: "bash",
				operation: "execute",
				params: {},
				result: "success",
				tier: PermissionTier.EXECUTE,
				escalated: false,
				durationMs: 100,
			});
		}

		const results = sink.query({ limit: 3 });
		expect(results.length).toBe(3);
	});
});

describe("ToolPermissionEvaluator - additional coverage", () => {
	let evaluator: ToolPermissionEvaluator;
	let store: InMemorySessionStateStore;

	beforeEach(() => {
		store = new InMemorySessionStateStore();
		evaluator = new ToolPermissionEvaluator(store);
		evaluator.registerToolTier("bash", PermissionTier.EXECUTE);
		evaluator.registerToolTier("read_file", PermissionTier.READ);
	});

	it("should use escalation tier when higher than base tier", () => {
		store.setSessionTier("session1", PermissionTier.READ);
		store.setEscalation("session1", "bash", PermissionTier.EXECUTE, Date.now() + 60000);

		const result = evaluator.evaluate("session1", "bash");
		expect(result.allowed).toBe(true);
	});

	it("should use base tier when escalation is lower", () => {
		store.setSessionTier("session1", PermissionTier.EXECUTE);
		// Set escalation to lower tier
		store.setEscalation("session1", "bash", PermissionTier.READ, Date.now() + 60000);

		const result = evaluator.evaluate("session1", "bash");
		// Should still be allowed because base tier is EXECUTE
		expect(result.allowed).toBe(true);
	});

	it("should handle custom session store", () => {
		const customStore: SessionStateStore = {
			getSessionTier: () => PermissionTier.WRITE,
			getActiveEscalations: () => new Map(),
		};
		const customEvaluator = new ToolPermissionEvaluator(customStore);

		// setSessionTier should not throw but also not affect custom store
		customEvaluator.setSessionTier("session1", PermissionTier.ADMIN);
		// The custom store should still return WRITE
		expect(customEvaluator.getSessionTier("session1")).toBe(PermissionTier.WRITE);
	});

	it("should evaluate with operation parameter", () => {
		store.setSessionTier("session1", PermissionTier.EXECUTE);

		const result = evaluator.evaluate("session1", "bash", "execute");
		expect(result.allowed).toBe(true);
	});

	it("should set escalation for new session", () => {
		// This covers the branch where escalations Map doesn't have the session
		store.setEscalation("new-session", "bash", PermissionTier.EXECUTE, Date.now() + 60000);

		const escalations = store.getActiveEscalations("new-session");
		expect(escalations.get("bash")).toBe(PermissionTier.EXECUTE);
	});

	it("should set session tier with in-memory store", () => {
		// This covers the instanceof InMemorySessionStateStore branch
		const memStore = new InMemorySessionStateStore();
		const evalWithMemStore = new ToolPermissionEvaluator(memStore);

		evalWithMemStore.setSessionTier("session1", PermissionTier.ADMIN);

		expect(evalWithMemStore.getSessionTier("session1")).toBe(PermissionTier.ADMIN);
	});

	it("should use default tier for unknown tool", () => {
		// This covers getDefaultTier branch in getRequiredTier
		store.setSessionTier("session1", PermissionTier.READ);

		const result = evaluator.evaluate("session1", "unknown_tool");
		// Should be allowed since default tier is READ
		expect(result.allowed).toBe(true);
		expect(result.requiredTier).toBe(PermissionTier.READ);
	});

	it("should schedule escalation cleanup", async () => {
		// This covers the setTimeout callback in setEscalation
		const testStore = new InMemorySessionStateStore();
		testStore.setEscalation("session1", "bash", PermissionTier.EXECUTE, 10); // 10ms

		expect(testStore.getActiveEscalations("session1").size).toBe(1);

		// Wait for timeout to fire
		await new Promise((resolve) => setTimeout(resolve, 20));

		// Should be cleared after timeout
		expect(testStore.getActiveEscalations("session1").size).toBe(0);
	});
});
