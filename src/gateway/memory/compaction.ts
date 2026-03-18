/**
 * Memory Compaction Index
 *
 * Exports for the compaction system.
 */

export {
	createMemoryCompactor,
	MemoryCompactor,
} from "./compaction/compactor";

export {
	createSummarizer,
	OpenAISummarizer,
	parseSummaryResponse,
	type SessionMessage,
	type SummarizerConfig,
} from "./compaction/summarizer";
export {
	countTokens,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	getCompactionAmount,
	shouldCompact,
	splitForSummarization,
} from "./compaction/token-counter";

export type {
	CompactionResult,
	CompactionSettings,
	CompactionTrigger,
	SessionSummary,
} from "./compaction/types";
