import { beforeEach, describe, expect, test } from "bun:test";
import { RagContextCache } from "../agent/core/rag-cache";

describe("rag-cache", () => {
	let cache: RagContextCache;

	beforeEach(() => {
		cache = new RagContextCache();
	});

	// =============================================================================
	// get()
	// =============================================================================

	describe("get()", () => {
		test("returns undefined for non-existent query", () => {
			expect(cache.get("nonexistent")).toBeUndefined();
		});

		test("returns cached context for existing query", () => {
			cache.set("test query", "cached context");
			expect(cache.get("test query")).toBe("cached context");
		});

		test("returns cached context for normalized query", () => {
			cache.set("Test Query", "cached context");
			expect(cache.get("test query")).toBe("cached context");
			expect(cache.get("TEST QUERY")).toBe("cached context");
		});

		test("returns cached context with extra whitespace", () => {
			cache.set("test query", "cached context");
			expect(cache.get("  test   query  ")).toBe("cached context");
		});

		test("returns cached context removing stop words", () => {
			cache.set("the test query", "cached context");
			expect(cache.get("test query")).toBe("cached context");
		});

		test("returns cached context for query with only stop words", () => {
			cache.set("the a an", "cached context");
			// Both normalize to "all" since all words are stop words
			expect(cache.get("the a an")).toBe("cached context");
			expect(cache.get("is was are")).toBe("cached context");
		});

		test("updates timestamp on set with existing key", () => {
			cache.set("test", "first");
			cache.set("test", "second");
			expect(cache.get("test")).toBe("second");
		});
	});

	// =============================================================================
	// set()
	// =============================================================================

	describe("set()", () => {
		test("stores context for query", () => {
			cache.set("query", "context");
			expect(cache.get("query")).toBe("context");
		});

		test("normalizes query before storing", () => {
			cache.set("  TEST QUERY  ", "context");
			expect(cache.get("test query")).toBe("context");
		});

		test("updates existing entry", () => {
			cache.set("query", "first");
			cache.set("query", "second");
			expect(cache.get("query")).toBe("second");
		});

		test("increments size", () => {
			expect(cache.size).toBe(0);
			cache.set("query1", "context1");
			expect(cache.size).toBe(1);
			cache.set("query2", "context2");
			expect(cache.size).toBe(2);
		});

		test("does not increment size on update", () => {
			cache.set("query", "first");
			expect(cache.size).toBe(1);
			cache.set("query", "second");
			expect(cache.size).toBe(1);
		});

		test("handles empty string query", () => {
			cache.set("", "context");
			expect(cache.size).toBe(1);
		});

		test("handles query with only stop words", () => {
			cache.set("the a an", "context");
			expect(cache.size).toBe(1);
			// Gets normalized to "all"
			expect(cache.get("the a an")).toBe("context");
		});
	});

	// =============================================================================
	// evictOlderThan()
	// =============================================================================

	describe("evictOlderThan()", () => {
		test("does nothing when cache is empty", () => {
			cache.evictOlderThan(60000);
			expect(cache.size).toBe(0);
		});

		test("does nothing when no entries are expired", () => {
			cache.set("query1", "context1");
			cache.set("query2", "context2");
			cache.evictOlderThan(60000); // 60 seconds
			expect(cache.size).toBe(2);
		});

		test("with maxAge=0, entries just added are not evicted", () => {
			cache.set("query", "context");
			// maxAge=0 means evict entries older than 0ms
			// entries with timestamp = now are not older than now
			cache.evictOlderThan(0);
			expect(cache.size).toBe(1);
		});

		test("with negative maxAge, entries are evicted", () => {
			cache.set("query", "context");
			// negative maxAge means cutoff is in the future
			// entries with timestamp <= now will be < cutoff and evicted
			cache.evictOlderThan(-1);
			expect(cache.size).toBe(0);
		});

		test("evicts multiple entries and logs", () => {
			cache.set("q1", "c1");
			cache.set("q2", "c2");
			cache.set("q3", "c3");
			// With negative maxAge, all should be evicted
			cache.evictOlderThan(-1);
			expect(cache.size).toBe(0);
		});

		test("handles large maxAgeMs", () => {
			cache.set("query", "context");
			cache.evictOlderThan(Number.MAX_SAFE_INTEGER);
			expect(cache.size).toBe(1);
		});
	});

	// =============================================================================
	// clear()
	// =============================================================================

	describe("clear()", () => {
		test("clears all entries", () => {
			cache.set("query1", "context1");
			cache.set("query2", "context2");
			expect(cache.size).toBe(2);
			cache.clear();
			expect(cache.size).toBe(0);
		});

		test("clears empty cache without error", () => {
			cache.clear();
			expect(cache.size).toBe(0);
		});

		test("allows new entries after clear", () => {
			cache.set("query", "context");
			cache.clear();
			cache.set("new query", "new context");
			expect(cache.get("new query")).toBe("new context");
		});
	});

	// =============================================================================
	// normalizeQuery()
	// =============================================================================

	describe("normalizeQuery()", () => {
		test("lowercases query", () => {
			const result = cache.normalizeQuery("HELLO WORLD");
			expect(result).toBe("hello world");
		});

		test("trims whitespace", () => {
			const result = cache.normalizeQuery("  hello world  ");
			expect(result).toBe("hello world");
		});

		test("collapses multiple spaces", () => {
			const result = cache.normalizeQuery("hello    world");
			expect(result).toBe("hello world");
		});

		test("collapses multiple whitespace characters", () => {
			const result = cache.normalizeQuery("hello\n\tworld");
			expect(result).toBe("hello world");
		});

		test("removes stop words", () => {
			const result = cache.normalizeQuery("the hello world is great");
			expect(result).toBe("hello world great");
		});

		test("removes multiple consecutive stop words", () => {
			const result = cache.normalizeQuery("the the the");
			expect(result).toBe("all"); // Empty after stop word removal
		});

		test("returns 'all' for empty string", () => {
			const result = cache.normalizeQuery("");
			expect(result).toBe("all");
		});

		test("returns 'all' for whitespace only", () => {
			const result = cache.normalizeQuery("   ");
			expect(result).toBe("all");
		});

		test("returns 'all' for stop words only", () => {
			const result = cache.normalizeQuery("the a an is are was were");
			expect(result).toBe("all");
		});

		test("handles single character words", () => {
			// "a" is a stop word, but "b" and "c" are not
			const result = cache.normalizeQuery("a b c");
			expect(result).toBe("b c");
		});

		test("handles mixed case stop words", () => {
			const result = cache.normalizeQuery("THE Hello THE World THE");
			expect(result).toBe("hello world");
		});

		test("preserves non-stop words", () => {
			const result = cache.normalizeQuery("typescript developer");
			expect(result).toBe("typescript developer");
		});

		test("handles unicode characters", () => {
			const result = cache.normalizeQuery("héllo wörld");
			expect(result).toBe("héllo wörld");
		});

		test("handles numbers in query", () => {
			const result = cache.normalizeQuery("version 1.0.0");
			expect(result).toBe("version 1.0.0");
		});
	});

	// =============================================================================
	// size property
	// =============================================================================

	describe("size", () => {
		test("returns 0 for empty cache", () => {
			expect(cache.size).toBe(0);
		});

		test("returns correct count after sets", () => {
			cache.set("q1", "c1");
			cache.set("q2", "c2");
			cache.set("q3", "c3");
			expect(cache.size).toBe(3);
		});

		test("returns correct count after updates", () => {
			cache.set("q1", "c1");
			cache.set("q2", "c2");
			cache.set("q1", "c1-updated");
			expect(cache.size).toBe(2);
		});

		test("returns correct count after clear", () => {
			cache.set("q1", "c1");
			cache.set("q2", "c2");
			cache.clear();
			expect(cache.size).toBe(0);
		});

		test("returns correct count after eviction", () => {
			cache.set("q1", "c1");
			cache.set("q2", "c2");
			// With maxAge=0, entries just added are not evicted
			cache.evictOlderThan(0);
			expect(cache.size).toBe(2);
			// With negative maxAge, entries are evicted
			cache.evictOlderThan(-1);
			expect(cache.size).toBe(0);
		});
	});

	// =============================================================================
	// Edge cases
	// =============================================================================

	describe("edge cases", () => {
		test("handles very long query", () => {
			const longQuery = "a".repeat(10000);
			cache.set(longQuery, "context");
			expect(cache.get(longQuery)).toBe("context");
		});

		test("handles query with special characters", () => {
			cache.set("hello @#$%^&*() world", "context");
			expect(cache.get("hello @#$%^&*() world")).toBe("context");
		});

		test("handles query with newlines", () => {
			cache.set("hello\nworld", "context");
			expect(cache.get("hello\nworld")).toBe("context");
		});

		test("handles query with tabs", () => {
			cache.set("hello\tworld", "context");
			expect(cache.get("hello\tworld")).toBe("context");
		});

		test("multiple set and get operations", () => {
			cache.set("q1", "c1");
			cache.set("q2", "c2");
			cache.set("q3", "c3");
			expect(cache.get("q1")).toBe("c1");
			expect(cache.get("q2")).toBe("c2");
			expect(cache.get("q3")).toBe("c3");
			cache.set("q1", "c1-updated");
			expect(cache.get("q1")).toBe("c1-updated");
			expect(cache.get("q2")).toBe("c2");
			expect(cache.get("q3")).toBe("c3");
		});

		test("case insensitivity across operations", () => {
			cache.set("JavaScript", "context1");
			expect(cache.get("javascript")).toBe("context1");
			expect(cache.get("JAVASCRIPT")).toBe("context1");
			expect(cache.get("JaVaScRiPt")).toBe("context1");
		});

		test("whitespace normalization across operations", () => {
			cache.set("hello    world", "context1");
			expect(cache.get("hello world")).toBe("context1");
			expect(cache.get("  hello   world  ")).toBe("context1");
			expect(cache.get("\nhello\t\tworld\n")).toBe("context1");
		});

		test("stop word removal across operations", () => {
			cache.set("the quick brown fox", "context1");
			// "the quick brown fox" normalizes to "quick brown fox" (the is removed)
			expect(cache.get("quick brown fox")).toBe("context1");
			// These have different stop words removed so they don't match
			expect(cache.get("quick fox")).toBeUndefined();
		});
	});
});
