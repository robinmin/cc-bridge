import { describe, expect, test, vi } from "bun:test";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
	type AgentOtelConfig,
	type AgentOtelService,
	type AgentTelemetrySpan,
	type AgentTelemetryTracer,
	type AgentUsageSnapshot,
	accumulateUsage,
	categorizeAgentError,
	cloneUsageSnapshot,
	createAgentOtelService,
	createObservabilitySnapshot,
	createOtelConfigFromEnv,
	EventCollector,
	finishObservabilityRun,
	recordSpanEvent,
	startObservabilityRun,
	usageFromPiUsage,
} from "@/packages/agent";

describe("otel utility functions", () => {
	test("createAgentOtelService returns null when disabled", () => {
		const service = createAgentOtelService({ enabled: false });
		expect(service).toBeNull();
	});

	test("createAgentOtelService returns null for unsupported protocol", () => {
		const service = createAgentOtelService({
			enabled: true,
			protocol: "grpc",
		} as AgentOtelConfig);
		expect(service).toBeNull();
	});

	test("createAgentOtelService returns null when both traces and metrics disabled", () => {
		const service = createAgentOtelService({
			enabled: true,
			traces: false,
			metrics: false,
		});
		expect(service).toBeNull();
	});

	test("createAgentOtelService creates service when enabled", () => {
		const service = createAgentOtelService({
			enabled: true,
			endpoint: "http://localhost:4318",
		});
		expect(service).not.toBeNull();
		expect(service?.getTracer).toBeDefined();
		expect(service?.getMeter).toBeDefined();
		expect(service?.startRunSpan).toBeDefined();
		expect(service?.recordUsage).toBeDefined();
		expect(service?.recordRunDuration).toBeDefined();
		expect(service?.shutdown).toBeDefined();
	});

	test("createAgentOtelService creates service with custom serviceName", () => {
		const service = createAgentOtelService({
			enabled: true,
			serviceName: "custom-agent",
		});
		expect(service).not.toBeNull();
	});

	test("createAgentOtelService with endpoint containing trailing slashes", () => {
		const service = createAgentOtelService({
			enabled: true,
			endpoint: "http://localhost:4318///",
		});
		expect(service).not.toBeNull();
	});

	test("createAgentOtelService with full OTLP path already in endpoint", () => {
		const service = createAgentOtelService({
			enabled: true,
			endpoint: "http://localhost:4318/v1/traces",
		});
		expect(service).not.toBeNull();
	});

	test("createAgentOtelService with headers", () => {
		const service = createAgentOtelService({
			enabled: true,
			headers: { "X-Custom-Header": "value" },
		});
		expect(service).not.toBeNull();
	});

	test("createAgentOtelService with sample rate 0", () => {
		const service = createAgentOtelService({
			enabled: true,
			sampleRate: 0,
		});
		expect(service).not.toBeNull();
	});

	test("createAgentOtelService with sample rate 1", () => {
		const service = createAgentOtelService({
			enabled: true,
			sampleRate: 1,
		});
		expect(service).not.toBeNull();
	});

	test("createAgentOtelService with invalid sample rate (negative)", () => {
		const service = createAgentOtelService({
			enabled: true,
			sampleRate: -0.5,
		});
		// Invalid sample rate should be ignored, service should still be created
		expect(service).not.toBeNull();
	});

	test("createAgentOtelService with invalid sample rate (>1)", () => {
		const service = createAgentOtelService({
			enabled: true,
			sampleRate: 1.5,
		});
		// Invalid sample rate should be ignored, service should still be created
		expect(service).not.toBeNull();
	});

	test("createAgentOtelService with NaN sample rate", () => {
		const service = createAgentOtelService({
			enabled: true,
			sampleRate: NaN,
		} as AgentOtelConfig);
		// NaN should be ignored, service should still be created
		expect(service).not.toBeNull();
	});

	test("createAgentOtelService records usage metrics", () => {
		const service = createAgentOtelService({
			enabled: true,
		});
		expect(service).not.toBeNull();

		const usage: AgentUsageSnapshot = {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 165,
			cost: {
				input: 0.1,
				output: 0.05,
				cacheRead: 0.01,
				cacheWrite: 0.005,
				total: 0.165,
			},
		};

		// Should not throw
		service?.recordUsage(usage, { "cc_bridge.session_id": "test" });
		service?.recordRunDuration(1000, { "cc_bridge.session_id": "test" });
	});

	test("createAgentOtelService starts spans", () => {
		const service = createAgentOtelService({
			enabled: true,
		});
		expect(service).not.toBeNull();

		const span = service?.startRunSpan({
			"cc_bridge.session_id": "test",
			"cc_bridge.run_id": "run-1",
		});

		expect(span).toBeDefined();
		expect(span.end).toBeDefined();
	});

	test("createAgentOtelService getTracer returns tracer", () => {
		const service = createAgentOtelService({
			enabled: true,
		});
		expect(service).not.toBeNull();

		const tracer = service?.getTracer();
		expect(tracer).toBeDefined();

		const tracer2 = service?.getTracer("custom-name");
		expect(tracer2).toBeDefined();
	});

	test("createAgentOtelService getMeter returns meter", () => {
		const service = createAgentOtelService({
			enabled: true,
		});
		expect(service).not.toBeNull();

		const meter = service?.getMeter();
		expect(meter).toBeDefined();

		const meter2 = service?.getMeter("custom-name");
		expect(meter2).toBeDefined();
	});

	test("createAgentOtelService shutdown works", async () => {
		const service = createAgentOtelService({
			enabled: true,
		});
		expect(service).not.toBeNull();

		// Should not throw
		await service?.shutdown();
	});

	test("createOtelConfigFromEnv returns default config", () => {
		// Clear env vars
		delete process.env.OTEL_ENABLED;
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
		delete process.env.OTEL_SERVICE_NAME;
		delete process.env.OTEL_SAMPLE_RATE;
		delete process.env.OTEL_TRACES_ENABLED;
		delete process.env.OTEL_METRICS_ENABLED;
		delete process.env.OTEL_FLUSH_INTERVAL_MS;

		const config = createOtelConfigFromEnv();

		expect(config.enabled).toBe(false);
		expect(config.endpoint).toBeUndefined();
		expect(config.protocol).toBe("http/protobuf");
		expect(config.serviceName).toBeUndefined();
		expect(config.sampleRate).toBeUndefined();
		expect(config.traces).toBe(true);
		expect(config.metrics).toBe(true);
		expect(config.flushIntervalMs).toBeUndefined();
	});

	test("createOtelConfigFromEnv reads from environment", () => {
		process.env.OTEL_ENABLED = "true";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel:4318";
		process.env.OTEL_SERVICE_NAME = "test-agent";
		process.env.OTEL_SAMPLE_RATE = "0.5";
		process.env.OTEL_TRACES_ENABLED = "false";
		process.env.OTEL_METRICS_ENABLED = "false";
		process.env.OTEL_FLUSH_INTERVAL_MS = "30000";

		const config = createOtelConfigFromEnv();

		expect(config.enabled).toBe(true);
		expect(config.endpoint).toBe("http://otel:4318");
		expect(config.serviceName).toBe("test-agent");
		expect(config.sampleRate).toBe(0.5);
		expect(config.traces).toBe(false);
		expect(config.metrics).toBe(false);
		expect(config.flushIntervalMs).toBe(30000);

		// Cleanup
		delete process.env.OTEL_ENABLED;
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		delete process.env.OTEL_SERVICE_NAME;
		delete process.env.OTEL_SAMPLE_RATE;
		delete process.env.OTEL_TRACES_ENABLED;
		delete process.env.OTEL_METRICS_ENABLED;
		delete process.env.OTEL_FLUSH_INTERVAL_MS;
	});
});

