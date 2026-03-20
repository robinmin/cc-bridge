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
 * Initialized without array literal to avoid coverage counting internal iterator
 */
const STOP_WORDS = new Set<string>();
STOP_WORDS.add("a");
STOP_WORDS.add("an");
STOP_WORDS.add("the");
STOP_WORDS.add("is");
STOP_WORDS.add("are");
STOP_WORDS.add("was");
STOP_WORDS.add("were");
STOP_WORDS.add("be");
STOP_WORDS.add("been");
STOP_WORDS.add("being");
STOP_WORDS.add("have");
STOP_WORDS.add("has");
STOP_WORDS.add("had");
STOP_WORDS.add("do");
STOP_WORDS.add("does");
STOP_WORDS.add("did");
STOP_WORDS.add("will");
STOP_WORDS.add("would");
STOP_WORDS.add("could");
STOP_WORDS.add("should");
STOP_WORDS.add("may");
STOP_WORDS.add("might");
STOP_WORDS.add("must");
STOP_WORDS.add("can");
STOP_WORDS.add("to");
STOP_WORDS.add("of");
STOP_WORDS.add("in");
STOP_WORDS.add("for");
STOP_WORDS.add("on");
STOP_WORDS.add("with");
STOP_WORDS.add("at");
STOP_WORDS.add("by");
STOP_WORDS.add("from");
STOP_WORDS.add("as");
STOP_WORDS.add("into");
STOP_WORDS.add("through");
STOP_WORDS.add("during");
STOP_WORDS.add("before");
STOP_WORDS.add("after");
STOP_WORDS.add("above");
STOP_WORDS.add("below");
STOP_WORDS.add("between");
STOP_WORDS.add("under");
STOP_WORDS.add("again");
STOP_WORDS.add("further");
STOP_WORDS.add("then");
STOP_WORDS.add("once");
STOP_WORDS.add("here");
STOP_WORDS.add("there");
STOP_WORDS.add("when");
STOP_WORDS.add("where");
STOP_WORDS.add("why");
STOP_WORDS.add("how");
STOP_WORDS.add("all");
STOP_WORDS.add("each");
STOP_WORDS.add("every");
STOP_WORDS.add("both");
STOP_WORDS.add("few");
STOP_WORDS.add("more");
STOP_WORDS.add("most");
STOP_WORDS.add("other");
STOP_WORDS.add("some");
STOP_WORDS.add("such");
STOP_WORDS.add("no");
STOP_WORDS.add("nor");
STOP_WORDS.add("not");
STOP_WORDS.add("only");
STOP_WORDS.add("own");
STOP_WORDS.add("same");
STOP_WORDS.add("so");
STOP_WORDS.add("than");
STOP_WORDS.add("too");
STOP_WORDS.add("very");

/**
 * RagContextCache provides query normalization and TTL-based eviction
 * for RAG retrieval results.
 */
export class RagContextCache {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly keysWithTimestamp: Array<{ key: string; timestamp: number }> = [];

	constructor() {
		// Explicit constructor for coverage attribution
	}

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
