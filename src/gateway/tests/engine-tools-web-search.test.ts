import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Store original fetch
const originalFetch = globalThis.fetch;

describe("tools/web-search", () => {
	beforeEach(() => {
		// Reset fetch to undefined initially for abort test
		globalThis.fetch = undefined as typeof globalThis.fetch;
	});

	afterEach(() => {
		// Restore original fetch
		globalThis.fetch = originalFetch;
	});

	describe("agent package tool metadata", () => {
		test("agent package tool has correct metadata", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");
			const tool = createWebSearchTool("/tmp/test");
			expect(tool.name).toBe("web_search");
			expect(tool.label).toBe("Web Search");
			expect(tool.description).toContain("Search the web");
			expect(tool.parameters).toBeDefined();
		});
	});

	describe("abort signal", () => {
		test("handles pre-aborted signal", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");
			const tool = createWebSearchTool("/tmp/test");
			const controller = new AbortController();
			controller.abort();
			await expect(tool.execute("call-1", { query: "test" }, controller.signal)).rejects.toThrow("aborted");
		});
	});

	describe("successful search", () => {
		test("parses search results from HTML", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			const htmlContent = `
				<div class="result">
					<a rel="nofollow" class="result__a" href="https://example.com/page1">Example Page 1</a>
					<a class="result__snippet">This is snippet 1 for the result.</a>
				</div>
				<div class="result">
					<a rel="nofollow" class="result__a" href="https://example.com/page2">Example Page 2</a>
					<a class="result__snippet">This is snippet 2 for the result.</a>
				</div>
			`;

			globalThis.fetch = mock(() => Promise.resolve(new Response(htmlContent, { status: 200 })));

			const tool = createWebSearchTool("/tmp/test");
			const result = await tool.execute("call-1", { query: "test query" });

			expect(result.content[0]).toHaveProperty("type", "text");
			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("Example Page 1");
			expect(text).toContain("Example Page 2");
			expect(text).toContain("test query");
		});

		test("handles DuckDuckGo URL redirect (uddg parameter)", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			const htmlContent = `
				<div class="result">
					<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Factual">Redirected Page</a>
					<a class="result__snippet">Snippet here</a>
				</div>
			`;

			globalThis.fetch = mock(() => Promise.resolve(new Response(htmlContent, { status: 200 })));

			const tool = createWebSearchTool("/tmp/test");
			const result = await tool.execute("call-1", { query: "test" });

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("https://example.com/actual");
		});

		test("strips HTML tags from titles and snippets", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			const htmlContent = `
				<div class="result">
					<a rel="nofollow" class="result__a" href="https://example.com">Title with <b>bold</b> text</a>
					<a class="result__snippet">Snippet with <i>italic</i></a>
				</div>
			`;

			globalThis.fetch = mock(() => Promise.resolve(new Response(htmlContent, { status: 200 })));

			const tool = createWebSearchTool("/tmp/test");
			const result = await tool.execute("call-1", { query: "test" });

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("Title with bold text");
			expect(text).toContain("Snippet with italic");
		});

		test("decodes HTML entities", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			const htmlContent = `
				<div class="result">
					<a rel="nofollow" class="result__a" href="https://example.com">Title &amp; More</a>
					<a class="result__snippet">Text &lt;tag&gt;</a>
				</div>
			`;

			globalThis.fetch = mock(() => Promise.resolve(new Response(htmlContent, { status: 200 })));

			const tool = createWebSearchTool("/tmp/test");
			const result = await tool.execute("call-1", { query: "test" });

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("Title & More");
			expect(text).toContain("Text <tag>");
		});

		test("handles no results", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			globalThis.fetch = mock(() => Promise.resolve(new Response("<html></html>", { status: 200 })));

			const tool = createWebSearchTool("/tmp/test");
			const result = await tool.execute("call-1", { query: "nonexistentquery12345" });

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("No search results found");
		});

		test("handles results without snippets", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			const htmlContent = `
				<div class="result">
					<a rel="nofollow" class="result__a" href="https://example.com">Result Title</a>
				</div>
			`;

			globalThis.fetch = mock(() => Promise.resolve(new Response(htmlContent, { status: 200 })));

			const tool = createWebSearchTool("/tmp/test");
			const result = await tool.execute("call-1", { query: "test" });

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("Result Title");
		});

		test("caps results at MAX_RESULTS (8)", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			let htmlContent = "";
			for (let i = 1; i <= 15; i++) {
				htmlContent += `
					<div class="result">
						<a rel="nofollow" class="result__a" href="https://example.com/page${i}">Result ${i}</a>
						<a class="result__snippet">Snippet ${i}</a>
					</div>
				`;
			}

			globalThis.fetch = mock(() => Promise.resolve(new Response(htmlContent, { status: 200 })));

			const tool = createWebSearchTool("/tmp/test");
			const result = await tool.execute("call-1", { query: "test" });

			const text = (result.content[0] as { text: string }).text;
			// Should contain only 8 results
			expect(text).toContain("Result 1");
			expect(text).toContain("Result 8");
			expect(text).not.toContain("Result 9");
		});
	});

	describe("HTTP error handling", () => {
		test("handles non-ok HTTP 500 response", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			globalThis.fetch = mock(() => Promise.resolve(new Response("Server Error", { status: 500 })));

			const tool = createWebSearchTool("/tmp/test");
			const result = await tool.execute("call-1", { query: "test" });

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("500");
		});

		test("handles non-ok HTTP 403 response", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			globalThis.fetch = mock(() => Promise.resolve(new Response("Forbidden", { status: 403 })));

			const tool = createWebSearchTool("/tmp/test");
			const result = await tool.execute("call-1", { query: "test" });

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("403");
		});
	});

	describe("fetch error handling", () => {
		test("handles network failure", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			globalThis.fetch = mock(() => Promise.reject(new TypeError("Network error")));

			const tool = createWebSearchTool("/tmp/test");
			const result = await tool.execute("call-1", { query: "test" });

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("Network error");
		});

		test("handles non-Error rejection", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			globalThis.fetch = mock(() => Promise.reject("string error"));

			const tool = createWebSearchTool("/tmp/test");
			const result = await tool.execute("call-1", { query: "test" });

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("string error");
		});
	});

	describe("abort during fetch", () => {
		test("re-throws AbortError without wrapping", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			// Create a never-resolving fetch
			const controller = new AbortController();
			globalThis.fetch = mock(
				() =>
					new Promise((_, reject) => {
						setTimeout(() => reject(new DOMException("Aborted", "AbortError")), 10);
					}),
			);

			const tool = createWebSearchTool("/tmp/test");
			const execPromise = tool.execute("call-1", { query: "test" }, controller.signal);

			// Abort immediately
			controller.abort();

			await expect(execPromise).rejects.toThrow("Aborted");
		});
	});

	describe("fetch configuration", () => {
		test("sends correct URL and headers", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			let capturedUrl = "";
			let capturedHeaders: Record<string, string> = {};

			globalThis.fetch = mock((url: string, options: RequestInit | undefined) => {
				capturedUrl = url;
				capturedHeaders = options?.headers || {};
				return Promise.resolve(new Response("<html></html>", { status: 200 }));
			});

			const tool = createWebSearchTool("/tmp/test");
			await tool.execute("call-1", { query: "hello world" });

			expect(capturedUrl).toContain("duckduckgo.com");
			expect(capturedUrl).toContain("hello%20world");
			expect(capturedHeaders["User-Agent"]).toBeDefined();
		});
	});

	describe("details field", () => {
		test("details is always undefined", async () => {
			const { createWebSearchTool } = await import("@/packages/agent/tools/web-search");

			globalThis.fetch = mock(() => Promise.resolve(new Response("<html></html>", { status: 200 })));

			const tool = createWebSearchTool("/tmp/test");
			const result = await tool.execute("call-1", { query: "test" });

			expect(result.details).toBeUndefined();
		});
	});
});
