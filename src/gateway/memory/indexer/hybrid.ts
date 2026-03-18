/**
 * Hybrid Search
 *
 * Combines FTS5 keyword search with vector semantic search.
 */

import { createEmbeddingProvider, type EmbeddingProviderConfig, type EmbeddingProviderInterface } from "./embeddings";
import { createFts5Indexer, type Fts5Indexer } from "./fts5";
import type { MemoryPaths, SearchMode, SearchOptions, SearchResult } from "./types";

/**
 * Hybrid Search Options
 */
export interface HybridSearchOptions extends SearchOptions {
	vectorWeight?: number;
	keywordWeight?: number;
}

/**
 * Hybrid Search Result
 */
export interface HybridSearchResult extends SearchResult {
	scores: {
		keyword?: number;
		vector?: number;
		combined?: number;
	};
}

/**
 * Hybrid Search Manager
 */
export class HybridSearchManager {
	private ftsIndexer: Fts5Indexer | null = null;
	private embeddingProvider: EmbeddingProviderInterface;
	private vectorEnabled = false;

	constructor(
		private workspaceRoot: string,
		private paths: MemoryPaths,
		embeddingConfig?: EmbeddingProviderConfig,
	) {
		this.embeddingProvider = createEmbeddingProvider(embeddingConfig ?? { provider: "openai" });
	}

	/**
	 * Initialize the search manager
	 */
	async initialize(): Promise<void> {
		// Initialize FTS5
		this.ftsIndexer = createFts5Indexer(this.workspaceRoot, this.paths);

		// Set embedding provider for vector support
		this.ftsIndexer.setEmbeddingProvider(this.embeddingProvider);

		await this.ftsIndexer.initialize();

		// Check vector availability
		const status = await this.embeddingProvider.status();
		this.vectorEnabled = status.available;
	}

	/**
	 * Close resources
	 */
	close(): void {
		if (this.ftsIndexer) {
			this.ftsIndexer.close();
			this.ftsIndexer = null;
		}
	}

	/**
	 * Check if vector search is available
	 */
	isVectorEnabled(): boolean {
		return this.vectorEnabled && (this.ftsIndexer?.isVectorEnabled() ?? false);
	}

	/**
	 * Get search status
	 */
	async getStatus() {
		const vectorStatus = await this.embeddingProvider.status();
		const indexStatus = this.ftsIndexer ? await this.ftsIndexer.getStatus() : { initialized: false };

		return {
			fts5: indexStatus.fts5,
			vector: vectorStatus.available,
			vectorProvider: vectorStatus.provider,
			documentCount: indexStatus.documentCount,
			lastIndexed: indexStatus.lastIndexed,
		};
	}

	/**
	 * Rebuild the index
	 */
	async rebuildIndex(): Promise<{ ok: boolean; reason?: string }> {
		if (!this.ftsIndexer) {
			return { ok: false, reason: "not initialized" };
		}
		return this.ftsIndexer.rebuild();
	}

	/**
	 * Search with hybrid mode
	 */
	async search(query: string, options?: HybridSearchOptions): Promise<SearchResult[]> {
		const mode = options?.mode ?? this.getDefaultMode();
		const limit = options?.limit ?? 5;

		switch (mode) {
			case "keyword":
				return this.keywordSearch(query, limit);
			case "vector":
				return this.vectorSearch(query, limit);
			case "hybrid":
				return this.hybridSearch(query, options);
			default:
				return this.keywordSearch(query, limit);
		}
	}

	/**
	 * Get default search mode
	 */
	private getDefaultMode(): SearchMode {
		return this.vectorEnabled ? "hybrid" : "keyword";
	}

	/**
	 * Keyword-only search using FTS5
	 */
	private async keywordSearch(query: string, limit: number): Promise<SearchResult[]> {
		if (!this.ftsIndexer) {
			return [];
		}

		const results = await this.ftsIndexer.search(query, limit);
		return results.map((r) => ({
			id: r.id,
			path: r.path,
			snippet: r.content,
			source: r.source,
		}));
	}

	/**
	 * Vector-only search using cosine similarity
	 */
	private async vectorSearch(query: string, limit: number): Promise<SearchResult[]> {
		if (!this.ftsIndexer || !this.vectorEnabled) {
			return [];
		}

		const results = await this.ftsIndexer.searchVectors(query, limit);
		return results.map((r) => ({
			id: r.id,
			path: r.path,
			snippet: r.content,
			source: r.source,
		}));
	}

	/**
	 * Hybrid search combining keyword and vector
	 */
	private async hybridSearch(query: string, options?: HybridSearchOptions): Promise<SearchResult[]> {
		const vectorWeight = options?.vectorWeight ?? 0.5;
		const keywordWeight = options?.keywordWeight ?? 0.5;
		const limit = options?.limit ?? 5;

		// Get keyword results
		const keywordResults = await this.keywordSearch(query, limit * 2);

		// If vector not available, return keyword results
		if (!this.vectorEnabled) {
			return keywordResults.slice(0, limit);
		}

		// Get vector results
		const vectorResults = await this.vectorSearch(query, limit * 2);

		// Combine results using weighted scoring
		const combined = this.mergeResults(keywordResults, vectorResults, keywordWeight, vectorWeight);

		return combined.slice(0, limit);
	}

	/**
	 * Merge keyword and vector results
	 */
	private mergeResults(
		keywordResults: SearchResult[],
		vectorResults: SearchResult[],
		keywordWeight: number,
		vectorWeight: number,
	): SearchResult[] {
		// Score and merge results
		const scored = new Map<string, SearchResult & { score: number }>();

		// Score keyword results (normalize to 0-1 range)
		for (let i = 0; i < keywordResults.length; i++) {
			const r = keywordResults[i];
			const score = ((keywordResults.length - i) / keywordResults.length) * keywordWeight;
			const existing = scored.get(r.path);
			if (!existing || existing.score < score) {
				scored.set(r.path, { ...r, score });
			}
		}

		// Score vector results (normalize to 0-1 range)
		for (let i = 0; i < vectorResults.length; i++) {
			const r = vectorResults[i];
			const score = ((vectorResults.length - i) / vectorResults.length) * vectorWeight;
			const existing = scored.get(r.path);
			if (!existing) {
				scored.set(r.path, { ...r, score });
			} else {
				existing.score += score;
			}
		}

		// Sort by combined score
		return Array.from(scored.values())
			.sort((a, b) => b.score - a.score)
			.map(({ score, ...rest }) => rest);
	}
}

/**
 * Create hybrid search manager
 */
export function createHybridSearchManager(
	workspaceRoot: string,
	paths: MemoryPaths,
	embeddingConfig?: EmbeddingProviderConfig,
): HybridSearchManager {
	return new HybridSearchManager(workspaceRoot, paths, embeddingConfig);
}
