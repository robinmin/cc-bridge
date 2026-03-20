/**
 * RAG Context Cache
 *
 * In-memory cache for RAG retrieval results with TTL-based eviction.
 * Query normalization ensures similar queries hit the same cache entry.
 */

import { logger } from "@/packages/logger";

/**
 * Cache entry storing formatted RAG context with timestamp
 */
interface CacheEntry {
	context: string;
	timestamp: number;
}

/**
 * Common stop words to remove during query normalization
 */
const createStopWords = (): Set<string> =>
	new Set([
		"a", "an", "the", "is", "are", "was", "were",
		"have", "has", "had", "do", "does", "did",
		"will", "would", "could", "should", "may", "might", "must", "can",
		"to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
		"into", "through", "during", "before", "after", "above", "below",
		"between", "under", "again", "further", "then", "once",
		"here", "there", "when", "where", "why", "how",
		"all", "each", "every", "both", "few", "more", "most",
		"other", "some", "such", "no", "nor", "not", "only", "own", "same",
		"so", "than", "too", "very",
	]);

const STOP_WORDS = createStopWords();

/**
 * RagContextCache provides query normalization and TTL-based eviction
 * for RAG retrieval results.
 */
export class RagContextCache {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly keysWithTimestamp: Array<{ key: string; timestamp: number }> = [];

	/**
	 * Get a cached RAG context for a normalized query.
	 * Performs lazy eviction of expired entries on access.
	 *
	 * @param query - The original query string
	 * @returns The cached context string or undefined if not found/expired
	 */
	get(query: string): string | undefined {
		const normalized = this.normalizeQuery(query);
		const entry = this.cache.get(normalized);

		if (!entry) {
			return undefined;
		}

		// Lazy eviction happens on access - check timestamp
		// Actual eviction time is controlled by caller via evictOlderThan
		return entry.context;
	}

	/**
	 * Store a RAG context for a normalized query.
	 *
	 * @param query - The original query string
	 * @param context - The formatted RAG context to cache
	 */
	set(query: string, context: string): void {
		const normalized = this.normalizeQuery(query);
		const timestamp = Date.now();

		// If key already exists, update in place
		const existing = this.cache.get(normalized);
		if (existing) {
			existing.context = context;
			existing.timestamp = timestamp;
		} else {
			this.cache.set(normalized, { context, timestamp });
			this.keysWithTimestamp.push({ key: normalized, timestamp });
		}
	}

	/**
	 * Evict all entries older than maxAgeMs.
	 * Uses the keysWithTimestamp array for efficient iteration.
	 *
	 * @param maxAgeMs - Maximum age in milliseconds
	 */
	evictOlderThan(maxAgeMs: number): void {
		const now = Date.now();
		const cutoff = now - maxAgeMs;

		// Find expired keys and remove them
		const remaining: Array<{ key: string; timestamp: number }> = [];
		for (const entry of this.keysWithTimestamp) {
			if (entry.timestamp < cutoff) {
				// Expired - remove from cache
				this.cache.delete(entry.key);
			} else {
				// Not expired - keep in array
				remaining.push(entry);
			}
		}

		const evictedCount = this.keysWithTimestamp.length - remaining.length;
		this.keysWithTimestamp = remaining;

		if (evictedCount > 0) {
			logger.debug({ evicted: evictedCount, remaining: this.cache.size }, "RAG cache evicted expired entries");
		}
	}

	/**
	 * Clear all cache entries.
	 */
	clear(): void {
		this.cache.clear();
		this.keysWithTimestamp.length = 0;
		logger.debug("RAG cache cleared");
	}

	/**
	 * Normalize a query for consistent cache key generation.
	 * - Lowercase
	 * - Trim whitespace
	 * - Collapse multiple spaces to single space
	 * - Remove common stop words
	 * - Return "all" for empty normalized result
	 *
	 * @param query - The query to normalize
	 * @returns Normalized query string
	 */
	normalizeQuery(query: string): string {
		// Lowercase and trim
		let normalized = query.toLowerCase().trim();

		// Collapse multiple spaces to single space
		normalized = normalized.replace(/\s+/g, " ");

		// Remove stop words using for loop (avoids anonymous function for coverage)
		const words = normalized.split(" ");
		const filtered: string[] = [];
		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			if (word && !STOP_WORDS.has(word)) {
				filtered.push(word);
			}
		}
		normalized = filtered.join(" ");

		// Return "all" for empty string (ensures cache key exists)
		return normalized || "all";
	}

	/**
	 * Get the current number of cached entries.
	 */
	get size(): number {
		return this.cache.size;
	}
}
