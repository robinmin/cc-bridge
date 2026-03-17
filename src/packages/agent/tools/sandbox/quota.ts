/**
 * Resource Quota Enforcement and Monitoring
 *
 * Tracks and enforces resource quotas for sandboxed tool executions.
 * Provides concurrent execution limits, usage tracking, and violation detection.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Resource quota configuration for sandboxed executions
 */
export interface ResourceQuota {
	/** Maximum memory in bytes per execution */
	maxMemoryBytes: number;
	/** Maximum CPU usage as percentage (e.g., 100 = 1 core) */
	maxCpuPercent: number;
	/** Maximum disk usage in bytes (optional) */
	maxDiskBytes?: number;
	/** Maximum outbound network bytes (optional) */
	maxNetworkBytesOut?: number;
	/** Maximum execution time in milliseconds */
	maxExecutionMs: number;
	/** Maximum number of concurrent executions */
	maxConcurrentExecs: number;
}

/**
 * Result of checking current quota status
 */
export interface QuotaStatus {
	/** Whether all resource usage is within limits */
	withinLimits: boolean;
	/** List of violated quota constraints */
	violations: string[];
}

/**
 * Summary of resource usage against quota
 */
export interface QuotaUsageSummary {
	/** Total number of recorded executions */
	totalExecutions: number;
	/** Total duration across all executions in ms */
	totalDurationMs: number;
	/** Peak memory usage observed in bytes */
	peakMemoryBytes: number;
	/** Number of currently active concurrent executions */
	currentConcurrent: number;
	/** The quota this summary is measured against */
	quota: ResourceQuota;
}

/**
 * Execution result data for usage recording
 */
export interface ExecutionRecord {
	/** Duration of the execution in milliseconds */
	durationMs: number;
	/** Memory used during execution in bytes (optional) */
	memoryUsedBytes?: number;
}

// =============================================================================
// QuotaEnforcer
// =============================================================================

/**
 * Enforces resource quotas and tracks usage for sandboxed tool executions.
 *
 * @example
 * ```typescript
 * const enforcer = new QuotaEnforcer(DEFAULT_QUOTA);
 *
 * // Check quota before execution
 * const status = enforcer.checkQuota();
 * if (!status.withinLimits) {
 *   console.log("Quota violated:", status.violations);
 * }
 *
 * // Acquire execution slot
 * if (enforcer.acquireExecSlot()) {
 *   try {
 *     // ... run sandboxed command ...
 *     enforcer.recordExecution({ durationMs: 150, memoryUsedBytes: 1024 });
 *   } finally {
 *     enforcer.releaseExecSlot();
 *   }
 * }
 * ```
 */
export class QuotaEnforcer {
	private currentConcurrent = 0;
	private totalExecutions = 0;
	private totalDurationMs = 0;
	private peakMemoryBytes = 0;

	constructor(private readonly quota: ResourceQuota) {}

	/**
	 * Check current resource usage against quota limits.
	 * Returns violations for any limits that are exceeded.
	 */
	checkQuota(): QuotaStatus {
		const violations: string[] = [];

		if (this.currentConcurrent >= this.quota.maxConcurrentExecs) {
			violations.push(`Concurrent executions at limit: ${this.currentConcurrent}/${this.quota.maxConcurrentExecs}`);
		}

		if (this.peakMemoryBytes > this.quota.maxMemoryBytes) {
			violations.push(`Peak memory exceeded: ${this.peakMemoryBytes} bytes > ${this.quota.maxMemoryBytes} bytes`);
		}

		return {
			withinLimits: violations.length === 0,
			violations,
		};
	}

	/**
	 * Attempt to acquire an execution slot.
	 * Returns false if the maximum concurrent execution limit has been reached.
	 */
	acquireExecSlot(): boolean {
		if (this.currentConcurrent >= this.quota.maxConcurrentExecs) {
			return false;
		}
		this.currentConcurrent++;
		return true;
	}

	/**
	 * Release a previously acquired execution slot.
	 * Safe to call even if no slot is held (will not go below zero).
	 */
	releaseExecSlot(): void {
		if (this.currentConcurrent > 0) {
			this.currentConcurrent--;
		}
	}

	/**
	 * Record a completed execution for usage tracking.
	 * Updates total execution count, duration, and peak memory.
	 */
	recordExecution(result: ExecutionRecord): void {
		this.totalExecutions++;
		this.totalDurationMs += result.durationMs;

		if (result.memoryUsedBytes !== undefined && result.memoryUsedBytes > this.peakMemoryBytes) {
			this.peakMemoryBytes = result.memoryUsedBytes;
		}
	}

	/**
	 * Get a summary of all resource usage against the configured quota.
	 */
	getUsageSummary(): QuotaUsageSummary {
		return {
			totalExecutions: this.totalExecutions,
			totalDurationMs: this.totalDurationMs,
			peakMemoryBytes: this.peakMemoryBytes,
			currentConcurrent: this.currentConcurrent,
			quota: this.quota,
		};
	}
}

// =============================================================================
// Preset Quotas
// =============================================================================

/**
 * Default quota - balanced limits for general use
 */
export const DEFAULT_QUOTA: ResourceQuota = {
	maxMemoryBytes: 512 * 1024 * 1024, // 512 MB
	maxCpuPercent: 100, // 1 core
	maxDiskBytes: 1024 * 1024 * 1024, // 1 GB
	maxNetworkBytesOut: 50 * 1024 * 1024, // 50 MB
	maxExecutionMs: 60000, // 1 minute
	maxConcurrentExecs: 4,
};

/**
 * Strict quota - restrictive limits for untrusted tools
 */
export const STRICT_QUOTA: ResourceQuota = {
	maxMemoryBytes: 256 * 1024 * 1024, // 256 MB
	maxCpuPercent: 50, // half a core
	maxDiskBytes: 256 * 1024 * 1024, // 256 MB
	maxNetworkBytesOut: 10 * 1024 * 1024, // 10 MB
	maxExecutionMs: 30000, // 30 seconds
	maxConcurrentExecs: 2,
};

/**
 * Unlimited quota - no enforcement (for trusted environments)
 */
export const UNLIMITED_QUOTA: ResourceQuota = {
	maxMemoryBytes: Number.MAX_SAFE_INTEGER,
	maxCpuPercent: Number.MAX_SAFE_INTEGER,
	maxExecutionMs: Number.MAX_SAFE_INTEGER,
	maxConcurrentExecs: Number.MAX_SAFE_INTEGER,
};
