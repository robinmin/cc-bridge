/**
 * RAG Context Formatter
 *
 * Formats search results into a structured RAG context string
 * for injection into the agent's system prompt.
 */

import type { SearchResult } from "@/gateway/memory/types";

/**
 * Format search results into a structured RAG context string.
 *
 * Output format:
 * ```
 * <rag-context>
 * ## Retrieved Context
 *
 * > [path/to/memory.md]
 * > Snippet text here...
 *
 * > [path/to/daily/2026-03-18.md]
 * > Another snippet...
 * </rag-context>
 * ```
 *
 * @param results - Array of search results to format
 * @returns Formatted RAG context string, or empty string if no results
 */
export function formatRagContext(results: SearchResult[]): string {
	if (!results || results.length === 0) {
		return "";
	}

	const blocks = results.map((result) => `> [${result.path}]\n> ${result.snippet}`);

	return `<rag-context>
## Retrieved Context

${blocks.join("\n\n")}
</rag-context>`;
}

/**
 * Build a RAG prompt by formatting search results into context.
 *
 * @param _query - Reserved for future use (e.g., query-aware formatting)
 * @param results - Array of search results
 * @returns Formatted RAG context string, or empty string if no results
 */
export function buildRagPrompt(_query: string, results: SearchResult[]): string {
	return formatRagContext(results);
}
