/**
 * Web Search Tool
 *
 * AgentTool that searches the web using DuckDuckGo's HTML endpoint.
 * Returns search results as text for the agent to use.
 *
 * Uses the DuckDuckGo HTML search page, which is free and requires
 * no API key. Results are parsed from the HTML response.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";

const SEARCH_TIMEOUT_MS = 15_000; // 15 seconds
const MAX_RESULTS = 8;

const parameters = Type.Object({
	query: Type.String({ description: "Search query string" }),
});

type WebSearchParams = Static<typeof parameters>;

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/**
 * Parse search results from DuckDuckGo HTML response.
 * Extracts title, URL, and snippet from each result.
 */
function parseDuckDuckGoHtml(html: string): SearchResult[] {
	const results: SearchResult[] = [];

	// DuckDuckGo HTML results are in <div class="result"> blocks
	// Each contains an <a class="result__a"> with title/URL and
	// a <a class="result__snippet"> with the snippet text

	// Match result links: <a rel="nofollow" ... class="result__a" href="...">title</a>
	const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
	const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

	const links: { url: string; title: string }[] = [];
	let linkMatch = linkRegex.exec(html);
	while (linkMatch !== null) {
		const rawUrl = linkMatch[1];
		const title = stripHtmlTags(linkMatch[2]).trim();

		// DuckDuckGo wraps URLs in a redirect; extract the actual URL
		let url = rawUrl;
		const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
		if (uddgMatch) {
			url = decodeURIComponent(uddgMatch[1]);
		}

		if (title && url) {
			links.push({ url, title });
		}
		linkMatch = linkRegex.exec(html);
	}

	const snippets: string[] = [];
	let snippetMatch = snippetRegex.exec(html);
	while (snippetMatch !== null) {
		snippets.push(stripHtmlTags(snippetMatch[1]).trim());
		snippetMatch = snippetRegex.exec(html);
	}

	for (let i = 0; i < links.length && i < MAX_RESULTS; i++) {
		results.push({
			title: links[i].title,
			url: links[i].url,
			snippet: snippets[i] || "",
		});
	}

	return results;
}

/**
 * Strip HTML tags from a string.
 */
function stripHtmlTags(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ");
}

/**
 * Format search results as readable text for the agent.
 */
function formatResults(results: SearchResult[], query: string): string {
	if (results.length === 0) {
		return `No search results found for: "${query}"`;
	}

	const lines = [`Search results for: "${query}"\n`];

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		lines.push(`${i + 1}. ${r.title}`);
		lines.push(`   ${r.url}`);
		if (r.snippet) {
			lines.push(`   ${r.snippet}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Create a web-search AgentTool.
 * The workspace directory is accepted for API consistency but not used.
 */
export function createWebSearchTool(_workspaceDir: string): AgentTool<typeof parameters> {
	return {
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for information. " +
			"Returns a list of search results with titles, URLs, and snippets. " +
			"Useful for finding current information, documentation, or answering factual questions.",
		parameters,
		execute: async (
			_toolCallId: string,
			params: WebSearchParams,
			signal?: AbortSignal,
		): Promise<AgentToolResult<undefined>> => {
			if (signal?.aborted) {
				throw new Error("Web search operation was aborted");
			}

			try {
				const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`;

				// CRITICAL-2 fix: Always enforce timeout, even when caller provides a signal.
				// Combine both signals so timeout applies regardless of caller signal.
				const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
				const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

				const response = await fetch(url, {
					method: "GET",
					headers: {
						"User-Agent": "Mozilla/5.0 (compatible; CCBridge/1.0)",
					},
					signal: effectiveSignal,
				});

				if (!response.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Web search failed with status ${response.status}: ${response.statusText}`,
							},
						],
						details: undefined,
					};
				}

				const html = await response.text();
				const results = parseDuckDuckGoHtml(html);
				const formatted = formatResults(results, params.query);

				return {
					content: [{ type: "text", text: formatted }],
					details: undefined,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);

				// Don't wrap abort errors
				if (error instanceof Error && error.name === "AbortError") {
					throw error;
				}

				return {
					content: [
						{
							type: "text",
							text: `Web search failed: ${message}`,
						},
					],
					details: undefined,
				};
			}
		},
	};
}