describe("observability - cloneUsageSnapshot", () => {
	test("returns zero usage when undefined", () => {
		const result = cloneUsageSnapshot(undefined);
		expect(result.input).toBe(0);
		expect(result.output).toBe(0);
		expect(result.totalTokens).toBe(0);
	});

	test("clones usage snapshot", () => {
		const original: AgentUsageSnapshot = {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 165,
			cost: {
				input: 0.1,
				output: 0.05,
				cacheRead: 0.01,
				cacheWrite: 0.005,
				total: 0.165,
			},
		};

		const cloned = cloneUsageSnapshot(original);

		expect(cloned.input).toBe(100);
		expect(cloned.output).toBe(50);
		expect(cloned.cost.total).toBe(0.165);
		// Verify it's a deep clone
		cloned.cost.total = 999;
		expect(original.cost.total).toBe(0.165);
	});
});

describe("observability - usageFromPiUsage", () => {
	test("returns zero usage when undefined", () => {
		const result = usageFromPiUsage(undefined);
		expect(result.input).toBe(0);
		expect(result.output).toBe(0);
	});

	test("returns zero usage when null", () => {
		const result = usageFromPiUsage(null);
		expect(result.input).toBe(0);
		expect(result.output).toBe(0);
	});

	test("normalizes partial usage", () => {
		const result = usageFromPiUsage({ input: 100, output: 50 });
		expect(result.input).toBe(100);
		expect(result.output).toBe(50);
		expect(result.totalTokens).toBe(0); // Not provided
		expect(result.cost.total).toBe(0); // Not provided
	});
});

