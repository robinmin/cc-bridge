/**
 * Prompt Utilities
 *
 * Shared prompt validation and sanitization functions.
 * Extracted from claude-executor.ts for reuse across all engine layers.
 */

import { logger } from "@/packages/logger";

// =============================================================================
// Security Constants
// =============================================================================

const MAX_PROMPT_LENGTH = 100000;
const MAX_LINE_LENGTH = 10000;

// XML escape patterns to prevent injection
const XML_ESCAPE_REGEX = /[<>&'"]/g;
const XML_ESCAPE_MAP: Record<string, string> = {
	"<": "&lt;",
	">": "&gt;",
	"&": "&amp;",
	"'": "&apos;",
	'"': "&quot;",
};

// =============================================================================
// Validation Types
// =============================================================================

/** Result of prompt validation */
export interface PromptValidationResult {
	valid: boolean;
	sanitized: string;
	reason?: string;
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Escapes XML special characters to prevent injection
 */
export function escapeXml(text: string): string {
	return text.replace(XML_ESCAPE_REGEX, (char) => XML_ESCAPE_MAP[char]);
}

/**
 * Validates and sanitizes user input to prevent injection attacks
 */
export function validateAndSanitizePrompt(text: string): PromptValidationResult {
	// Check for null bytes and control characters
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional validation of control characters
	const hasControlChars = /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/.test(text);
	if (hasControlChars) {
		logger.warn(
			{
				reason: "control_characters",
				textLength: text.length,
			},
			"Message validation failed: contains invalid characters",
		);
		return {
			valid: false,
			sanitized: "",
			reason: "Message contains invalid characters",
		};
	}

	// Check for excessive line length (potential injection)
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.length > MAX_LINE_LENGTH) {
			logger.warn(
				{
					reason: "line_too_long",
					lineLength: line.length,
					maxLength: MAX_LINE_LENGTH,
				},
				"Message validation failed: line too long",
			);
			return {
				valid: false,
				sanitized: "",
				reason: "Message line too long",
			};
		}
	}

	// Escape XML to prevent injection in the message tags
	const sanitized = escapeXml(text);

	// Truncate to max length
	const truncated =
		sanitized.length > MAX_PROMPT_LENGTH ? `${sanitized.substring(0, MAX_PROMPT_LENGTH)}... [truncated]` : sanitized;

	if (truncated !== sanitized) {
		logger.debug(
			{
				originalLength: sanitized.length,
				truncatedLength: truncated.length,
				maxLength: MAX_PROMPT_LENGTH,
			},
			"Message truncated due to length",
		);
	}

	return { valid: true, sanitized: truncated };
}

/**
 * Builds a Claude prompt from message history
 */
export function buildClaudePrompt(
	userMessage: string,
	history: Array<{ sender: string; text: string; timestamp: string }>,
): string {
	// Sanitize user message first
	const validationResult = validateAndSanitizePrompt(userMessage);
	if (!validationResult.valid) {
		throw new Error(validationResult.reason || "Validation failed");
	}

	const historyLines = history
		.filter((m) => m.text !== userMessage) // exclude current message
		.reverse()
		.map((m) => `<message sender="${escapeXml(m.sender)}" timestamp="${m.timestamp}">${escapeXml(m.text)}</message>`);

	return `<messages>\n${historyLines.join("\n")}\n<message sender="user">${validationResult.sanitized}</message>\n</messages>`;
}

/**
 * Builds a plain text context prompt (for Codex)
 */
export function buildPlainContextPrompt(
	basePrompt: string,
	history: Array<{ sender: string; text: string; timestamp: string }>,
): string {
	const lines = history
		.slice()
		.reverse()
		.map((item) => `[${item.timestamp}] ${item.sender}: ${item.text}`);

	return ["Conversation context:", ...lines, "", "Current request:", basePrompt].join("\n");
}

/**
 * Interpolates template variables in command arguments
 */
export function interpolateArg(
	template: string,
	prompt: string,
	workspace: string,
	chatId: string | number | undefined,
): string {
	return template
		.replaceAll("{{prompt}}", prompt)
		.replaceAll("{{workspace}}", workspace)
		.replaceAll("{{chat_id}}", chatId === undefined ? "" : String(chatId));
}

// =============================================================================
// Result Type Guards
// =============================================================================

import type { ExecutionResult } from "./contracts";

/**
 * Type guard to check if execution result is async (tmux mode)
 */
export function isAsyncResult(result: ExecutionResult): result is ExecutionResult & { mode: "tmux" } {
	return result.mode === "tmux";
}
