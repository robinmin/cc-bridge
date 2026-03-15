/**
 * Context Compaction with LLM Summarization
 *
 * Implements LLM-powered context compaction for long-running agent sessions.
 * Instead of simply slicing off old messages, we summarize them into a concise
 * summary that preserves key information.
 *
 * Strategy:
 * 1. Keep system messages (role: system)
 * 2. Keep last N recent messages (preserveRecent)
 * 3. Summarize the middle messages into a single summary message
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { logger } from "@/packages/logger";

/**
 * Configuration for context compaction
 */
export interface CompactionConfig {
	/** Enable compaction (default: true) */
	enabled?: boolean;
	/** Ratio of messages to preserve (0.5 = keep half, summarize half) */
	threshold?: number;
	/** Number of recent messages to always preserve */
	preserveRecent?: number;
	/** Custom prompt for summarization */
	summaryPrompt?: string;
}

/**
 * Result of compaction operation
 */
export interface CompactionResult {
	/** Number of original messages before compaction */
	originalCount: number;
	/** Number of messages after compaction */
	compactedCount: number;
	/** Whether compaction was performed */
	performed: boolean;
	/** Number of messages dropped during compaction */
	messagesDropped?: number;
	/** Length of the summary text if summarization was performed */
	summaryLength?: number;
	/** Summary text if compaction was performed */
	summary?: string;
}

/**
 * Default prompt for summarization
 */
// Note: DEFAULT_SUMMARY_PROMPT reserved for future summarization implementation
const _DEFAULT_SUMMARY_PROMPT = `You are a helpful assistant tasked with summarizing a conversation.
Provide a concise summary that captures the key information, decisions, and outcomes.
Focus on preserving important facts, code changes, and any resolved issues.
Keep the summary under 200 words.`;

/**
 * Check if a message is a system message
 */
function isSystemMessage(message: AgentMessage): boolean {
	return message.role === "system";
}

/**
 * Check if a message has text content
 */
function hasTextContent(message: AgentMessage): boolean {
	return (
		typeof message.content === "string" ||
		(Array.isArray(message.content) && message.content.some((block) => "text" in block))
	);
}

/**
 * Extract text from an agent message
 */
function extractText(message: AgentMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	if (Array.isArray(message.content)) {
		return message.content
			.filter((block) => "text" in block)
			.map((block) => (block as { text: string }).text)
			.join("\n");
	}
	return "";
}

/**
 * Check if the message history needs compaction based on threshold.
 *
 * Supports two signatures:
 * - needsCompaction(messageCount, maxMessages, threshold): Legacy API with counts
 * - needsCompaction(messages, threshold, preserveRecent): New API with message array
 *
 * @param messagesOrCount - Either message array or message count number
 * @param maxMessagesOrThreshold - Either maxMessages number or threshold ratio
 * @param preserveRecentOrThreshold - Either preserveRecent number or threshold ratio (for legacy)
 * @returns true if compaction is needed
 */
export function needsCompaction(
	messagesOrCount: AgentMessage[] | number,
	maxMessagesOrThreshold: number,
	preserveRecentOrThreshold?: number,
): boolean {
	// Legacy API: needsCompaction(messageCount, maxMessages, threshold)
	// Example: needsCompaction(50, 100, 0.8) - 50 messages, 100 max, 0.8 threshold
	if (typeof messagesOrCount === "number") {
		const messageCount = messagesOrCount;
		const maxMessages = maxMessagesOrThreshold;
		const threshold = preserveRecentOrThreshold ?? 0.8;

		// If maxMessages is 0, always trigger compaction
		if (maxMessages === 0) {
			return messageCount > 0;
		}

		// Calculate preserve count based on threshold (preserve threshold% of maxMessages)
		const preserveCount = Math.floor(maxMessages * threshold);

		// Compaction needed if messageCount >= preserveCount (i.e., we're at or over the threshold)
		return messageCount >= preserveCount;
	}

	// New API: needsCompaction(messages, threshold, preserveRecent)
	const messages = messagesOrCount;
	const threshold = maxMessagesOrThreshold;
	const preserveRecent = preserveRecentOrThreshold ?? 20;

	// Don't count system messages in the threshold calculation
	const nonSystemMessages = messages.filter((m) => !isSystemMessage(m));

	// Need at least preserveRecent + 1 other message to trigger compaction
	if (nonSystemMessages.length <= preserveRecent) {
		return false;
	}

	// Check if we're over the threshold
	const preserveCount = Math.floor(nonSystemMessages.length * threshold);
	return nonSystemMessages.length > preserveCount + preserveRecent;
}

/**
 * Extract text from multiple messages for summarization
 */
function extractMessagesForSummary(messages: AgentMessage[]): string {
	return messages
		.filter((m) => !isSystemMessage(m) && hasTextContent(m))
		.map((m) => {
			const role = m.role;
			const text = extractText(m);
			return `## ${role}\n\n${text}`;
		})
		.join("\n\n---\n\n");
}

/**
 * Create a summary message from summarized text
 */
function createSummaryMessage(summary: string): AgentMessage {
	return {
		role: "user",
		content: `[Previous conversation summary]\n\n${summary}`,
		timestamp: Date.now(),
	};
}

/**
 * Compact messages using LLM summarization.
 *
 * @param messages - The message history to compact
 * @param config - Compaction configuration
 * @param summarizeFn - Async function to summarize text using LLM
 * @returns Compacted messages and result statistics
 */
