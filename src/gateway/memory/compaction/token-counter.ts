/**
 * Token Counter
 *
 * Estimates token count for context management.
 * Uses a simple approximation: ~4 characters per token.
 */

import type { CompactionSettings } from "./types";

/**
 * Default compaction settings (pi-mono style)
 */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384, // 16KB reserved for system/other
	keepRecentTokens: 20000, // Keep ~20KB of recent context
};

/**
 * Estimate token count for text
 * Simple approximation: ~4 chars per token
 */
export function estimateTokens(text: string): number {
	// More accurate: count words and adjust
	// Average English word is ~5 chars, plus spaces
	// So roughly 4 chars per token is a good approximation
	return Math.ceil(text.length / 4);
}

/**
 * Count tokens more accurately using tiktoken-like approach
 * This is a simplified version that works without external deps
 */
export function countTokens(text: string): number {
	// Split by whitespace
	const words = text.split(/\s+/).filter((w) => w.length > 0);

	// Estimate tokens (words + special chars)
	let tokens = 0;
	for (const word of words) {
		// Each word is roughly 1 token
		tokens += 1;

		// Add extra for long words (> 7 chars)
		if (word.length > 7) {
			tokens += Math.floor((word.length - 7) / 3);
		}

		// Add for special patterns
		if (word.includes("```")) tokens += 2;
		if (word.startsWith("#")) tokens += 1;
		if (word.startsWith("-")) tokens += 1;
	}

	return tokens;
}

/**
 * Check if compaction should trigger
 */
export function shouldCompact(currentTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) {
		return false;
	}

	const threshold = contextWindow - settings.reserveTokens;
	return currentTokens > threshold;
}

/**
 * Calculate how much to compact
 */
export function getCompactionAmount(
	currentTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
): number {
	const targetTokens = contextWindow - settings.keepRecentTokens;
	const excess = currentTokens - targetTokens;

	return Math.max(0, excess);
}

/**
 * Split text into chunks for summarization
 */
export function splitForSummarization(text: string, maxChunkTokens: number = 4000): string[] {
	const lines = text.split(/\r?\n/);
	const chunks: string[] = [];
	let currentChunk = "";
	let currentTokens = 0;

	for (const line of lines) {
		const lineTokens = countTokens(line);

		if (currentTokens + lineTokens > maxChunkTokens && currentChunk) {
			chunks.push(currentChunk);
			currentChunk = "";
			currentTokens = 0;
		}

		currentChunk += (currentChunk ? "\n" : "") + line;
		currentTokens += lineTokens;
	}

	if (currentChunk) {
		chunks.push(currentChunk);
	}

	return chunks;
}
