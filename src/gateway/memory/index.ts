/**
 * Memory System Index
 *
 * Main entry point for the enhanced memory system.
 * Follows Openclaw's markdown-first approach with Pi-mono-style compaction.
 */

export * from "./bank";
// Compaction Layer
export * from "./compaction";
// Re-export contracts
export type {
	MemoryBackend,
	MemoryCitationMode,
	MemoryConfig,
	MemoryDocument,
	MemorySearchHit,
	MemorySearchOptions,
	MemorySlot,
	MemoryStatus,
	MemoryWriteResult,
	ReindexResult,
} from "./contracts";
export * from "./daily-log";
export * from "./indexer/embeddings";
export * from "./indexer/file-watcher";
export * from "./indexer/fts5";
export * from "./indexer/hybrid";
// Indexer Layer
export * from "./indexer/indexer";
export * from "./memory";
// Storage Layer
export * from "./storage";
// Types
export * from "./types";
