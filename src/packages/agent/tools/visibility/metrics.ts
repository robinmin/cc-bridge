/**
 * Tool Usage Metrics
 *
 * Tracks tool usage patterns for observability.
 */

import { logger } from "@/packages/logger";

/**
 * Metrics for a single tool
 */
export interface ToolMetrics {
	/** Tool name */
	toolName: string;
	/** Total number of calls */
	calls: number;
	/** Number of successful calls */
	successes: number;
	/** Number of failed calls */
	failures: number;
	/** Number of denied calls */
	denials: number;
	/** Total duration of all calls in ms */
	totalDurationMs: number;
	/** Average duration in ms */
	avgDurationMs: number;
	/** Minimum call duration in ms */
	minDurationMs: number;
	/** Maximum call duration in ms */
	maxDurationMs: number;
	/** Last call timestamp */
	lastCallAt?: number;
}

/**
 * Overall metrics summary
 */
export interface MetricsSummary {
	/** Metrics per tool */
	byTool: Record<string, ToolMetrics>;
	/** Total calls across all tools */
	totalCalls: number;
	/** Total successes */
	totalSuccesses: number;
	/** Total failures */
	totalFailures: number;
	/** Total denials */
	totalDenials: number;
	/** Overall average duration */
	overallAvgDurationMs: number;
}

/**
 * Metrics collector
 *
 * Collects and aggregates tool usage metrics:
 * - Call counts
 * - Success/failure rates
 * - Duration statistics
 */
export class MetricsCollector {
	private metrics: Map<string, ToolMetrics> = new Map();

	/**
	 * Record a tool call
	 */
	recordCall(toolName: string, result: "success" | "failure" | "denied", durationMs: number): void {
		let toolMetrics = this.metrics.get(toolName);

		if (!toolMetrics) {
			toolMetrics = {
				toolName,
				calls: 0,
				successes: 0,
				failures: 0,
				denials: 0,
				totalDurationMs: 0,
				avgDurationMs: 0,
				minDurationMs: Infinity,
				maxDurationMs: 0,
			};
			this.metrics.set(toolName, toolMetrics);
		}

		// Update counts
		toolMetrics.calls++;
		toolMetrics.totalDurationMs += durationMs;
		toolMetrics.avgDurationMs = Math.round(toolMetrics.totalDurationMs / toolMetrics.calls);
		toolMetrics.minDurationMs = Math.min(toolMetrics.minDurationMs, durationMs);
		toolMetrics.maxDurationMs = Math.max(toolMetrics.maxDurationMs, durationMs);
		toolMetrics.lastCallAt = Date.now();

		// Update result-specific counts
		switch (result) {
			case "success":
				toolMetrics.successes++;
				break;
			case "failure":
				toolMetrics.failures++;
				break;
			case "denied":
				toolMetrics.denials++;
				break;
		}

		logger.debug(
			{
				toolName,
				result,
				durationMs,
				totalCalls: toolMetrics.calls,
			},
			"Tool call recorded",
		);
	}

	/**
	 * Get metrics for a specific tool
	 */
	getMetrics(toolName?: string): ToolMetrics | Record<string, ToolMetrics> {
		if (toolName) {
			return (
				this.metrics.get(toolName) ?? {
					toolName,
					calls: 0,
					successes: 0,
					failures: 0,
					denials: 0,
					totalDurationMs: 0,
					avgDurationMs: 0,
					minDurationMs: 0,
					maxDurationMs: 0,
				}
			);
		}

		// Return all metrics
		const result: Record<string, ToolMetrics> = {};
		for (const [name, metrics] of this.metrics) {
			result[name] = { ...metrics };
		}
		return result;
	}

	/**
	 * Get overall metrics summary
	 */
	getSummary(): MetricsSummary {
		const byTool: Record<string, ToolMetrics> = {};
		let totalCalls = 0;
		let totalSuccesses = 0;
		let totalFailures = 0;
		let totalDenials = 0;
		let totalDuration = 0;

		for (const [name, metrics] of this.metrics) {
			byTool[name] = { ...metrics };
			totalCalls += metrics.calls;
			totalSuccesses += metrics.successes;
			totalFailures += metrics.failures;
			totalDenials += metrics.denials;
			totalDuration += metrics.totalDurationMs;
		}

		return {
			byTool,
			totalCalls,
			totalSuccesses,
			totalFailures,
			totalDenials,
			overallAvgDurationMs: totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0,
		};
	}

	/**
	 * Get top N tools by call count
	 */
	getTopTools(limit: number = 10): ToolMetrics[] {
		return [...this.metrics.values()].sort((a, b) => b.calls - a.calls).slice(0, limit);
	}

	/**
	 * Get tools with highest failure rate
	 */
	getMostProblematicTools(limit: number = 5): ToolMetrics[] {
		return [...this.metrics.values()]
			.filter((m) => m.calls > 0)
			.sort((a, b) => {
				const aFailureRate = (a.failures + a.denials) / a.calls;
				const bFailureRate = (b.failures + b.denials) / b.calls;
				return bFailureRate - aFailureRate;
			})
			.slice(0, limit);
	}

	/**
	 * Reset all metrics
	 */
	reset(): void {
		this.metrics.clear();
		logger.info("Metrics reset");
	}

	/**
	 * Reset metrics for a specific tool
	 */
	resetTool(toolName: string): void {
		this.metrics.delete(toolName);
	}

	/**
	 * Get total number of tracked tools
	 */
	get toolCount(): number {
		return this.metrics.size;
	}
}
