// Rate limiting configuration
const DEFAULT_LIMIT = 10;
const DEFAULT_WINDOW_SECONDS = 60;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const _MAX_IDLE_TIME_MS = 10 * 60 * 1000; // 10 minutes

export class RateLimiter {
	private requests: Map<string | number, number[]> = new Map();
	private limit: number;
	private windowMs: number;
	private cleanupTimer: Timer | null = null;

	constructor(limit = DEFAULT_LIMIT, windowSeconds = DEFAULT_WINDOW_SECONDS) {
		this.limit = limit;
		this.windowMs = windowSeconds * 1000;
		this.startCleanup();
	}

	async isAllowed(id: string | number): Promise<boolean> {
		const now = Date.now();
		const timestamps = this.requests.get(id) || [];

		// Filter out old timestamps (outside the time window)
		const recent = timestamps.filter((ts) => now - ts < this.windowMs);

		if (recent.length >= this.limit) {
			return false;
		}

		recent.push(now);
		this.requests.set(id, recent);
		return true;
	}

	async getRetryAfter(id: string | number): Promise<number> {
		const now = Date.now();
		const timestamps = this.requests.get(id) || [];
		if (timestamps.length === 0) return 0;

		// Get the oldest timestamp that's still within the window
		const validTimestamps = timestamps.filter((ts) => now - ts < this.windowMs);
		if (validTimestamps.length === 0) return 0;

		const oldest = validTimestamps[0];
		return Math.ceil((this.windowMs - (now - oldest)) / 1000);
	}

	/**
	 * Periodic cleanup to remove stale entries and prevent unbounded memory growth
	 */
	private startCleanup() {
		// Clean up every 5 minutes
		this.cleanupTimer = setInterval(() => {
			this.cleanup();
		}, CLEANUP_INTERVAL_MS);
	}

	/**
	 * Remove idle entries and old timestamps to prevent memory leaks
	 */
	private cleanup() {
		const now = Date.now();
		let removedCount = 0;

		for (const [id, timestamps] of this.requests.entries()) {
			// Remove timestamps outside the window
			const validTimestamps = timestamps.filter(
				(ts) => now - ts < this.windowMs,
			);

			// If no recent timestamps or all are very old, remove the entire entry
			if (validTimestamps.length === 0) {
				this.requests.delete(id);
				removedCount++;
			} else if (validTimestamps.length < timestamps.length) {
				this.requests.set(id, validTimestamps);
			}
		}

		if (removedCount > 0) {
			// Debug log for cleanup activity
			console.debug(`RateLimiter: cleaned up ${removedCount} idle entries`);
		}
	}

	/**
	 * Stop the cleanup timer (useful for testing or shutdown)
	 */
	stop() {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	/**
	 * Reset all rate limit data (useful for testing)
	 */
	reset() {
		this.requests.clear();
	}

	/**
	 * Get current stats for monitoring
	 */
	getStats() {
		return {
			totalEntries: this.requests.size,
			totalRequests: Array.from(this.requests.values()).reduce(
				(sum, timestamps) => sum + timestamps.length,
				0,
			),
		};
	}
}

export const rateLimiter = new RateLimiter();
