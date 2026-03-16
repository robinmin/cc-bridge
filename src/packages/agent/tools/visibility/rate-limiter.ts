/**
 * Rate Limiter
 *
 * Per-tool rate limiting for API/resource protection.
 */

import { logger } from "@/packages/logger";

/**
 * Rate limit configuration for a tool
 */
export interface ToolRateLimit {
	/** Tool name */
	toolName: string;
	/** Maximum calls per window */
	maxCalls: number;
	/** Window duration in ms */
	windowMs: number;
	/** Burst allowance (additional calls allowed at once) */
	burst?: number;
}

/**
 * Result of a rate limit check
 */
export interface RateLimitResult {
	/** Whether the call is allowed */
	allowed: boolean;
	/** Remaining calls in current window */
	remaining: number;
	/** Timestamp when the window resets */
	resetAt: number;
	/** Retry after ms (if denied) */
	retryAfterMs?: number;
}

/**
 * Rate limit window state
 */
interface RateLimitWindow {
	count: number;
	startTime: number;
	resetAt: number;
}

/**
 * Rate limiter
 *
 * Implements per-tool rate limiting:
 * - Token bucket-style burst allowance
 * - Sliding window algorithm
 * - Configurable limits per tool
 */
export class RateLimiter {
	private limits: Map<string, ToolRateLimit> = new Map();
	private windows: Map<string, RateLimitWindow> = new Map();
	private defaultWindowMs: number;
	private defaultMaxCalls: number;

	constructor(defaultWindowMs: number = 60000, defaultMaxCalls: number = 100) {
		this.defaultWindowMs = defaultWindowMs;
		this.defaultMaxCalls = defaultMaxCalls;
	}

	/**
	 * Set a rate limit for a tool
	 */
	setLimit(limit: ToolRateLimit): void {
		this.limits.set(limit.toolName, limit);

		// Reset existing window if any
		this.windows.delete(limit.toolName);

		logger.debug(
			{ toolName: limit.toolName, maxCalls: limit.maxCalls, windowMs: limit.windowMs },
			"Rate limit set for tool",
		);
	}

	/**
	 * Set limits for multiple tools
	 */
	setLimits(limits: ToolRateLimit[]): void {
		for (const limit of limits) {
			this.setLimit(limit);
		}
	}

	/**
	 * Get the rate limit for a tool
	 */
	getLimit(toolName: string): ToolRateLimit | undefined {
		return this.limits.get(toolName);
	}

	/**
	 * Remove rate limit for a tool
	 */
	removeLimit(toolName: string): void {
		this.limits.delete(toolName);
		this.windows.delete(toolName);
	}

	/**
	 * Check if a call is allowed (without recording it)
	 */
	checkLimit(toolName: string): RateLimitResult {
		const limit = this.limits.get(toolName);

		// No limit configured - allow all
		if (!limit) {
			return {
				allowed: true,
				remaining: Infinity,
				resetAt: Date.now() + this.defaultWindowMs,
			};
		}

		const window = this.getOrCreateWindow(toolName, limit);
		const now = Date.now();

		// Check if window has expired
		if (now >= window.resetAt) {
			// Reset window
			window.count = 0;
			window.startTime = now;
			window.resetAt = now + limit.windowMs;
		}

		const burst = limit.burst ?? 0;
		const maxAllowed = limit.maxCalls + burst;
		const remaining = Math.max(0, maxAllowed - window.count);

		if (window.count < maxAllowed) {
			return {
				allowed: true,
				remaining,
				resetAt: window.resetAt,
			};
		}

		// Rate limited
		const retryAfterMs = window.resetAt - now;
		return {
			allowed: false,
			remaining: 0,
			resetAt: window.resetAt,
			retryAfterMs,
		};
	}

	/**
	 * Record a call (check and record in one operation)
	 */
	recordCall(toolName: string): RateLimitResult {
		const limit = this.limits.get(toolName);

		// No limit configured - allow all
		if (!limit) {
			return {
				allowed: true,
				remaining: Infinity,
				resetAt: Date.now() + this.defaultWindowMs,
			};
		}

		const window = this.getOrCreateWindow(toolName, limit);
		const now = Date.now();

		// Check if window has expired
		if (now >= window.resetAt) {
			// Reset window
			window.count = 0;
			window.startTime = now;
			window.resetAt = now + limit.windowMs;
		}

		const burst = limit.burst ?? 0;
		const maxAllowed = limit.maxCalls + burst;

		// Check if we can make the call
		if (window.count < maxAllowed) {
			// Increment first, then calculate remaining
			window.count++;
			const remaining = Math.max(0, maxAllowed - window.count);
			return {
				allowed: true,
				remaining,
				resetAt: window.resetAt,
			};
		}

		// Rate limited
		const retryAfterMs = window.resetAt - now;
		return {
			allowed: false,
			remaining: 0,
			resetAt: window.resetAt,
			retryAfterMs,
		};
	}

	/**
	 * Get remaining calls for a tool
	 */
	getRemaining(toolName: string): number {
		const result = this.checkLimit(toolName);
		return result.remaining;
	}

	/**
	 * Get time until rate limit resets
	 */
	getResetTime(toolName: string): number {
		const window = this.windows.get(toolName);
		if (!window) return 0;

		return Math.max(0, window.resetAt - Date.now());
	}

	/**
	 * Get or create a rate limit window
	 */
	private getOrCreateWindow(toolName: string, limit: ToolRateLimit): RateLimitWindow {
		let window = this.windows.get(toolName);
		const now = Date.now();

		if (!window || now >= window.resetAt) {
			window = {
				count: 0,
				startTime: now,
				resetAt: now + limit.windowMs,
			};
			this.windows.set(toolName, window);
		}

		return window;
	}

	/**
	 * Clear all rate limit windows (for testing)
	 */
	clearWindows(): void {
		this.windows.clear();
	}

	/**
	 * Get all configured limits
	 */
	getAllLimits(): ToolRateLimit[] {
		return [...this.limits.values()];
	}

	/**
	 * Get current usage for all tools
	 */
	getCurrentUsage(): Record<string, { count: number; limit: number; resetAt: number }> {
		const usage: Record<string, { count: number; limit: number; resetAt: number }> = {};
		const now = Date.now();

		for (const [toolName, window] of this.windows) {
			const limit = this.limits.get(toolName);
			const effectiveLimit = limit?.maxCalls ?? this.defaultMaxCalls;

			// Check if window expired
			let count = window.count;
			let resetAt = window.resetAt;

			if (now >= window.resetAt && limit) {
				count = 0;
				resetAt = now + limit.windowMs;
			}

			usage[toolName] = {
				count,
				limit: effectiveLimit,
				resetAt,
			};
		}

		return usage;
	}
}