describe("observability - startObservabilityRun with OTEL service", () => {
	test("uses OTEL service when provided", () => {
		const snapshot = createObservabilitySnapshot("session-1", "anthropic", "claude-sonnet-4-6");

		const mockOtelService = {
			startRunSpan: vi.fn().mockReturnValue({
				end: vi.fn(),
				setAttributes: vi.fn(),
				setStatus: vi.fn(),
				addEvent: vi.fn(),
			}),
			recordUsage: vi.fn(),
			recordRunDuration: vi.fn(),
			getTracer: vi.fn(),
			getMeter: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as AgentOtelService;

		const _context = startObservabilityRun(snapshot, 100, {
			otelService: mockOtelService,
		});

		expect(mockOtelService.startRunSpan).toHaveBeenCalled();
		expect(snapshot.runCount).toBe(1);
	});

	test("falls back to tracer when OTEL not provided but tracer is", () => {
		const snapshot = createObservabilitySnapshot("session-1", "anthropic", "claude-sonnet-4-6");

		const mockTracer: AgentTelemetryTracer = {
			startSpan: vi.fn().mockReturnValue({
				end: vi.fn(),
				setAttributes: vi.fn(),
				setStatus: vi.fn(),
				addEvent: vi.fn(),
			}),
		};

		const _context = startObservabilityRun(snapshot, 100, {
			tracer: mockTracer,
		});

		expect(mockTracer.startSpan).toHaveBeenCalled();
	});
});

describe("observability - finishObservabilityRun with OTEL service", () => {
	test("records to OTEL service when provided", () => {
		const snapshot = createObservabilitySnapshot("session-1", "anthropic", "claude-sonnet-4-6");
		const context = startObservabilityRun(snapshot, 100);

		const mockOtelService = {
			startRunSpan: vi.fn(),
			recordUsage: vi.fn(),
			recordRunDuration: vi.fn(),
			getTracer: vi.fn(),
			getMeter: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as AgentOtelService;

		// Update context with mock span
		context.span = {
			end: vi.fn(),
			setAttributes: vi.fn(),
			setStatus: vi.fn(),
			addEvent: vi.fn(),
		};

		const _run = finishObservabilityRun({
			snapshot,
			context,
			outputLength: 50,
			turnCount: 2,
			toolCallCount: 3,
			toolErrorCount: 1,
			aborted: false,
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0.1, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.15 },
			},
			config: { otelService: mockOtelService },
		});

		expect(snapshot.successCount).toBe(1);
		expect(snapshot.failureCount).toBe(0);
	});
});

describe("observability - recordSpanEvent", () => {
	test("records message_start event", () => {
		const span: AgentTelemetrySpan = {
			end: vi.fn(),
			addEvent: vi.fn(),
		};

		const event = {
			type: "message_start",
			message: {
				role: "assistant",
				content: [],
			},
		} as unknown as AgentEvent;

		recordSpanEvent(span, event);

		expect(span.addEvent).toHaveBeenCalledWith("agent.message_start", {
			role: "assistant",
		});
	});

	test("records tool_execution_start event", () => {
		const span: AgentTelemetrySpan = {
			end: vi.fn(),
			addEvent: vi.fn(),
		};

		const event = {
			type: "tool_execution_start",
			toolName: "bash",
			toolCallId: "call-123",
		} as unknown as AgentEvent;

		recordSpanEvent(span, event);

		expect(span.addEvent).toHaveBeenCalledWith("agent.tool_execution_start", {
			tool_name: "bash",
			tool_call_id: "call-123",
		});
	});

	test("records tool_execution_end event with error", () => {
		const span: AgentTelemetrySpan = {
			end: vi.fn(),
			addEvent: vi.fn(),
		};

		const event = {
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "call-123",
			isError: true,
		} as unknown as AgentEvent;

		recordSpanEvent(span, event);

		expect(span.addEvent).toHaveBeenCalledWith("agent.tool_execution_end", {
			tool_name: "bash",
			tool_call_id: "call-123",
			is_error: true,
		});
	});

	test("records agent_end event", () => {
		const span: AgentTelemetrySpan = {
			end: vi.fn(),
			addEvent: vi.fn(),
		};

		const event = {
			type: "agent_end",
			messages: [
				{ role: "user", content: [] },
				{ role: "assistant", content: [] },
			],
		} as unknown as AgentEvent;

		recordSpanEvent(span, event);

		expect(span.addEvent).toHaveBeenCalledWith("agent.agent_end", {
			message_count: 2,
		});
	});

	test("records turn_end event", () => {
		const span: AgentTelemetrySpan = {
			end: vi.fn(),
			addEvent: vi.fn(),
		};

		const event = {
			type: "turn_end",
			toolResults: [{ toolName: "bash" }, { toolName: "read_file" }],
		} as unknown as AgentEvent;

		recordSpanEvent(span, event);

		expect(span.addEvent).toHaveBeenCalledWith("agent.turn_end", {
			tool_result_count: 2,
		});
	});
});

