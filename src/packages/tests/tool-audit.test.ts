/**
 * Tool Audit Tests
 *
 * Tests for audit logging, tracer, metrics, and rate limiter.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	AuditLogger,
	ConsoleAuditSink,
	InMemoryAuditSink,
	MultiSinkAuditLogger,
} from "../agent/tools/permission/audit";
import { PermissionTier } from "../agent/tools/permission/tiers";
import { MetricsCollector, type ToolMetrics } from "../agent/tools/visibility/metrics";
import { RateLimiter } from "../agent/tools/visibility/rate-limiter";
import { ToolTracer } from "../agent/tools/visibility/tracer";

describe("InMemoryAuditSink", () => {
	let sink: InMemoryAuditSink;

	beforeEach(() => {
		sink = new InMemoryAuditSink(100);
	});

	it("should log events", () => {
		sink.log({
			timestamp: Date.now(),
			sessionId: "session1",
			toolName: "bash",
			operation: "execute",
			params: { command: "ls" },
			result: "success",
			tier: PermissionTier.EXECUTE,
			escalated: false,
			durationMs: 100,
		});

		expect(sink.count).toBe(1);
	});

	it("should query events by session", () => {
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

		sink.log({
			timestamp: Date.now(),
			sessionId: "session2",
			toolName: "read_file",
			operation: "read",
			params: {},
			result: "success",
			tier: PermissionTier.READ,
			escalated: false,
			durationMs: 50,
		});

		const results = sink.query({ sessionId: "session1" });
		expect(results.length).toBe(1);
	});

	it("should query events by tool name", () => {
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

		const results = sink.query({ toolName: "bash" });
		expect(results.length).toBe(1);
	});

	it("should query events by result type", () => {
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

		sink.log({
			timestamp: Date.now(),
			sessionId: "session2",
			toolName: "bash",
			operation: "execute",
			params: {},
			result: "denied",
			tier: PermissionTier.READ,
			escalated: false,
			durationMs: 0,
		});

		const results = sink.query({ result: "denied" });
		expect(results.length).toBe(1);
	});

	it("should respect limit", () => {
		for (let i = 0; i < 10; i++) {
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

		const results = sink.query({ limit: 5 });
		expect(results.length).toBe(5);
	});

	it("should clear events", () => {
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

		sink.clear();
		expect(sink.count).toBe(0);
	});
});

describe("AuditLogger", () => {
	let sink: InMemoryAuditSink;
	let logger: AuditLogger;

	beforeEach(() => {
		sink = new InMemoryAuditSink();
		logger = new AuditLogger(sink, true);
	});

	it("should log tool call results", () => {
		logger.logResult("session1", "bash", "execute", { command: "ls" }, "success", PermissionTier.EXECUTE, false);

		const events = sink.query({});
		expect(events.length).toBe(1);
		expect(events[0].result).toBe("success");
	});

	it("should sanitize sensitive params", () => {
		logger.logResult(
			"session1",
			"bash",
			"execute",
			{ command: "ls", password: "secret123" },
			"success",
			PermissionTier.EXECUTE,
			false,
		);

		const events = sink.query({});
		expect(events[0].params.password).toBe("[REDACTED]");
		expect(events[0].params.command).toBe("ls");
	});

	it("should not log when disabled", () => {
		const disabledLogger = new AuditLogger(sink, false);

		disabledLogger.logResult("session1", "bash", "execute", {}, "success", PermissionTier.EXECUTE, false);

		expect(sink.count).toBe(0);
	});

	it("should record error messages", () => {
		logger.logResult("session1", "bash", "execute", {}, "failure", PermissionTier.EXECUTE, false, "Command failed");

		const events = sink.query({});
		expect(events[0].error).toBe("Command failed");
	});
});

describe("ToolTracer", () => {
	let tracer: ToolTracer;

	beforeEach(() => {
		tracer = new ToolTracer();
	});

	describe("startTrace", () => {
		it("should start a new trace", () => {
			const traceId = tracer.startTrace("session1", "bash", { operation: "execute" });

			expect(traceId).toBeDefined();

			const trace = tracer.getTrace(traceId);
			expect(trace).toBeDefined();
			expect(trace?.sessionId).toBe("session1");
			expect(trace?.toolName).toBe("bash");
			expect(trace?.status).toBe("started");
		});

		it("should track parent-child relationships", () => {
			const parentId = tracer.startTrace("session1", "parent_tool");
			const childId = tracer.startTrace("session1", "child_tool", { parentTraceId: parentId });

			const parent = tracer.getTrace(parentId);
			const child = tracer.getTrace(childId);

			expect(parent?.childTraceIds).toContain(childId);
			expect(child?.parentTraceId).toBe(parentId);
		});
	});

	describe("endTrace", () => {
		it("should complete a trace with status", () => {
			const traceId = tracer.startTrace("session1", "bash");

			tracer.endTrace(traceId, { status: "completed" });

			const trace = tracer.getTrace(traceId);
			expect(trace?.status).toBe("completed");
			expect(trace?.durationMs).toBeDefined();
		});

		it("should record error messages", () => {
			const traceId = tracer.startTrace("session1", "bash");

			tracer.endTrace(traceId, { status: "failed", error: "Command failed" });

			const trace = tracer.getTrace(traceId);
			expect(trace?.error).toBe("Command failed");
		});
	});

	describe("query", () => {
		it("should query by session", () => {
			tracer.startTrace("session1", "bash");
			tracer.startTrace("session2", "read_file");

			const traces = tracer.query({ sessionId: "session1" });
			expect(traces.length).toBe(1);
		});

		it("should query by tool name", () => {
			tracer.startTrace("session1", "bash");
			tracer.startTrace("session1", "read_file");

			const traces = tracer.query({ toolName: "bash" });
			expect(traces.length).toBe(1);
		});
	});

	describe("getTracesBySession", () => {
		it("should return all traces for a session", () => {
			tracer.startTrace("session1", "bash");
			tracer.startTrace("session1", "read_file");
			tracer.startTrace("session2", "bash");

			const traces = tracer.getTracesBySession("session1");
			expect(traces.length).toBe(2);
		});
	});

	describe("cleanup", () => {
		it("should clean up old traces", async () => {
			const traceId = tracer.startTrace("session1", "bash");
			tracer.endTrace(traceId, { status: "completed" });

			// Add small delay to ensure trace is old enough
			await new Promise((resolve) => setTimeout(resolve, 5));
			const cleaned = tracer.cleanup(0);
			expect(cleaned).toBe(1);
		});
	});
});

describe("MetricsCollector", () => {
	let metrics: MetricsCollector;

	beforeEach(() => {
		metrics = new MetricsCollector();
	});

	it("should record successful calls", () => {
		metrics.recordCall("bash", "success", 100);
		metrics.recordCall("bash", "success", 200);

		const toolMetrics: ToolMetrics | undefined = metrics.getMetrics("bash");
		expect(toolMetrics?.calls).toBe(2);
		expect(toolMetrics.successes).toBe(2);
		expect(toolMetrics.failures).toBe(0);
	});

	it("should record failed calls", () => {
		metrics.recordCall("bash", "failure", 50);

		const toolMetrics: ToolMetrics | undefined = metrics.getMetrics("bash");
		expect(toolMetrics?.calls).toBe(1);
		expect(toolMetrics?.failures).toBe(1);
	});

	it("should track duration statistics", () => {
		metrics.recordCall("bash", "success", 100);
		metrics.recordCall("bash", "success", 200);
		metrics.recordCall("bash", "success", 300);

		const toolMetrics: ToolMetrics | undefined = metrics.getMetrics("bash");
		expect(toolMetrics?.totalDurationMs).toBe(600);
		expect(toolMetrics?.avgDurationMs).toBe(200);
		expect(toolMetrics?.minDurationMs).toBe(100);
		expect(toolMetrics?.maxDurationMs).toBe(300);
	});

	it("should get summary", () => {
		metrics.recordCall("bash", "success", 100);
		metrics.recordCall("read_file", "success", 50);

		const summary = metrics.getSummary();
		expect(summary.totalCalls).toBe(2);
		expect(summary.totalSuccesses).toBe(2);
		expect(Object.keys(summary.byTool).length).toBe(2);
	});

	it("should get top tools", () => {
		metrics.recordCall("bash", "success", 100);
		metrics.recordCall("read_file", "success", 50);
		metrics.recordCall("read_file", "success", 50);

		const top = metrics.getTopTools(1);
		expect(top[0].toolName).toBe("read_file");
	});

	it("should reset metrics", () => {
		metrics.recordCall("bash", "success", 100);
		metrics.reset();

		const toolMetrics: ToolMetrics | undefined = metrics.getMetrics("bash");
		expect(toolMetrics?.calls).toBe(0);
	});
});

describe("ConsoleAuditSink", () => {
	let sink: ConsoleAuditSink;

	beforeEach(() => {
		sink = new ConsoleAuditSink(true);
	});

	it("should log denied events as warn", () => {
		const event: ToolAuditEvent = {
			timestamp: Date.now(),
			sessionId: "test-session",
			toolName: "bash",
			operation: "execute",
			params: { command: "ls" },
			result: "denied",
			tier: PermissionTier.EXECUTE,
			escalated: false,
			durationMs: 100,
		};

		expect(() => sink.log(event)).not.toThrow();
	});

	it("should log success events as info", () => {
		const event: ToolAuditEvent = {
			timestamp: Date.now(),
			sessionId: "test-session",
			toolName: "read_file",
			operation: "read",
			params: { path: "/test.txt" },
			result: "success",
			tier: PermissionTier.READ,
			escalated: false,
			durationMs: 50,
		};

		expect(() => sink.log(event)).not.toThrow();
	});

	it("should log failure events", () => {
		const event: ToolAuditEvent = {
			timestamp: Date.now(),
			sessionId: "test-session",
			toolName: "write_file",
			operation: "write",
			params: { path: "/test.txt" },
			result: "failure",
			tier: PermissionTier.WRITE,
			escalated: true,
			durationMs: 200,
			error: "Permission denied",
		};

		expect(() => sink.log(event)).not.toThrow();
	});

	it("query should return empty array", () => {
		const results = sink.query({});
		expect(results).toEqual([]);
	});
});

describe("MultiSinkAuditLogger", () => {
	let logger: MultiSinkAuditLogger;
	let sink1: InMemoryAuditSink;
	let sink2: ConsoleAuditSink;

	beforeEach(() => {
		sink1 = new InMemoryAuditSink(100);
		sink2 = new ConsoleAuditSink(false);
		logger = new MultiSinkAuditLogger([sink1, sink2]);
	});

	it("should log to all sinks", () => {
		const event: ToolAuditEvent = {
			timestamp: Date.now(),
			sessionId: "test-session",
			toolName: "bash",
			operation: "execute",
			params: { command: "ls" },
			result: "success",
			tier: PermissionTier.EXECUTE,
			escalated: false,
			durationMs: 100,
		};

		logger.log(event);

		const stored = sink1.query({});
		expect(stored.length).toBe(1);
	});

	it("should query from primary sink", () => {
		const event: ToolAuditEvent = {
			timestamp: Date.now(),
			sessionId: "test-session",
			toolName: "bash",
			operation: "execute",
			params: { command: "ls" },
			result: "success",
			tier: PermissionTier.EXECUTE,
			escalated: false,
			durationMs: 100,
		};

		logger.log(event);

		const results = logger.query({ sessionId: "test-session" });
		expect(results.length).toBe(1);
	});
});

describe("RateLimiter", () => {
	let limiter: RateLimiter;

	beforeEach(() => {
		limiter = new RateLimiter(60000, 10);
	});

	it("should allow calls within limit", () => {
		limiter.setLimit({ toolName: "bash", maxCalls: 10, windowMs: 60000 });
		const result = limiter.recordCall("bash");
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(9);
	});

	it("should track remaining calls", () => {
		limiter.setLimit({ toolName: "bash", maxCalls: 5, windowMs: 60000 });

		expect(limiter.recordCall("bash").remaining).toBe(4);
		expect(limiter.recordCall("bash").remaining).toBe(3);
		expect(limiter.recordCall("bash").remaining).toBe(2);
		expect(limiter.recordCall("bash").remaining).toBe(1);
		expect(limiter.recordCall("bash").remaining).toBe(0);
	});

	it("should deny calls over limit", () => {
		limiter.setLimit({ toolName: "bash", maxCalls: 2, windowMs: 60000 });

		limiter.recordCall("bash");
		limiter.recordCall("bash");

		const result = limiter.recordCall("bash");
		expect(result.allowed).toBe(false);
		expect(result.remaining).toBe(0);
	});

	it("should allow burst when configured", () => {
		limiter.setLimit({ toolName: "bash", maxCalls: 2, windowMs: 60000, burst: 3 });

		// Normal limit: 2, with burst: 5
		expect(limiter.recordCall("bash").allowed).toBe(true);
		expect(limiter.recordCall("bash").allowed).toBe(true);
		expect(limiter.recordCall("bash").allowed).toBe(true);
		expect(limiter.recordCall("bash").allowed).toBe(true);
		expect(limiter.recordCall("bash").allowed).toBe(true);
		expect(limiter.recordCall("bash").allowed).toBe(false);
	});

	it("should allow unlimited when no limit set", () => {
		// bash has no limit configured
		const result = limiter.checkLimit("unknown_tool");
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(Infinity);
	});

	it("should reset window after expiry", async () => {
		limiter.setLimit({ toolName: "fast", maxCalls: 2, windowMs: 50 });

		limiter.recordCall("fast");
		limiter.recordCall("fast");

		expect(limiter.recordCall("fast").allowed).toBe(false);

		// Wait for window to expire
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(limiter.recordCall("fast").allowed).toBe(true);
	});

	it("should get current usage", () => {
		limiter.setLimit({ toolName: "bash", maxCalls: 10, windowMs: 60000 });

		limiter.recordCall("bash");
		limiter.recordCall("bash");

		const usage = limiter.getCurrentUsage();
		expect(usage.bash.count).toBe(2);
		expect(usage.bash.limit).toBe(10);
	});

	it("should set multiple limits at once", () => {
		limiter.setLimits([
			{ toolName: "bash", maxCalls: 5, windowMs: 60000 },
			{ toolName: "read_file", maxCalls: 10, windowMs: 60000 },
		]);

		expect(limiter.recordCall("bash").remaining).toBe(4);
		expect(limiter.recordCall("read_file").remaining).toBe(9);
	});

	it("should get rate limit for a tool", () => {
		limiter.setLimit({ toolName: "bash", maxCalls: 5, windowMs: 60000 });

		const limit = limiter.getLimit("bash");
		expect(limit?.maxCalls).toBe(5);
		expect(limit?.windowMs).toBe(60000);
	});

	it("should return undefined for unknown tool limit", () => {
		const limit = limiter.getLimit("unknown_tool");
		expect(limit).toBeUndefined();
	});

	it("should remove rate limit for a tool", () => {
		limiter.setLimit({ toolName: "bash", maxCalls: 5, windowMs: 60000 });
		limiter.recordCall("bash");

		limiter.removeLimit("bash");

		// Should now allow unlimited calls
		const result = limiter.checkLimit("bash");
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(Infinity);
	});

	it("should get remaining calls", () => {
		limiter.setLimit({ toolName: "bash", maxCalls: 5, windowMs: 60000 });
		limiter.recordCall("bash");
		limiter.recordCall("bash");

		expect(limiter.getRemaining("bash")).toBe(3);
	});

	it("should get reset time", () => {
		limiter.setLimit({ toolName: "bash", maxCalls: 5, windowMs: 60000 });
		limiter.recordCall("bash");

		const resetTime = limiter.getResetTime("bash");
		expect(resetTime).toBeGreaterThan(0);
	});

	it("should return 0 for unknown tool reset time", () => {
		const resetTime = limiter.getResetTime("unknown_tool");
		expect(resetTime).toBe(0);
	});

	it("should clear all windows", () => {
		limiter.setLimit({ toolName: "bash", maxCalls: 5, windowMs: 60000 });
		limiter.recordCall("bash");

		limiter.clearWindows();

		// Window should be recreated with fresh count
		expect(limiter.getRemaining("bash")).toBe(5);
	});
});

describe("ToolTracer - additional coverage", () => {
	let tracer: ToolTracer;

	beforeEach(() => {
		tracer = new ToolTracer();
	});

	it("should get active traces", () => {
		tracer.startTrace("session1", "bash");
		tracer.startTrace("session1", "read_file");

		const active = tracer.getActiveTraces("session1");
		expect(active.length).toBe(2);
	});

	it("should return empty array for active traces when none exist", () => {
		const active = tracer.getActiveTraces("nonexistent");
		expect(active.length).toBe(0);
	});

	it("should get trace count", () => {
		tracer.startTrace("session1", "bash");
		expect(tracer.count).toBe(1);
	});

	it("should cleanup with traces cleaned", async () => {
		const traceId = tracer.startTrace("session1", "bash");
		tracer.endTrace(traceId, { status: "completed" });

		// Wait a bit then cleanup with 0 maxAgeMs
		await new Promise((resolve) => setTimeout(resolve, 5));
		const cleaned = tracer.cleanup(0);
		expect(cleaned).toBe(1);
	});

	it("should cleanup and remove session index", async () => {
		const traceId = tracer.startTrace("session1", "bash");
		tracer.endTrace(traceId, { status: "completed" });

		await new Promise((resolve) => setTimeout(resolve, 5));
		tracer.cleanup(0);

		// Session should be removed from index
		const traces = tracer.getTracesBySession("session1");
		expect(traces.length).toBe(0);
	});

	it("should not cleanup active traces", () => {
		tracer.startTrace("session1", "bash");
		// Not ending the trace - it's still active

		const cleaned = tracer.cleanup(0);
		expect(cleaned).toBe(0);
		expect(tracer.count).toBe(1);
	});

	it("should end trace with error", () => {
		const traceId = tracer.startTrace("session1", "bash");
		tracer.endTrace(traceId, { status: "failed", error: "Test error" });

		const trace = tracer.getTrace(traceId);
		expect(trace?.status).toBe("failed");
		expect(trace?.error).toBe("Test error");
	});

	it("should end trace with metadata", () => {
		const traceId = tracer.startTrace("session1", "bash");
		tracer.endTrace(traceId, { status: "completed", metadata: { key: "value" } });

		const trace = tracer.getTrace(traceId);
		expect(trace?.metadata?.key).toBe("value");
	});

	it("should end non-existent trace gracefully", () => {
		expect(() => tracer.endTrace("nonexistent", { status: "completed" })).not.toThrow();
	});

	it("should query with limit", () => {
		tracer.startTrace("session1", "bash");
		tracer.startTrace("session1", "read_file");
		tracer.startTrace("session1", "write_file");

		const traces = tracer.query({ sessionId: "session1", limit: 2 });
		expect(traces.length).toBe(2);
	});

	it("should query by status", () => {
		const traceId = tracer.startTrace("session1", "bash");
		tracer.endTrace(traceId, { status: "completed" });
		tracer.startTrace("session1", "read_file");

		const completed = tracer.query({ status: "completed" });
		expect(completed.length).toBe(1);
	});

	it("should query by time range", () => {
		const now = Date.now();
		tracer.startTrace("session1", "bash");
		tracer.startTrace("session1", "read_file");

		const traces = tracer.query({ startTime: now - 1000, endTime: now + 1000 });
		expect(traces.length).toBe(2);
	});
});

describe("MetricsCollector - additional coverage", () => {
	let metrics: MetricsCollector;

	beforeEach(() => {
		metrics = new MetricsCollector();
	});

	it("should get most problematic tools", () => {
		metrics.recordCall("bash", "success", 100);
		metrics.recordCall("bash", "success", 100);
		metrics.recordCall("bash", "failure", 50);
		metrics.recordCall("read_file", "success", 50);
		metrics.recordCall("read_file", "denied", 50);

		const problematic = metrics.getMostProblematicTools(1);
		expect(problematic.length).toBe(1);
		expect(problematic[0].toolName).toBe("read_file");
	});

	it("should return empty for most problematic when no metrics", () => {
		// No metrics recorded - should return empty
		const problematic = metrics.getMostProblematicTools(5);
		expect(problematic.length).toBe(0);
	});

	it("should reset metrics for specific tool", () => {
		metrics.recordCall("bash", "success", 100);
		metrics.recordCall("bash", "success", 200);

		metrics.resetTool("bash");

		const toolMetrics = metrics.getMetrics("bash");
		expect(toolMetrics?.calls).toBe(0);
	});

	it("should get tool count", () => {
		metrics.recordCall("bash", "success", 100);
		metrics.recordCall("read_file", "success", 50);

		expect(metrics.toolCount).toBe(2);
	});
});
