/**
 * Memory Indexer
 *
 * Main orchestrator for the memory indexing system.
 */

import { createHybridSearchManager, type HybridSearchManager, type HybridSearchOptions } from "./hybrid";
import { ensureMemoryDirs, getMemoryPaths } from "./storage";
import type { IndexStatus, MemoryPaths, SearchResult } from "./types";

/**
 * Indexer configuration
 */
export interface IndexerConfig {
	workspaceRoot: string;
	enableVector: boolean;
	embeddingProvider?: "openai" | "gemini" | "voyage" | "mistral";
	embeddingApiKey?: string;
}

/**
 * Memory Indexer
 *
 * Orchestrates FTS5 and vector indexing for memory search.
 */
export class MemoryIndexer {
	private searchManager: HybridSearchManager | null = null;
	private paths: MemoryPaths;
	private initialized = false;

	constructor(private config: IndexerConfig) {
		this.paths = getMemoryPaths(config.workspaceRoot);
	}

	/**
	 * Initialize the indexer
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		// Ensure directories exist
		await ensureMemoryDirs(this.paths);

		// Initialize search manager
		this.searchManager = createHybridSearchManager(
			this.config.workspaceRoot,
			this.paths,
			this.config.enableVector
				? {
						provider: this.config.embeddingProvider ?? "openai",
						apiKey: this.config.embeddingApiKey,
					}
				: undefined,
		);

		await this.searchManager.initialize();
		this.initialized = true;
	}

	/**
	 * Close the indexer
	 */
	close(): void {
		if (this.searchManager) {
			this.searchManager.close();
			this.searchManager = null;
		}
		this.initialized = false;
	}

	/**
	 * Check if initialized
	 */
	isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * Get index status
	 */
	async getStatus(): Promise<IndexStatus> {
		if (!this.searchManager) {
			return {
				initialized: false,
				fts5: false,
				vector: false,
				documentCount: 0,
			};
		}

		const status = await this.searchManager.getStatus();

		return {
			initialized: true,
			fts5: status.fts5,
			vector: status.vector,
			documentCount: status.documentCount,
			lastIndexed: status.lastIndexed,
		};
	}

	/**
	 * Rebuild the index from markdown files
	 */
	async rebuild(): Promise<{ ok: boolean; reason?: string }> {
		if (!this.searchManager) {
			return { ok: false, reason: "not initialized" };
		}

		return this.searchManager.rebuildIndex();
	}

	/**
	 * Search memory
	 */
	async search(query: string, options?: HybridSearchOptions): Promise<SearchResult[]> {
		if (!this.searchManager) {
			return [];
		}

		return this.searchManager.search(query, options);
	}

	/**
	 * Check if vector search is enabled
	 */
	isVectorEnabled(): boolean {
		return this.searchManager?.isVectorEnabled() ?? false;
	}

	/**
	 * Get the memory paths
	 */
	getPaths(): MemoryPaths {
		return this.paths;
	}
}

/**
 * Create a memory indexer
 */
export function createMemoryIndexer(config: IndexerConfig): MemoryIndexer {
	return new MemoryIndexer(config);
}
