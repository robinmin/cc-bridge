/**
 * Audit Logging
 *
 * Structured tool call audit events for security and compliance.
 */

import { logger } from "@/packages/logger";
import { getTierName, type PermissionTier } from "./tiers";

/**
 * Result of a tool call
 */
export type ToolCallResult = "success" | "failure" | "denied";

/**
 * Tool call audit event
 */
export interface ToolAuditEvent {
	/** Event timestamp (ms since epoch) */
	timestamp: number;
	/** Session ID */
	sessionId: string;
	/** Tool name */
	toolName: string;
	/** Operation performed */
	operation: string;
	/** Tool parameters (sanitized) */
	params: Record<string, unknown>;
	/** Call result */
	result: ToolCallResult;
	/** Permission tier used */
	tier: PermissionTier;
	/** Whether this call used escalated permissions */
	escalated: boolean;
	/** Call duration in ms */
	durationMs: number;
	/** Error message if failed */
	error?: string;
	/** User ID if available */
	userId?: string;
}

/**
 * Filter for querying audit events
 */
export interface AuditFilter {
	/** Filter by session ID */
	sessionId?: string;
	/** Filter by tool name */
	toolName?: string;
	/** Filter by result type */
	result?: ToolCallResult;
	/** Filter by start timestamp */
	startTime?: number;
	/** Filter by end timestamp */
	endTime?: number;
	/** Filter by user ID */
	userId?: string;
	/** Maximum events to return */
	limit?: number;
}

/**
 * Audit log sink interface
 * Implement this to add custom storage (file, database, external service, etc.)
 */
export interface AuditSink {
	/** Log an audit event */
	log(event: ToolAuditEvent): void;
	/** Query audit events */
	query(filter: AuditFilter): ToolAuditEvent[];
}

/**
 * In-memory audit sink (for testing and short-term use)
 */
export class InMemoryAuditSink implements AuditSink {
	private events: ToolAuditEvent[] = [];
	private maxEvents: number;

	constructor(maxEvents: number = 10_000) {
		this.maxEvents = maxEvents;
	}

	log(event: ToolAuditEvent): void {
		this.events.push(event);

		// Trim old events if we exceed limit
		if (this.events.length > this.maxEvents) {
			this.events = this.events.slice(-this.maxEvents);
		}
	}

	query(filter: AuditFilter): ToolAuditEvent[] {
		let results = [...this.events];

		if (filter.sessionId) {
			results = results.filter((e) => e.sessionId === filter.sessionId);
		}

		if (filter.toolName) {
			results = results.filter((e) => e.toolName === filter.toolName);
		}

		if (filter.result) {
			results = results.filter((e) => e.result === filter.result);
		}

		const startTime = filter.startTime;
		if (startTime !== undefined) {
			results = results.filter((e) => e.timestamp >= startTime);
		}

		const endTime = filter.endTime;
		if (endTime !== undefined) {
			results = results.filter((e) => e.timestamp <= endTime);
		}

		if (filter.userId) {
			results = results.filter((e) => e.userId === filter.userId);
		}

		if (filter.limit) {
			results = results.slice(-filter.limit);
		}

		return results;
	}

	/**
	 * Clear all events
	 */
	clear(): void {
		this.events = [];
	}

	/**
	 * Get event count
	 */
	get count(): number {
		return this.events.length;
	}
}

/**
 * Console audit sink (for development/debugging)
 */
export class ConsoleAuditSink implements AuditSink {
	private includeParams: boolean;

	constructor(includeParams: boolean = false) {
		this.includeParams = includeParams;
	}

