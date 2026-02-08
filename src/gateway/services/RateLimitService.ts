import { logger } from "@/packages/logger";

/**
 * Rate limit entry tracking requests within a time window
 */
interface RateLimitEntry {
	count: number;
	resetTime: number;
	windowStart: number;
}

/**
 * Rate limit check result
 */
export interface RateLimitResult {
	allowed: boolean;
	retryAfter?: number;
	reason?: string;
}

/**
 * Rate limiting configuration
 */
export interface RateLimitServiceConfig {
	workspaceLimit?: number; // Requests per minute per workspace (default: 100)
	ipLimit?: number; // Requests per minute per IP (default: 200)
	windowMs?: number; // Time window in milliseconds (default: 60000 = 1 minute)
	cleanupIntervalMs?: number; // Cleanup interval (default: 60000 = 1 minute)
	whitelistedIps?: string[]; // IPs to exempt from rate limiting
}

/**
 * RateLimitService - Enforces rate limits on callback requests
 *
 * Provides two-tier rate limiting:
 * 1. Per-workspace limit: Prevents one workspace from monopolizing system
 * 2. Per-IP limit: Prevents DDoS from single source
 *
 * Uses a sliding window algorithm for accurate rate limiting.
 */
export class RateLimitService {
	private workspaceLimits: Map<string, RateLimitEntry> = new Map();
	private ipLimits: Map<string, RateLimitEntry> = new Map();
	private readonly workspaceLimit: number;
	private readonly ipLimit: number;
	private readonly windowMs: number;
	private readonly cleanupIntervalMs: number;
	private readonly whitelistedIps: Set<string>;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: RateLimitServiceConfig = {}) {
		const {
			workspaceLimit = 100,
			ipLimit = 200,
			windowMs = 60000,
			cleanupIntervalMs = 60000,
			whitelistedIps = [],
		} = config;

		this.workspaceLimit = workspaceLimit;
		this.ipLimit = ipLimit;
		this.windowMs = windowMs;
		this.cleanupIntervalMs = cleanupIntervalMs;
		this.whitelistedIps = new Set(whitelistedIps);

		// Start periodic cleanup
		this.startCleanup();

		logger.info(
			{
				workspaceLimit,
				ipLimit,
				windowMs,
				cleanupIntervalMs,
				whitelistedIpsCount: whitelistedIps.length,
			},
			"RateLimitService initialized",
		);
	}

	/**
	 * Check if a request should be rate limited
	 *
	 * @param workspace - The workspace name
	 * @param ip - The client IP address
	 * @returns Rate limit check result
	 */
	checkLimit(workspace: string, ip: string): RateLimitResult {
		// Check IP whitelist first
		if (this.whitelistedIps.has(ip)) {
			logger.debug({ ip }, "IP is whitelisted, skipping rate limit check");
			return { allowed: true };
		}

		const now = Date.now();

		// Check workspace limit
		const wsLimit = this.getOrCreateLimit(this.workspaceLimits, workspace, now);
		if (wsLimit.count >= this.workspaceLimit) {
			const retryAfter = Math.ceil((wsLimit.resetTime - now) / 1000);

			logger.debug(
				{
					workspace,
					count: wsLimit.count,
					limit: this.workspaceLimit,
					retryAfter,
				},
				"Workspace rate limit exceeded",
			);

			return {
				allowed: false,
				retryAfter,
				reason: "workspace_limit_exceeded",
			};
		}

		// Check IP limit
		const ipLimitEntry = this.getOrCreateLimit(this.ipLimits, ip, now);
		if (ipLimitEntry.count >= this.ipLimit) {
			const retryAfter = Math.ceil((ipLimitEntry.resetTime - now) / 1000);

			logger.debug(
				{
					ip,
					count: ipLimitEntry.count,
					limit: this.ipLimit,
					retryAfter,
				},
				"IP rate limit exceeded",
			);

			return {
				allowed: false,
				retryAfter,
				reason: "ip_limit_exceeded",
			};
		}

		// Increment counters
		wsLimit.count++;
		ipLimitEntry.count++;

		logger.trace(
			{
				workspace,
				ip,
				workspaceCount: wsLimit.count,
				ipCount: ipLimitEntry.count,
			},
			"Rate limit counters incremented",
		);

		return { allowed: true };
	}

	/**
	 * Record a successful request (alternative to checkLimit if you already approved)
	 *
	 * @param workspace - The workspace name
	 * @param ip - The client IP address
	 */
	recordRequest(workspace: string, ip: string): void {
		if (this.whitelistedIps.has(ip)) {
			return;
		}

		const now = Date.now();
		const wsLimit = this.getOrCreateLimit(this.workspaceLimits, workspace, now);
		const ipLimitEntry = this.getOrCreateLimit(this.ipLimits, ip, now);

		wsLimit.count++;
		ipLimitEntry.count++;
	}

	/**
	 * Reset rate limits for a specific workspace or IP
	 *
	 * @param type - Either 'workspace' or 'ip'
	 * @param key - The workspace name or IP address
	 */
	resetLimit(type: "workspace" | "ip", key: string): void {
		const map = type === "workspace" ? this.workspaceLimits : this.ipLimits;
		const deleted = map.delete(key);

		if (deleted) {
			logger.info({ type, key }, "Rate limit reset");
		}
	}

	/**
	 * Get or create a rate limit entry
	 */
	private getOrCreateLimit(map: Map<string, RateLimitEntry>, key: string, now: number): RateLimitEntry {
		let entry = map.get(key);

		// Create new entry if doesn't exist or has expired
		if (!entry || now >= entry.resetTime) {
			entry = {
				count: 0,
				windowStart: now,
				resetTime: now + this.windowMs,
			};
			map.set(key, entry);
		}

		return entry;
	}

	/**
	 * Start periodic cleanup of expired entries
	 */
	private startCleanup(): void {
		this.cleanupTimer = setInterval(() => {
			this.cleanup();
		}, this.cleanupIntervalMs);
	}

	/**
	 * Stop periodic cleanup
	 */
	stopCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
			logger.info("RateLimitService cleanup stopped");
		}
	}

	/**
	 * Remove expired entries from the rate limit maps
	 */
	cleanup(): void {
		const now = Date.now();
		let workspaceCleaned = 0;
		let ipCleaned = 0;

		// Clean workspace limits
		for (const [key, entry] of this.workspaceLimits.entries()) {
			if (now >= entry.resetTime) {
				this.workspaceLimits.delete(key);
				workspaceCleaned++;
			}
		}

		// Clean IP limits
		for (const [key, entry] of this.ipLimits.entries()) {
			if (now >= entry.resetTime) {
				this.ipLimits.delete(key);
				ipCleaned++;
			}
		}

		if (workspaceCleaned > 0 || ipCleaned > 0) {
			logger.debug(
				{
					workspaceCleaned,
					ipCleaned,
					remainingWorkspaces: this.workspaceLimits.size,
					remainingIps: this.ipLimits.size,
				},
				"Rate limit cleanup completed",
			);
		}
	}

	/**
	 * Get service statistics
	 */
	getStats(): {
		workspaces: number;
		ips: number;
		workspaceLimit: number;
		ipLimit: number;
		windowMs: number;
	} {
		return {
			workspaces: this.workspaceLimits.size,
			ips: this.ipLimits.size,
			workspaceLimit: this.workspaceLimit,
			ipLimit: this.ipLimit,
			windowMs: this.windowMs,
		};
	}

	/**
	 * Get current usage for a workspace or IP
	 *
	 * @param type - Either 'workspace' or 'ip'
	 * @param key - The workspace name or IP address
	 * @returns Current count and reset time, or undefined if not tracked
	 */
	getUsage(type: "workspace" | "ip", key: string): { count: number; resetTime: number } | undefined {
		const map = type === "workspace" ? this.workspaceLimits : this.ipLimits;
		const entry = map.get(key);

		if (entry) {
			return {
				count: entry.count,
				resetTime: entry.resetTime,
			};
		}

		return undefined;
	}

	/**
	 * Add an IP to the whitelist
	 *
	 * @param ip - The IP address to whitelist
	 */
	whitelistIp(ip: string): void {
		this.whitelistedIps.add(ip);
		logger.info({ ip }, "IP added to whitelist");
	}

	/**
	 * Remove an IP from the whitelist
	 *
	 * @param ip - The IP address to unwhitelist
	 */
	unwhitelistIp(ip: string): void {
		const deleted = this.whitelistedIps.delete(ip);
		if (deleted) {
			logger.info({ ip }, "IP removed from whitelist");
		}
	}

	/**
	 * Clear all rate limit data (useful for testing)
	 */
	clear(): void {
		this.workspaceLimits.clear();
		this.ipLimits.clear();
		logger.info("RateLimitService data cleared");
	}
}