describe("observability - categorizeAgentError", () => {
	test("returns unknown for non-Error", () => {
		expect(categorizeAgentError("string error")).toBe("unknown");
		expect(categorizeAgentError(null)).toBe("unknown");
		expect(categorizeAgentError({})).toBe("unknown");
	});

	test("categorizes timeout errors", () => {
		const error = new Error("Request timeout reached");
		expect(categorizeAgentError(error)).toBe("timeout");
	});

	test("categorizes AbortError", () => {
		const error = new Error("Aborted");
		error.name = "AbortError";
		expect(categorizeAgentError(error)).toBe("timeout");
	});

	test("categorizes max_iterations errors", () => {
		const error = new Error("Max iterations reached");
		expect(categorizeAgentError(error)).toBe("max_iterations");
	});

	test("categorizes tool errors", () => {
		const error = new Error("Tool execution failed");
		expect(categorizeAgentError(error)).toBe("tool");
	});

	test("categorizes provider errors", () => {
		const error = new Error("Rate limit exceeded");
		expect(categorizeAgentError(error)).toBe("provider");
	});

	test("categorizes unauthorized as provider", () => {
		const error = new Error("Unauthorized access");
		expect(categorizeAgentError(error)).toBe("provider");
	});

	test("categorizes model errors", () => {
		const error = new Error("Model not found");
		expect(categorizeAgentError(error)).toBe("provider");
	});

	test("categorizes abort errors", () => {
		const error = new Error("Execution aborted by user");
		expect(categorizeAgentError(error)).toBe("aborted");
	});

	test("returns unknown for Error with non-matching message", () => {
		const error = new Error("Some unrelated error message");
		expect(categorizeAgentError(error)).toBe("unknown");
	});
});

describe("EventCollector - toResult", () => {
	test("returns collected result", () => {
		const collector = new EventCollector();

		// Simulate collecting events
		collector.handleEvent({
			type: "turn_end",
			toolResults: [],
		} as AgentEvent);

		collector.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
			},
		} as AgentEvent);

		const result = collector.toResult();

		expect(result.output).toBe("Hello");
		expect(result.turnCount).toBe(1);
		expect(result.aborted).toBe(false);
	});
});

describe("EventCollector - attachObservability", () => {
	test("attaches observability to result", () => {
		const collector = new EventCollector();

		collector.handleEvent({
			type: "turn_end",
			toolResults: [],
		} as AgentEvent);

		const run = {
			runId: "run-1",
			sessionId: "session-1",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			startedAt: "2024-01-01T00:00:00Z",
			promptLength: 100,
			outputLength: 50,
			turnCount: 1,
			toolCallCount: 0,
			toolErrorCount: 0,
			aborted: false,
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: {
					input: 0.1,
					output: 0.05,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.15,
				},
			},
		};

		// Call the method on the collector instance
		const result = collector.attachObservability(run);

		expect(result.output).toBe("");
		expect(result.observability).toBeDefined();
		expect(result.observability?.runId).toBe("run-1");
	});
});

describe("accumulateUsage", () => {
	test("accumulates AgentUsageSnapshot", () => {
		const target: AgentUsageSnapshot = {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 165,
			cost: {
				input: 0.1,
				output: 0.05,
				cacheRead: 0.01,
				cacheWrite: 0.005,
				total: 0.165,
			},
		};

		const source: AgentUsageSnapshot = {
			input: 50,
			output: 25,
			cacheRead: 5,
			cacheWrite: 2,
			totalTokens: 82,
			cost: {
				input: 0.05,
				output: 0.025,
				cacheRead: 0.005,
				cacheWrite: 0.002,
				total: 0.082,
			},
		};

		accumulateUsage(target, source);

		expect(target.input).toBe(150);
		expect(target.output).toBe(75);
		expect(target.cost.total).toBeCloseTo(0.247);
	});
});
