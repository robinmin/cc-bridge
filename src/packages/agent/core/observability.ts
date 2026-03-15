import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { Usage } from "@mariozechner/pi-ai";
import type { AgentOtelService } from "./otel";

export type AgentErrorCategory =
	| "timeout"
	| "max_iterations"
	| "aborted"
	| "tool"
	| "provider"
	| "configuration"
	| "concurrency"
	| "unknown";

export interface AgentUsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface AgentRunObservability {
	runId: string;
	sessionId: string;
	provider: string;
	model: string;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	promptLength: number;
	outputLength: number;
	turnCount: number;
	toolCallCount: number;
	toolErrorCount: number;
	aborted: boolean;
	errorCategory?: AgentErrorCategory;
	usage: AgentUsageSnapshot;
}

export interface EmbeddedAgentObservabilitySnapshot {
	sessionId: string;
	provider: string;
	model: string;
	runCount: number;
	successCount: number;
	failureCount: number;
	activeRun?: Pick<AgentRunObservability, "runId" | "startedAt" | "promptLength">;
	lastRun?: AgentRunObservability;
	totals: {
		durationMs: number;
		turnCount: number;
		toolCallCount: number;
		toolErrorCount: number;
		usage: AgentUsageSnapshot;
		errorsByCategory: Partial<Record<AgentErrorCategory, number>>;
	};
}

export interface AgentTelemetrySpan {
	addEvent?(name: string, attributes?: Record<string, unknown>): void;
	setAttributes?(attributes: Record<string, unknown>): void;
	recordException?(error: unknown): void;
	setStatus?(status: { code: "ok" | "error"; message?: string }): void;
	end(): void;
}

export interface AgentTelemetryTracer {
	startSpan(name: string, options?: { attributes?: Record<string, unknown> }): AgentTelemetrySpan;
}

export interface EmbeddedAgentObservabilityConfig {
	tracer?: AgentTelemetryTracer;
	otelService?: AgentOtelService;
	onRunStart?: (run: AgentRunObservability) => void;
	onRunEnd?: (run: AgentRunObservability) => void;
}

export interface ObservabilityRunContext {
	runId: string;
	startedAtMs: number;
	run: AgentRunObservability;
	span: AgentTelemetrySpan;
}

const createZeroUsage = (): AgentUsageSnapshot => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
});