	log(event: ToolAuditEvent): void {
		const level = event.result === "denied" ? "warn" : "info";
		const paramsToLog = this.includeParams ? event.params : { ...event.params };

		logger[level](
			{
				audit: true,
				timestamp: new Date(event.timestamp).toISOString(),
				sessionId: event.sessionId,
				toolName: event.toolName,
				operation: event.operation,
				result: event.result,
				tier: getTierName(event.tier),
				escalated: event.escalated,
				durationMs: event.durationMs,
				error: event.error,
				userId: event.userId,
				params: paramsToLog,
			},
			`Tool call: ${event.toolName} - ${event.result}`,
		);
	}

	query(_filter: AuditFilter): ToolAuditEvent[] {
		// Console sink doesn't store, just logs
		return [];
	}
}

/**
 * Multi-sink audit logger
 * Logs to multiple sinks simultaneously
 */
export class MultiSinkAuditLogger implements AuditSink {
	private sinks: AuditSink[];

	constructor(sinks: AuditSink[]) {
		this.sinks = sinks;
	}

	addSink(sink: AuditSink): void {
		this.sinks.push(sink);
	}

	removeSink(sink: AuditSink): void {
		const index = this.sinks.indexOf(sink);
		if (index >= 0) {
			this.sinks.splice(index, 1);
		}
	}

	log(event: ToolAuditEvent): void {
		for (const sink of this.sinks) {
			try {
				sink.log(event);
			} catch (error) {
				logger.error({ error, sink: sink.constructor.name }, "Failed to log to audit sink");
			}
		}
	}

	query(filter: AuditFilter): ToolAuditEvent[] {
		// Query from first sink that returns results
		for (const sink of this.sinks) {
			const results = sink.query(filter);
			if (results.length > 0) {
				return results;
			}
		}
		return [];
	}
}

/**
 * Audit logger wrapper for tool calls
 * Convenience class that creates audit events for tool executions
 */
export class AuditLogger {
	private sink: AuditSink;
	private enabled: boolean;

	constructor(sink: AuditSink, enabled: boolean = true) {
		this.sink = sink;
		this.enabled = enabled;
	}

	/**
	 * Log a tool call start (for tracking duration)
	 */
	logCall(
		_sessionId: string,
		_toolName: string,
		_operation: string,
		params: Record<string, unknown>,
		_tier: PermissionTier,
		_escalated: boolean,
	): void {
		// Store start time in params for later retrieval
		(params as Record<string, unknown>).__startTime = Date.now();
	}

	/**
	 * Log a tool call result
	 */
	logResult(
		sessionId: string,
		toolName: string,
		operation: string,
		params: Record<string, unknown>,
		result: ToolCallResult,
		tier: PermissionTier,
		escalated: boolean,
		error?: string,
	): void {
		if (!this.enabled) return;

		const startTime = (params as Record<string, unknown>).__startTime as number | undefined;
		const durationMs = startTime ? Date.now() - startTime : 0;

		const event: ToolAuditEvent = {
			timestamp: Date.now(),
			sessionId,
			toolName,
			operation,
			params: this.sanitizeParams(params),
			result,
			tier,
			escalated,
			durationMs,
			error,
		};

		this.sink.log(event);
	}

	/**
	 * Query audit events
	 */
	query(filter: AuditFilter): ToolAuditEvent[] {
		return this.sink.query(filter);
	}

	/**
	 * Sanitize parameters to remove sensitive data
	 */
	private sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
		const sensitiveKeys = ["password", "token", "secret", "apiKey", "credential"];
		const sanitized: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(params)) {
			// Skip internal keys
			if (key.startsWith("__")) continue;

			// Mask sensitive values
			if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk))) {
				sanitized[key] = "[REDACTED]";
			} else if (typeof value === "object" && value !== null) {
				sanitized[key] = this.sanitizeParams(value as Record<string, unknown>);
			} else {
				sanitized[key] = value;
			}
		}

		return sanitized;
	}
}

/**
 * Create a default audit logger with console output
 */
export function createAuditLogger(enabled: boolean = true): AuditLogger {
	const consoleSink = new ConsoleAuditSink(false);
	return new AuditLogger(consoleSink, enabled);
}
