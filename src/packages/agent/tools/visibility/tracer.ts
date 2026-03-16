/**
 * Tool Call Tracer
 *
 * Tracks tool call chains for debugging and observability.
 */

import { logger } from "@/packages/logger";

/**
 * Status of a trace
 */
export type TraceStatus = "started" | "completed" | "failed" | "cancelled";

/**
 * A tool call trace
 */
export interface ToolCallTrace {
	/** Unique trace ID */
	traceId: string;
	/** Session ID */
	sessionId: string;
	/** Tool name */
	toolName: string;
	/** Operation */
	operation?: string;
	/** Trace status */
	status: TraceStatus;
	/** Start timestamp */
	startTime: number;
	/** End timestamp */
	endTime?: number;
	/** Duration in ms */
	durationMs?: number;
	/** Error message if failed */
	error?: string;
	/** Parent trace ID (for nested calls) */
	parentTraceId?: string;
	/** Child trace IDs */
	childTraceIds: string[];
	/** Metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Filter for querying traces
 */
export interface TraceFilter {
	sessionId?: string;
	toolName?: string;
	status?: TraceStatus;
	startTime?: number;
	endTime?: number;
	limit?: number;
}

/**
 * Tool tracer
 *
 * Tracks tool call chains for debugging:
 * - Start/end traces
 * - Link parent-child relationships
 * - Query trace history
 */
export class ToolTracer {
	private traces: Map<string, ToolCallTrace> = new Map();
	private sessionTraces: Map<string, Set<string>> = new Map();
	private sequence: number = 0;

	/**
	 * Start a new trace
	 */
	startTrace(
		sessionId: string,
		toolName: string,
		options?: {
			operation?: string;
			parentTraceId?: string;
			metadata?: Record<string, unknown>;
		},
	): string {
		const traceId = this.generateTraceId();
		const trace: ToolCallTrace = {
			traceId,
			sessionId,
			toolName,
			operation: options?.operation,
			status: "started",
			startTime: Date.now(),
			parentTraceId: options?.parentTraceId,
			childTraceIds: [],
			metadata: options?.metadata,
		};

		this.traces.set(traceId, trace);

		// Link to parent if provided
		if (options?.parentTraceId) {
			const parent = this.traces.get(options.parentTraceId);
			if (parent) {
				parent.childTraceIds.push(traceId);
			}
		}

		// Track by session
		if (!this.sessionTraces.has(sessionId)) {
			this.sessionTraces.set(sessionId, new Set());
		}
		this.sessionTraces.get(sessionId)?.add(traceId);

		logger.debug({ traceId, sessionId, toolName }, "Tool trace started");

		return traceId;
	}

	/**
	 * End a trace
	 */
	endTrace(
		traceId: string,
		result?: {
			status?: TraceStatus;
			error?: string;
			metadata?: Record<string, unknown>;
		},
	): void {
		const trace = this.traces.get(traceId);
		if (!trace) {
			logger.warn({ traceId }, "Attempted to end non-existent trace");
			return;
		}

		trace.status = result?.status ?? "completed";
		trace.endTime = Date.now();
		trace.durationMs = trace.endTime - trace.startTime;
		trace.error = result?.error;

		if (result?.metadata) {
			trace.metadata = { ...trace.metadata, ...result.metadata };
		}

		logger.debug(
			{
				traceId,
				toolName: trace.toolName,
				status: trace.status,
				durationMs: trace.durationMs,
			},
			"Tool trace ended",
		);
	}

	/**
	 * Get a trace by ID
	 */
	getTrace(traceId: string): ToolCallTrace | undefined {
		return this.traces.get(traceId);
	}

	/**
	 * Get all traces for a session
	 */
	getTracesBySession(sessionId: string): ToolCallTrace[] {
		const traceIds = this.sessionTraces.get(sessionId);
		if (!traceIds) return [];

		const traces: ToolCallTrace[] = [];
		for (const id of traceIds) {
			const trace = this.traces.get(id);
			if (trace) traces.push(trace);
		}

		return traces.sort((a, b) => a.startTime - b.startTime);
	}

	/**
	 * Query traces by filter
	 */
	query(filter: TraceFilter): ToolCallTrace[] {
		let results: ToolCallTrace[] = [...this.traces.values()];

		if (filter.sessionId) {
			results = results.filter((t) => t.sessionId === filter.sessionId);
		}

		if (filter.toolName) {
			results = results.filter((t) => t.toolName === filter.toolName);
		}

		if (filter.status) {
			results = results.filter((t) => t.status === filter.status);
		}

		const startTime = filter.startTime;
		if (startTime !== undefined) {
			results = results.filter((t) => t.startTime >= startTime);
		}

		const endTime = filter.endTime;
		if (endTime !== undefined) {
			results = results.filter((t) => t.startTime <= endTime);
		}

		// Sort by start time descending (newest first)
		results.sort((a, b) => b.startTime - a.startTime);

		if (filter.limit) {
			results = results.slice(0, filter.limit);
		}

		return results;
	}

	/**
	 * Get active (in-progress) traces for a session
	 */
	getActiveTraces(sessionId: string): ToolCallTrace[] {
		const traces = this.getTracesBySession(sessionId);
		return traces.filter((t) => t.status === "started");
	}

	/**
	 * Clear old traces (for memory management)
	 */
	cleanup(maxAgeMs: number = 3600000): number {
		const cutoff = Date.now() - maxAgeMs;
		let cleaned = 0;

		for (const [traceId, trace] of this.traces) {
			if (trace.startTime < cutoff && trace.status !== "started") {
				this.traces.delete(traceId);

				// Remove from session index
				const sessionTraceIds = this.sessionTraces.get(trace.sessionId);
				if (sessionTraceIds) {
					sessionTraceIds.delete(traceId);
					if (sessionTraceIds.size === 0) {
						this.sessionTraces.delete(trace.sessionId);
					}
				}
				cleaned++;
			}
		}

		if (cleaned > 0) {
			logger.debug({ cleaned, remaining: this.traces.size }, "Traces cleaned up");
		}

		return cleaned;
	}

	/**
	 * Get trace count
	 */
	get count(): number {
		return this.traces.size;
	}

	/**
	 * Generate unique trace ID
	 */
	private generateTraceId(): string {
		return `trace-${Date.now()}-${++this.sequence}`;
	}
}