export function createRunId(sessionId: string): string {
	return `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function cloneUsageSnapshot(usage?: AgentUsageSnapshot): AgentUsageSnapshot {
	if (!usage) {
		return createZeroUsage();
	}
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { ...usage.cost },
	};
}

export function usageFromPiUsage(usage?: Partial<Usage> | null): AgentUsageSnapshot {
	if (!usage) {
		return createZeroUsage();
	}
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		totalTokens: usage.totalTokens ?? 0,
		cost: {
			input: usage.cost?.input ?? 0,
			output: usage.cost?.output ?? 0,
			cacheRead: usage.cost?.cacheRead ?? 0,
			cacheWrite: usage.cost?.cacheWrite ?? 0,
			total: usage.cost?.total ?? 0,
		},
	};
}

export function accumulateUsage(target: AgentUsageSnapshot, usage?: Partial<Usage> | AgentUsageSnapshot | null): void {
	const normalized =
		"totalTokens" in (usage ?? {}) ? (usage as AgentUsageSnapshot) : usageFromPiUsage(usage as Partial<Usage>);
	target.input += normalized.input;
	target.output += normalized.output;
	target.cacheRead += normalized.cacheRead;
	target.cacheWrite += normalized.cacheWrite;
	target.totalTokens += normalized.totalTokens;
	target.cost.input += normalized.cost.input;
	target.cost.output += normalized.cost.output;
	target.cost.cacheRead += normalized.cost.cacheRead;
	target.cost.cacheWrite += normalized.cost.cacheWrite;
	target.cost.total += normalized.cost.total;
}

export function createObservabilitySnapshot(
	sessionId: string,
	provider: string,
	model: string,
): EmbeddedAgentObservabilitySnapshot {
	return {
		sessionId,
		provider,
		model,
		runCount: 0,
		successCount: 0,
		failureCount: 0,
		totals: {
			durationMs: 0,
			turnCount: 0,
			toolCallCount: 0,
			toolErrorCount: 0,
			usage: createZeroUsage(),
			errorsByCategory: {},
		},
	};
}

export function startObservabilityRun(
	snapshot: EmbeddedAgentObservabilitySnapshot,
	promptLength: number,
	config?: EmbeddedAgentObservabilityConfig,
): ObservabilityRunContext {
	const runId = createRunId(snapshot.sessionId);
	const startedAtMs = Date.now();
	const run: AgentRunObservability = {
		runId,
		sessionId: snapshot.sessionId,
		provider: snapshot.provider,
		model: snapshot.model,
		startedAt: new Date(startedAtMs).toISOString(),
		promptLength,
		outputLength: 0,
		turnCount: 0,
		toolCallCount: 0,
		toolErrorCount: 0,
		aborted: false,
		usage: createZeroUsage(),
	};

	// Try OTEL service first, then fallback to tracer
	let span: AgentTelemetrySpan;
	const otelAttrs = {
		"cc_bridge.run_id": runId,
		"cc_bridge.session_id": snapshot.sessionId,
		"cc_bridge.provider": snapshot.provider,
		"cc_bridge.model": snapshot.model,
		"cc_bridge.prompt_length": promptLength,
	};

	if (config?.otelService) {
		span = config.otelService.startRunSpan(otelAttrs);
	} else if (config?.tracer) {
		span = config.tracer.startSpan("embedded_agent.prompt", {
			attributes: otelAttrs,
		});
	} else {
		span = { end() {} };
	}

	snapshot.runCount += 1;
	snapshot.activeRun = {
		runId,
		startedAt: run.startedAt,
		promptLength,
	};
	config?.onRunStart?.({ ...run, usage: cloneUsageSnapshot(run.usage) });

	return { runId, startedAtMs, run, span };
}

export function finishObservabilityRun(params: {
	snapshot: EmbeddedAgentObservabilitySnapshot;
	context: ObservabilityRunContext;
	outputLength: number;
	turnCount: number;
	toolCallCount: number;
	toolErrorCount: number;
	aborted: boolean;
	usage?: AgentUsageSnapshot;
	errorCategory?: AgentErrorCategory;
	config?: EmbeddedAgentObservabilityConfig;
}): AgentRunObservability {
	const endedAtMs = Date.now();
	const finishedRun: AgentRunObservability = {
		...params.context.run,
		endedAt: new Date(endedAtMs).toISOString(),
		durationMs: Math.max(0, endedAtMs - params.context.startedAtMs),
		outputLength: params.outputLength,
		turnCount: params.turnCount,
		toolCallCount: params.toolCallCount,
		toolErrorCount: params.toolErrorCount,
		aborted: params.aborted,
		errorCategory: params.errorCategory,
		usage: cloneUsageSnapshot(params.usage),
	};

	params.snapshot.lastRun = finishedRun;
	params.snapshot.activeRun = undefined;
	params.snapshot.totals.durationMs += finishedRun.durationMs ?? 0;
	params.snapshot.totals.turnCount += finishedRun.turnCount;
	params.snapshot.totals.toolCallCount += finishedRun.toolCallCount;
	params.snapshot.totals.toolErrorCount += finishedRun.toolErrorCount;
	accumulateUsage(params.snapshot.totals.usage, finishedRun.usage);

	if (finishedRun.errorCategory) {
		params.snapshot.failureCount += 1;
		params.snapshot.totals.errorsByCategory[finishedRun.errorCategory] =
			(params.snapshot.totals.errorsByCategory[finishedRun.errorCategory] ?? 0) + 1;
	} else {
		params.snapshot.successCount += 1;
	}

	// Record to OTEL service if available
	const metricsAttrs = {
		"cc_bridge.session_id": finishedRun.sessionId,
		"cc_bridge.provider": finishedRun.provider,
		"cc_bridge.model": finishedRun.model,
		"cc_bridge.outcome": finishedRun.errorCategory ? "error" : "success",
		"cc_bridge.aborted": finishedRun.aborted,
	};

	if (params.config?.otelService) {
		params.config.otelService.recordUsage(finishedRun.usage, metricsAttrs);
		params.config.otelService.recordRunDuration(finishedRun.durationMs ?? 0, metricsAttrs);
	}

	// Set span attributes
	const spanAttrs = {
		"cc_bridge.duration_ms": finishedRun.durationMs ?? 0,
		"cc_bridge.output_length": finishedRun.outputLength,
		"cc_bridge.turn_count": finishedRun.turnCount,
		"cc_bridge.tool_call_count": finishedRun.toolCallCount,
		"cc_bridge.tool_error_count": finishedRun.toolErrorCount,
		"cc_bridge.aborted": finishedRun.aborted,
		"cc_bridge.usage.total_tokens": finishedRun.usage.totalTokens,
		"cc_bridge.cost.total": finishedRun.usage.cost.total,
	};
	params.context.span.setAttributes?.(spanAttrs);
	params.context.span.setStatus?.(
		finishedRun.errorCategory ? { code: "error", message: finishedRun.errorCategory } : { code: "ok" },
	);
	params.context.span.end();
	params.config?.onRunEnd?.({
		...finishedRun,
		usage: cloneUsageSnapshot(finishedRun.usage),
	});
	return finishedRun;
}

export function recordSpanEvent(span: AgentTelemetrySpan, event: AgentEvent): void {
	const attributes: Record<string, unknown> = {};
	switch (event.type) {
		case "message_start":
		case "message_end":
			attributes.role = event.message.role;
			break;
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			attributes.tool_name = event.toolName;
			attributes.tool_call_id = event.toolCallId;
			if ("isError" in event) {
				attributes.is_error = event.isError;
			}
			break;
		case "agent_end":
			attributes.message_count = event.messages.length;
			break;
		case "turn_end":
			attributes.tool_result_count = event.toolResults.length;
			break;
	}
	span.addEvent?.(`agent.${event.type}`, attributes);
}

export function categorizeAgentError(error: unknown): AgentErrorCategory {
	if (!(error instanceof Error)) {
		return "unknown";
	}
	const message = error.message.toLowerCase();
	if (message.includes("already running")) {
		return "concurrency";
	}
	if (message.includes("api key") || message.includes("configured")) {
		return "configuration";
	}
	if (message.includes("timeout") || error.name === "AbortError") {
		return "timeout";
	}
	if (message.includes("max iterations")) {
		return "max_iterations";
	}
	if (message.includes("tool")) {
		return "tool";
	}
	if (
		message.includes("provider") ||
		message.includes("rate limit") ||
		message.includes("unauthorized") ||
		message.includes("model")
	) {
		return "provider";
	}
	if (message.includes("abort")) {
		return "aborted";
	}
	return "unknown";
}