export async function compactMessages(
	messages: (AgentMessage | null | undefined)[],
	config: CompactionConfig,
	summarizeFn: (text: string) => Promise<string>,
): Promise<{ messages: AgentMessage[]; result: CompactionResult }> {
	const enabled = config.enabled ?? true;
	const preserveRecent = config.preserveRecent ?? 20;
	// Note: summaryPrompt is available via config.summaryPrompt for future use

	// Filter out null/undefined messages first
	const validMessages = messages.filter((m): m is AgentMessage => m != null && m !== undefined);
	const originalCount = messages.length;
	const validCount = validMessages.length;

	// If compaction disabled or not enough messages, return as-is
	if (!enabled || validCount <= preserveRecent) {
		return {
			messages: validMessages,
			result: {
				originalCount,
				compactedCount: validCount,
				performed: false,
				messagesDropped: originalCount - validCount,
			},
		};
	}

	// Separate system and non-system messages
	const systemMessages = validMessages.filter(isSystemMessage);
	const nonSystemMessages = validMessages.filter((m) => !isSystemMessage(m));

	// If we have fewer non-system messages than threshold, no compaction needed
	if (!needsCompaction(validMessages, config.threshold ?? 0.5, preserveRecent)) {
		return {
			messages: validMessages,
			result: {
				originalCount,
				compactedCount: validCount,
				performed: false,
				messagesDropped: 0,
			},
		};
	}

	// Determine which messages to summarize
	const recentMessages = nonSystemMessages.slice(-preserveRecent);
	const messagesToSummarize = nonSystemMessages.slice(0, -preserveRecent);

	// Skip if nothing to summarize
	if (messagesToSummarize.length === 0) {
		return {
			messages: validMessages,
			result: {
				originalCount,
				compactedCount: validCount,
				performed: false,
				messagesDropped: 0,
			},
		};
	}

	logger.debug(
		{
			originalCount: validCount,
			toSummarize: messagesToSummarize.length,
			toPreserve: preserveRecent,
		},
		"Compacting messages",
	);

	// Extract text for summarization
	const textToSummarize = extractMessagesForSummary(messagesToSummarize);

	// Call the LLM to summarize
	let summary: string;
	let summaryMessage: AgentMessage;

	try {
		summary = await summarizeFn(textToSummarize);
		summaryMessage = createSummaryMessage(summary);
	} catch (error) {
		// On summarization error, fall back to just preserving recent messages without summary
		logger.warn({ error }, "Summarization failed, falling back to simple compaction");
		summary = "";
		summaryMessage = {
			role: "user",
			content: "[Summarization failed - messages preserved without summary]",
			timestamp: Date.now(),
		};
	}

	// Build compacted message list
	const compactedMessages: AgentMessage[] = [...systemMessages, summaryMessage, ...recentMessages];

	logger.info(
		{
			originalCount: validCount,
			compactedCount: compactedMessages.length,
			summaryLength: summary.length,
		},
		"Messages compacted successfully",
	);

	return {
		messages: compactedMessages,
		result: {
			originalCount,
			compactedCount: compactedMessages.length,
			performed: true,
			messagesDropped: validCount - compactedMessages.length,
			summaryLength: summary.length,
			summary,
		},
	};
}

/**
 * Synchronous version of compactMessages for when summarization isn't needed.
 * Simply preserves system messages and recent messages without LLM summarization.
 *
 * Supports two signatures:
 * - compactMessagesSync(messages, preserveRecent): Simple API with just preserve count
 * - compactMessagesSync(messages, maxMessages, preserveRecent): Full API with limit
 *
 * @param messages - The message history to compact
 * @param maxMessagesOrPreserveRecent - Either maxMessages limit or preserveRecent count
 * @param preserveRecentOrUndefined - Number of recent messages to preserve (if maxMessages provided)
 * @returns Compacted messages (system + recent)
 */
export function compactMessagesSync(
	messages: AgentMessage[],
	maxMessagesOrPreserveRecent: number,
	preserveRecentOrUndefined?: number,
): AgentMessage[] {
	// Determine parameters based on overload
	let maxMessages: number | undefined;
	let preserveRecent: number;

	if (preserveRecentOrUndefined !== undefined) {
		// Full API: compactMessagesSync(messages, maxMessages, preserveRecent)
		maxMessages = maxMessagesOrPreserveRecent;
		preserveRecent = preserveRecentOrUndefined;
	} else {
		// Simple API: compactMessagesSync(messages, preserveRecent)
		preserveRecent = maxMessagesOrPreserveRecent;
	}

	const systemMessages = messages.filter(isSystemMessage);
	const nonSystemMessages = messages.filter((m) => !isSystemMessage(m));

	// If maxMessages is specified and message count is within limit, return original
	if (maxMessages !== undefined && messages.length <= maxMessages) {
		return messages;
	}

	// If we don't have more than preserveRecent, return original array as-is
	if (nonSystemMessages.length <= preserveRecent) {
		// Return the original array reference to maintain referential equality
		return messages;
	}

	// Just keep system messages and recent messages
	let recentMessages = nonSystemMessages.slice(-preserveRecent);

	// If maxMessages is specified, also enforce that limit
	if (maxMessages !== undefined) {
		const totalLimit = Math.max(preserveRecent, maxMessages - systemMessages.length);
		recentMessages = recentMessages.slice(-totalLimit);
	}

	const compactedMessages: AgentMessage[] = [...systemMessages, ...recentMessages];

	return compactedMessages;
}
