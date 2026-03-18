/**
 * Memory Routes
 *
 * HTTP endpoints for memory status and search.
 */

import type { Context } from "hono";
import { createMemoryIndexer, type MemoryIndexer } from "@/gateway/memory/indexer/indexer";
import { DEFAULT_COMPACTION_SETTINGS } from "@/gateway/memory/compaction/token-counter";
import { logger } from "@/packages/logger";

// Global memory indexer instance (lazy initialized per workspace)
const indexers = new Map<string, MemoryIndexer>();

/**
 * Get or create a memory indexer for a workspace
 */
function getIndexer(workspaceRoot: string, enableVector = false): MemoryIndexer {
	let indexer = indexers.get(workspaceRoot);
	if (!indexer) {
		indexer = createMemoryIndexer({
			workspaceRoot,
			enableVector,
		});
		indexers.set(workspaceRoot, indexer);
	}
	return indexer;
}

/**
 * GET /memory/status
 *
 * Returns memory system status including FTS5 and vector index info.
 */
export async function handleMemoryStatus(c: Context) {
	const workspaceRoot = c.req.query("workspace") || c.req.query("workspaceRoot");

	if (!workspaceRoot) {
		return c.json({ error: "workspace parameter required" }, 400);
	}

	try {
		const indexer = getIndexer(workspaceRoot);

		// Initialize if not already
		if (!indexer.isInitialized()) {
			await indexer.initialize();
		}

		const status = await indexer.getStatus();
		const vectorEnabled = indexer.isVectorEnabled();

		return c.json({
			fts5: {
				enabled: status.fts5,
				documentCount: status.documentCount,
				lastIndexed: status.lastIndexed?.toISOString() ?? null,
			},
			vector: {
				enabled: vectorEnabled,
				provider: vectorEnabled ? "openai" : null, // Could be expanded
				dimensions: vectorEnabled ? 1536 : null, // text-embedding-3-small dimensions
			},
			config: {
				threshold: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
				reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			},
		});
	} catch (error) {
		logger.error({ error, workspaceRoot }, "Failed to get memory status");
		return c.json({ error: "Failed to get memory status" }, 500);
	}
}

/**
 * GET /memory/search
 * POST /memory/search
 *
 * Search memory using hybrid search (FTS5 + vector).
 *
 * Query params / body:
 * - query (required): Search query string
 * - workspace (required): Workspace root path
 * - mode (optional): "fts5" | "vector" | "hybrid" (default: hybrid if vector enabled)
 * - limit (optional): Max results (default: 5)
 * - type (optional): Filter by memory type ("memory" | "daily" | "bank")
 */
export async function handleMemorySearch(c: Context) {
	const workspaceRoot = c.req.query("workspace") || c.req.query("workspaceRoot");

	let query: string;
	let mode: "fts5" | "vector" | "hybrid" = "hybrid";
	let limit = 5;
	let typeFilter: string | undefined;

	if (c.req.method === "GET") {
		query = c.req.query("q") || c.req.query("query") || "";
		mode = (c.req.query("mode") as "fts5" | "vector" | "hybrid") || "hybrid";
		limit = parseInt(c.req.query("limit") || "5", 10);
		typeFilter = c.req.query("type");
	} else {
		// POST
		const body = await c.req.json();
		query = body.query || body.q || "";
		mode = body.mode || "hybrid";
		limit = body.limit || 5;
		typeFilter = body.type;
	}

	if (!workspaceRoot) {
		return c.json({ error: "workspace parameter required" }, 400);
	}

	if (!query.trim()) {
		return c.json({ error: "query parameter required" }, 400);
	}

	try {
		const indexer = getIndexer(workspaceRoot);

		// Initialize if not already
		if (!indexer.isInitialized()) {
			await indexer.initialize();
		}

		const results = await indexer.search(query, {
			mode: mode as "keyword" | "vector" | "hybrid",
			limit,
		});

		// Apply type filter if specified
		let filtered = results;
		if (typeFilter) {
			filtered = results.filter((r) => r.source?.type === typeFilter);
		}

		return c.json({
			query,
			mode,
			total: filtered.length,
			hits: filtered.map((r) => ({
				path: r.path,
				snippet: r.snippet,
				source: r.source,
				line: r.line,
			})),
		});
	} catch (error) {
		logger.error({ error, workspaceRoot, query }, "Failed to search memory");
		return c.json({ error: "Failed to search memory" }, 500);
	}
}

/**
 * POST /memory/reindex
 *
 * Trigger a full reindex of memory files.
 */
export async function handleMemoryReindex(c: Context) {
	const workspaceRoot = c.req.query("workspace") || c.req.query("workspaceRoot");

	if (!workspaceRoot) {
		return c.json({ error: "workspace parameter required" }, 400);
	}

	try {
		const indexer = getIndexer(workspaceRoot);

		// Initialize if not already
		if (!indexer.isInitialized()) {
			await indexer.initialize();
		}

		const result = await indexer.rebuild();

		if (result.ok) {
			return c.json({ ok: true, message: "Reindex started" });
		} else {
			return c.json({ ok: false, error: result.reason }, 500);
		}
	} catch (error) {
		logger.error({ error, workspaceRoot }, "Failed to reindex memory");
		return c.json({ error: "Failed to reindex memory" }, 500);
	}
}

/**
 * Close all indexers (cleanup)
 */
export function closeAllIndexers(): void {
	for (const [workspace, indexer] of indexers) {
		indexer.close();
		logger.debug({ workspace }, "Closed memory indexer");
	}
	indexers.clear();
}
