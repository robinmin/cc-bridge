/**
 * Memory System Types
 *
 * Extended types for the enhanced memory system following Openclaw's
 * markdown-first approach with Pi-mono-style compaction.
 */

import type { MemoryBackend, MemorySearchHit, MemoryWriteResult } from "./contracts";

// ============================================================================
// Core Types
// ============================================================================

/** Memory slot types */
export type MemorySlot = "builtin" | "none" | "external";

/** Bank memory types */
export type BankType = "world" | "experience" | "opinions" | "entities";

/** Memory source for indexing */
export interface MemorySource {
	type: "memory" | "daily" | "bank";
	bankType?: BankType;
	entity?: string;
}

/** Memory document with metadata */
export interface MemoryDoc {
	path: string;
	text: string;
	source: MemorySource;
	lastModified?: Date;
}

// ============================================================================
// Storage Types
// ============================================================================

/** Memory file paths */
export interface MemoryPaths {
	root: string;
	memory: string;
	daily: string;
	bank: string;
	world: string;
	experience: string;
	opinions: string;
	entities: string;
}

/** Memory configuration */
export interface MemoryConfig {
	slot: MemorySlot;
	citations: "auto" | "on" | "off";
	loadPolicy: {
		groupLoadLongTerm: boolean;
	};
	flush: {
		enabled: boolean;
		softThresholdTokens: number;
	};
	builtin: {
		index: {
			enabled: boolean;
			vector: boolean;
			provider?: string;
		};
	};
	external?: {
		provider?: string;
	};
}

// ============================================================================
// Search Types
// ============================================================================

/** Search mode */
export type SearchMode = "keyword" | "vector" | "hybrid";

/** Search result with metadata */
export interface SearchResult extends MemorySearchHit {
	source: MemorySource;
	line?: number;
}

/** Search options */
export interface SearchOptions {
	mode?: SearchMode;
	limit?: number;
	sources?: MemorySource[];
	bankTypes?: BankType[];
}

/** Search results */
export interface SearchResults {
	hits: SearchResult[];
	mode: SearchMode;
	total: number;
}

// ============================================================================
// Index Types
// ============================================================================

/** Index status */
export interface IndexStatus {
	initialized: boolean;
	fts5: boolean;
	vector: boolean;
	documentCount: number;
	lastIndexed?: Date;
}

/** Index entry */
export interface IndexEntry {
	id: number;
	path: string;
	source: MemorySource;
	content: string;
	embedding?: number[];
}

// ============================================================================
// Compaction Types
// ============================================================================

/** Compaction settings */
export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

/** Compaction trigger */
export interface CompactionTrigger {
	type: "threshold" | "manual" | "scheduled";
	reason: string;
}

/** Summary format from pi-mono */
export interface SessionSummary {
	goal: string;
	constraints: string[];
	progress: {
		done: string[];
		inProgress: string[];
		blocked: string[];
	};
	keyDecisions: Array<{ decision: string; rationale: string }>;
	nextSteps: string[];
	criticalContext: string[];
	fileOperations: {
		read: string[];
		written: string[];
		modified: string[];
	};
}

/** Compaction result */
export interface CompactionResult {
	ok: boolean;
	summary?: SessionSummary;
	previousTokens: number;
	newTokens: number;
	reason?: string;
}

// ============================================================================
// Embedding Types
// ============================================================================

/** Embedding provider */
export type EmbeddingProvider = "openai" | "gemini" | "voyage" | "mistral" | "local";

/** Embedding result */
export interface EmbeddingResult {
	embedding: number[];
	provider: EmbeddingProvider;
	model: string;
}

/** Embedding status */
export interface EmbeddingStatus {
	available: boolean;
	provider?: EmbeddingProvider;
	model?: string;
	error?: string;
}

// ============================================================================
// Memory Backend Extended Interface
// ============================================================================

/** Extended memory backend interface */
export interface ExtendedMemoryBackend extends MemoryBackend {
	// Storage
	getMemory(): Promise<MemoryDoc>;
	getDaily(date: string): Promise<MemoryDoc>;
	getBank(type: BankType): Promise<MemoryDoc>;
	getEntity(entity: string): Promise<MemoryDoc>;

	// Write
	upsertMemory(entry: string): Promise<MemoryWriteResult>;
	appendDaily(entry: string, date?: string): Promise<MemoryWriteResult>;
	upsertBank(type: BankType, entry: string): Promise<MemoryWriteResult>;
	upsertEntity(entity: string, entry: string): Promise<MemoryWriteResult>;

	// Search (extended)
	searchExtended(query: string, options?: SearchOptions): Promise<SearchResults>;

	// Index
	rebuildIndex(): Promise<{ ok: boolean; reason?: string }>;
	getIndexStatus(): Promise<IndexStatus>;

	// Compaction
	compact(trigger: CompactionTrigger): Promise<CompactionResult>;
	getCompactionSettings(): CompactionSettings;
	setCompactionSettings(settings: Partial<CompactionSettings>): void;
}
