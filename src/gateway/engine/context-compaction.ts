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
 * 3. Summarize middle messages into a single summary block
 * 4. Return compacted message list
 *
 * Integration:
 * - AgentSessionManager.pruneMessages() calls compactMessages() when enabled
 * - EmbeddedAgent provides the summarizeFn via its LLM
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { logger } from "@/packages/logger";

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for context compaction
 */
export interface CompactionConfig {
	/** Enable LLM-based compaction (default: true) */
	enabled?: boolean;
	/** Trigger compaction when message count reaches this % of max (default: 0.8) */
	threshold?: number;
	/** Number of recent messages to preserve (default: 20) */
	preserveRecent?: number;
	/** System prompt for summarization */
	summaryPrompt?: string;
}

/**
 * Result of a compaction operation
 */
export interface CompactionResult {
	/** Original message count */
	originalCount: number;
	/** Message count after compaction */
	compactedCount: number;
	/** Length of the summary text */
	summaryLength: number;
	/** Number of messages that were dropped */
	messagesDropped: number;
}

/**
 * Internal message with role for type narrowing
 */
interface MessageWithRole {
	role?: string;
	[key: string]: unknown;
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_SUMMARY_PROMPT = `Summarize the following conversation history into a concise summary that preserves:
1. Key decisions made
2. Important context about the task
3. Any unresolved questions or issues

Keep the summary under 500 words. Focus on information that would be useful for continuing the conversation.

Conversation to summarize:
{conversation}`;

// =============================================================================
// Compaction Functions
// =============================================================================

/**
 * Check if compaction is needed based on message count.
 *
 * @param messageCount - Current number of messages
 * @param maxMessages - Maximum messages allowed
 * @param threshold - Threshold ratio (0-1) to trigger compaction
 * @returns true if compaction should be triggered
 */
export function needsCompaction(messageCount: number, maxMessages: number, threshold: number = 0.8): boolean {
	return messageCount >= Math.floor(maxMessages * threshold);
}

/**
 * Compact message history using LLM summarization.
 *
 * Strategy:
 * 1. Keep system messages (role: system)
 * 2. Keep last N recent messages (preserveRecent)
 * 3. Summarize middle messages into a single summary block
 * 4. Return compacted message list
 *
 * @param messages - The message history to compact
 * @param config - Compaction configuration
 * @param summarizeFn - Async function to summarize text using LLM
 * @returns Compacted messages and result statistics
 */
export async function compactMessages(
	messages: AgentMessage[],
	config: CompactionConfig,
	summarizeFn: (text: string) => Promise<string>,
): Promise<{ messages: AgentMessage[]; result: CompactionResult }> {
	const enabled = config.enabled ?? true;
	const preserveRecent = config.preserveRecent ?? 20;
	const summaryPrompt = config.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT;

	// If compaction disabled or not enough messages, return as-is
	if (!enabled || messages.length <= preserveRecent) {
		return {
			messages,
			result: {
				originalCount: messages.length,
				compactedCount: messages.length,
				summaryLength: 0,
				messagesDropped: 0,
			},
		};
	}

	// Separate system messages and non-system messages
	const systemMessages: AgentMessage[] = [];
	const nonSystemMessages: AgentMessage[] = [];

	for (const msg of messages) {
		if (isSystemMessage(msg)) {
			systemMessages.push(msg);
		} else {
			nonSystemMessages.push(msg);
		}
	}

	// If non-system messages fit within preserveRecent, no compaction needed
	if (nonSystemMessages.length <= preserveRecent) {
		return {
			messages: [...systemMessages, ...nonSystemMessages],
			result: {
				originalCount: messages.length,
				compactedCount: messages.length,
				summaryLength: 0,
				messagesDropped: 0,
			},
		};
	}

	// Split into "to summarize" and "to preserve"
	const toSummarize = nonSystemMessages.slice(0, nonSystemMessages.length - preserveRecent);
	const toPreserve = nonSystemMessages.slice(-preserveRecent);

	// Extract text from messages to summarize
	const textToSummarize = extractTextForSummary(toSummarize);

	let summary: string;
	try {
		// Generate summary using LLM
		const prompt = summaryPrompt.replace("{conversation}", textToSummarize);
		summary = await summarizeFn(prompt);
	} catch (error) {
		logger.warn(
			{ error, messageCount: toSummarize.length },
			"LLM summarization failed, falling back to slice-based pruning",
		);
		// Fallback: just keep the most recent messages
		return {
			messages: [...systemMessages, ...toPreserve],
			result: {
				originalCount: messages.length,
				compactedCount: systemMessages.length + toPreserve.length,
				summaryLength: 0,
				messagesDropped: toSummarize.length,
			},
		};
	}

	// Create summary message
	const summaryMessage = createSummaryMessage(summary, toSummarize.length);

	// Build compacted message list
	const compacted: AgentMessage[] = [...systemMessages, summaryMessage, ...toPreserve];

	const result: CompactionResult = {
		originalCount: messages.length,
		compactedCount: compacted.length,
		summaryLength: summary.length,
		messagesDropped: toSummarize.length - 1, // -1 because we added 1 summary message
	};

	logger.info(
		{
			originalCount: result.originalCount,
			compactedCount: result.compactedCount,
			messagesDropped: result.messagesDropped,
			summaryLength: result.summaryLength,
		},
		"Context compaction completed",
	);

	return { messages: compacted, result };
}

/**
 * Check if a message is a system message.
 */
function isSystemMessage(message: AgentMessage): boolean {
	if (!message || typeof message !== "object") return false;
	const msg = message as MessageWithRole;
	return msg.role === "system";
}

/**
 * Extract text content from messages for summarization.
 * Handles user, assistant, and tool result messages.
 */
function extractTextForSummary(messages: AgentMessage[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue;

		const m = msg as MessageWithRole;

		if (m.role === "user") {
			// User message - extract text content
			const content = (m as { content?: unknown }).content;
			if (typeof content === "string") {
				parts.push(`[User]: ${content}`);
			} else if (Array.isArray(content)) {
				const textParts = content
					.filter(
						(block): block is { type: string; text: string } =>
							typeof block === "object" && block !== null && block.type === "text",
					)
					.map((block) => block.text);
				if (textParts.length > 0) {
					parts.push(`[User]: ${textParts.join(" ")}`);
				}
			}
		} else if (m.role === "assistant") {
			// Assistant message - extract text content
			const content = (m as { content?: unknown }).content;
			if (Array.isArray(content)) {
				const textParts = content
					.filter(
						(block): block is { type: string; text: string } =>
							typeof block === "object" && block !== null && block.type === "text",
					)
					.map((block) => block.text);
				if (textParts.length > 0) {
					parts.push(`[Assistant]: ${textParts.join(" ")}`);
				}
			}
		} else if (m.role === "tool_result") {
			// Tool result - extract content
			const content = (m as { content?: unknown }).content;
			if (typeof content === "string") {
				// Truncate long tool results
				const truncated = content.length > 500 ? `${content.slice(0, 500)}...[truncated]` : content;
				const toolName = (m as { toolName?: string }).toolName ?? "unknown";
				parts.push(`[Tool Result (${toolName})]: ${truncated}`);
			} else if (Array.isArray(content)) {
				const textParts = content
					.filter(
						(block): block is { type: string; text: string } =>
							typeof block === "object" && block !== null && block.type === "text",
					)
					.map((block) => block.text);
				if (textParts.length > 0) {
					const combined = textParts.join(" ");
					const truncated = combined.length > 500 ? `${combined.slice(0, 500)}...[truncated]` : combined;
					const toolName = (m as { toolName?: string }).toolName ?? "unknown";
					parts.push(`[Tool Result (${toolName})]: ${truncated}`);
				}
			}
		}
	}

	return parts.join("\n\n");
}

/**
 * Create a summary message block that replaces old messages.
 * Uses a custom message type that will be passed to the LLM as context.
 */
function createSummaryMessage(summary: string, originalCount: number): AgentMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `[Context Summary - ${originalCount} previous messages summarized]\n\n${summary}`,
			},
		],
		timestamp: Date.now(),
	} as AgentMessage;
}

/**
 * Synchronous fallback for compaction when LLM is not available.
 * Simply slices to keep the most recent messages.
 */
export function compactMessagesSync(
	messages: AgentMessage[],
	maxMessages: number,
	preserveRecent: number = 20,
): AgentMessage[] {
	if (messages.length <= maxMessages) {
		return messages;
	}

	// Separate system messages
	const systemMessages: AgentMessage[] = [];
	const nonSystemMessages: AgentMessage[] = [];

	for (const msg of messages) {
		if (isSystemMessage(msg)) {
			systemMessages.push(msg);
		} else {
			nonSystemMessages.push(msg);
		}
	}

	// Keep system messages + most recent non-system messages
	const toKeep = nonSystemMessages.slice(-preserveRecent);

	logger.debug(
		{
			original: messages.length,
			pruned: systemMessages.length + toKeep.length,
			dropped: messages.length - systemMessages.length - toKeep.length,
		},
		"Sync context pruning (no LLM summarization)",
	);

	return [...systemMessages, ...toKeep];
}
