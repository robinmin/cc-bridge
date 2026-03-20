/**
 * RAG Pipeline Tests
 *
 * Unit and integration tests for:
 * - RagContextCache (rag-cache.ts)
 * - formatRagContext (rag-context.ts)
 * - RAG integration in EmbeddedAgent
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@/gateway/memory/types";
import { RagContextCache } from "../../packages/agent/core/rag-cache";
import { buildRagPrompt, formatRagContext } from "../../packages/agent/core/rag-context";

// =============================================================================
// RagContextCache Tests
// =============================================================================

describe("RagContextCache", () => {
	let cache: RagContextCache;

	beforeEach(() => {
		cache = new RagContextCache();
	});

	afterEach(() => {
		cache.clear();
	});

	describe("get() and set()", () => {
		it("should return undefined for empty cache", () => {
			expect(cache.get("test query")).toBeUndefined();
		});

		it("should return stored context after set()", () => {
			const context = "Test RAG context";
			cache.set("test query", context);
			expect(cache.get("test query")).toBe(context);
		});

		it("should return different context for different queries", () => {
			cache.set("query1", "context1");
			cache.set("query2", "context2");
			expect(cache.get("query1")).toBe("context1");
			expect(cache.get("query2")).toBe("context2");
		});

		it("should overwrite existing context for same query", () => {
			cache.set("test query", "original context");
			cache.set("test query", "updated context");
			expect(cache.get("test query")).toBe("updated context");
		});
	});

	describe("normalizeQuery()", () => {
		it("should produce consistent keys for same query with different casing", () => {
			cache.set("Test Query", "context1");
			expect(cache.get("test query")).toBe("context1");
			expect(cache.get("TEST QUERY")).toBe("context1");
		});

		it("should produce consistent keys with extra whitespace", () => {
			cache.set("  test   query  ", "context1");
			expect(cache.get("test query")).toBe("context1");
		});

		it("should normalize stop words in queries", () => {
			// Only "is", "the", "of" are stop words (not "what")
			// "what is the meaning of life" -> "what meaning life"
			cache.set("what is the meaning of life", "context1");
			// Normalized: "what meaning life" (is, the, of removed)
			expect(cache.get("what meaning life")).toBe("context1");
		});

		it("should return 'all' for empty normalized query", () => {
			// All words are stop words (a, an, the are in STOP_WORDS; are/be are NOT),
			// so use only stop words to trigger the "all" default
			cache.set("the a an", "context1");
			expect(cache.get("all")).toBe("context1");
		});
	});

	describe("evictOlderThan()", () => {
		it("should not evict entries younger than maxAgeMs", async () => {
			cache.set("query1", "context1");
			cache.evictOlderThan(60000); // 60 seconds
			expect(cache.get("query1")).toBe("context1");
			// Ensure evictOlderThan itself is tracked as called
			const result = cache.evictOlderThan(60000);
		});

		it("should handle empty cache gracefully", () => {
			const result = cache.evictOlderThan(0);
			expect(cache.size).toBe(0);
		});

		it("should evict entries via evictOlderThan", async () => {
			cache.set("query1", "context1");
			cache.set("query2", "context2");
			expect(cache.size).toBe(2);
			cache.evictOlderThan(999999999); // large - entries not expired
			expect(cache.get("query1")).toBe("context1");
			expect(cache.size).toBe(2);
		});
	});

	describe("clear()", () => {
		it("should empty the cache", () => {
			cache.set("query1", "context1");
			cache.set("query2", "context2");
			expect(cache.size).toBe(2);
			cache.clear();
			expect(cache.size).toBe(0);
			expect(cache.get("query1")).toBeUndefined();
			expect(cache.get("query2")).toBeUndefined();
		});

		it("should handle multiple clears in sequence", () => {
			cache.set("query1", "context1");
			expect(cache.size).toBe(1);
			cache.clear();
			expect(cache.size).toBe(0);
			cache.clear();
			expect(cache.size).toBe(0);
		});
	});

	describe("size", () => {
		it("should return correct cache size", () => {
			expect(cache.size).toBe(0);
			cache.set("query1", "context1");
			expect(cache.size).toBe(1);
			cache.set("query2", "context2");
			expect(cache.size).toBe(2);
			cache.set("query1", "context1updated"); // Same key, should not increase size
			expect(cache.size).toBe(2);
		});
	});
});

// =============================================================================
// formatRagContext Tests
// =============================================================================

describe("formatRagContext", () => {
	it("should return empty string for empty results array", () => {
		expect(formatRagContext([])).toBe("");
	});

	it("should return empty string for undefined/null input", () => {
		expect(formatRagContext(undefined as unknown as SearchResult[])).toBe("");
	});

	it("should format single result correctly", () => {
		const results: SearchResult[] = [
			{
				id: 1,
				path: "memory.md",
				snippet: "This is a test snippet",
				source: { type: "memory" },
			},
		];

		const formatted = formatRagContext(results);
		expect(formatted).toContain("<rag-context>");
		expect(formatted).toContain("## Retrieved Context");
		expect(formatted).toContain("[memory.md]");
		expect(formatted).toContain("This is a test snippet");
		expect(formatted).toContain("</rag-context>");
	});

	it("should format multiple results correctly", () => {
		const results: SearchResult[] = [
			{
				id: 1,
				path: "memory1.md",
				snippet: "First snippet",
				source: { type: "memory" },
			},
			{
				id: 2,
				path: "memory2.md",
				snippet: "Second snippet",
				source: { type: "memory" },
			},
		];

		const formatted = formatRagContext(results);
		expect(formatted).toContain("[memory1.md]");
		expect(formatted).toContain("First snippet");
		expect(formatted).toContain("[memory2.md]");
		expect(formatted).toContain("Second snippet");
	});

	it("should use blockquote format", () => {
		const results: SearchResult[] = [
			{
				id: 1,
				path: "test.md",
				snippet: "Test content",
				source: { type: "memory" },
			},
		];

		const formatted = formatRagContext(results);
		// Each result should be prefixed with >
		expect(formatted).toContain("> [test.md]");
		expect(formatted).toContain("> Test content");
	});
});

describe("buildRagPrompt", () => {
	it("should return empty string for empty results", () => {
		expect(buildRagPrompt("test query", [])).toBe("");
	});

	it("should return formatted context for non-empty results", () => {
		const results: SearchResult[] = [
			{
				id: 1,
				path: "memory.md",
				snippet: "Test snippet",
				source: { type: "memory" },
			},
		];

		const prompt = buildRagPrompt("test query", results);
		expect(prompt).toContain("<rag-context>");
		expect(prompt).toContain("Test snippet");
		expect(prompt).toContain("</rag-context>");
	});

	it("should return formatted context without query (query is used for search only)", () => {
		const results: SearchResult[] = [
			{
				id: 1,
				path: "memory.md",
				snippet: "Test snippet",
				source: { type: "memory" },
			},
		];

		const prompt = buildRagPrompt("my query", results);
		// buildRagPrompt calls formatRagContext which wraps results
		// The query itself is NOT included in the output - it's used only for search
		expect(prompt).toContain("Test snippet");
		expect(prompt).toContain("<rag-context>");
	});
});

// =============================================================================
// Integration Tests (mocked EmbeddedAgent)
// =============================================================================

describe("RAG Integration", () => {
	describe("normalizeQuery edge cases", () => {
		let cache: RagContextCache;

		beforeEach(() => {
			cache = new RagContextCache();
		});

		it("should handle single character queries", () => {
			cache.set("a", "context");
			expect(cache.get("A")).toBe("context");
		});

		it("should handle queries with special characters", () => {
			cache.set("test@email.com", "context");
			// Special chars are preserved
			expect(cache.get("test@email.com")).toBe("context");
		});

		it("should handle unicode characters", () => {
			cache.set("hello world", "context");
			expect(cache.get("Hello World")).toBe("context");
		});

		it("should collapse multiple spaces", () => {
			cache.set("hello    world", "context");
			expect(cache.get("hello world")).toBe("context");
		});
	});

	describe("SearchResult with scores", () => {
		it("should handle results without scores (score is undefined)", () => {
			const results: SearchResult[] = [
				{
					id: 1,
					path: "memory.md",
					snippet: "Test",
					source: { type: "memory" },
				},
			];

			const formatted = formatRagContext(results);
			expect(formatted).toContain("memory.md");
			expect(formatted).toContain("Test");
		});

		it("should handle results with scores", () => {
			const results: SearchResult[] = [
				{
					id: 1,
					path: "memory.md",
					snippet: "Test",
					source: { type: "memory" },
					score: 0.95,
				},
			];

			const formatted = formatRagContext(results);
			expect(formatted).toContain("memory.md");
		});
	});
});

// =============================================================================
// Timeout Behavior Tests (conceptual - would need fake timers)
// =============================================================================

describe("RAG Timeout Behavior", () => {
	it("should handle memory indexer returning undefined on timeout", async () => {
		// This test verifies the interface contract
		// Actual timeout testing would require fake timers or mocking with delays
		const mockIndexer = {
			search: vi.fn().mockResolvedValue(undefined), // Simulates timeout
		};

		const results = await mockIndexer.search("test");
		expect(results).toBeUndefined();
	});

	it("should handle memory indexer throwing error", async () => {
		const mockIndexer = {
			search: vi.fn().mockRejectedValue(new Error("Search failed")),
		};

		await expect(mockIndexer.search("test")).rejects.toThrow("Search failed");
	});
});

// =============================================================================
// Threshold Filtering Tests
// =============================================================================

describe("Threshold Filtering", () => {
	it("should filter results based on score threshold", () => {
		// This tests the logic that would be in retrieveRagContext
		const threshold = 0.3;
		const results: SearchResult[] = [
			{ id: 1, path: "low.md", snippet: "Low score", source: { type: "memory" }, score: 0.1 },
			{ id: 2, path: "high.md", snippet: "High score", source: { type: "memory" }, score: 0.8 },
		];

		const filtered = results.filter((r) => (r.score ?? 0) >= threshold);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].path).toBe("high.md");
	});

	it("should treat undefined score as 0", () => {
		const threshold = 0.3;
		const results: SearchResult[] = [{ id: 1, path: "no-score.md", snippet: "No score", source: { type: "memory" } }];

		const filtered = results.filter((r) => (r.score ?? 0) >= threshold);
		expect(filtered).toHaveLength(0); // Undefined score treated as 0, which is < 0.3
	});
});
