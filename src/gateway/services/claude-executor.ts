import crypto from "node:crypto";
import type { AgentInstance } from "@/gateway/instance-manager";
import { IpcClient } from "@/packages/ipc/client";
import { logger } from "@/packages/logger";

// Security constants
const MAX_PROMPT_LENGTH = 100000;
const MAX_LINE_LENGTH = 10000;

// HTTP status codes
const HTTP_STATUS_REQUEST_TIMEOUT = 408;

// XML escape patterns to prevent injection
const XML_ESCAPE_REGEX = /[<>&'"]/g;
const XML_ESCAPE_MAP: Record<string, string> = {
	"<": "&lt;",
	">": "&gt;",
	"&": "&amp;",
	"'": "&apos;",
	'"': "&quot;",
};

// Type definition for IPC execute result
export interface IpcExecuteResult {
	stdout?: string;
	stderr?: string;
	content?: string;
	exitCode?: number;
}

// Configuration for Claude execution
export interface ClaudeExecutionConfig {
	command?: string;
	args?: string[];
	timeout?: number;
	allowDangerouslySkipPermissions?: boolean;
	allowedTools?: string;
	workspace?: string; // Current workspace name (e.g., 'cc-bridge', 'another-project')
	chatId?: string | number; // For session identification (multi-user support)
}

// Result of Claude execution
export interface ClaudeExecutionResult {
	success: boolean;
	output?: string;
	error?: string;
	exitCode?: number;
	retryable?: boolean;
	isTimeout?: boolean; // Explicit timeout flag for easy detection
}

// Error context for structured logging
export interface ErrorContext {
	containerId?: string;
	instanceName?: string;
	chatId?: string;
	operation: string;
	promptLength?: number;
	requestId?: string;
	exitCode?: number;
	cause?: unknown;
}

/**
 * Base error class for Claude execution errors
 */
export class ClaudeExecutionError extends Error {
	constructor(
		message: string,
		public readonly context: ErrorContext,
		cause?: Error,
	) {
		super(message);
		this.name = "ClaudeExecutionError";
		if (cause) {
			this.cause = cause;
		}
	}
}

/**
 * Error for IPC communication failures
 */
export class IpcCommunicationError extends ClaudeExecutionError {
	constructor(message: string, context: ErrorContext, cause?: Error) {
		super(message, { ...context, operation: "ipc_communication" }, cause);
		this.name = "IpcCommunicationError";
	}
}

/**
 * Error for validation failures
 */
export class ValidationError extends ClaudeExecutionError {
	constructor(message: string, context: ErrorContext) {
		super(message, { ...context, operation: "validation" });
		this.name = "ValidationError";
	}
}

/**
 * Error for timeout failures
 */
export class TimeoutError extends ClaudeExecutionError {
	constructor(
		message: string,
		context: ErrorContext & { timeoutMs?: number },
		cause?: Error,
	) {
		super(message, { ...context, operation: "timeout" }, cause);
		this.name = "TimeoutError";
	}
}

/**
 * Escapes XML special characters to prevent injection
 */
function escapeXml(text: string): string {
	return text.replace(XML_ESCAPE_REGEX, (char) => XML_ESCAPE_MAP[char]);
}

/**
 * Validates and sanitizes user input to prevent injection attacks
 */
export function validateAndSanitizePrompt(text: string): {
	valid: boolean;
	sanitized: string;
	reason?: string;
} {
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
		sanitized.length > MAX_PROMPT_LENGTH
			? `${sanitized.substring(0, MAX_PROMPT_LENGTH)}... [truncated]`
			: sanitized;

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
 * @throws {ValidationError} if user message validation fails
 */
export function buildClaudePrompt(
	userMessage: string,
	history: Array<{ sender: string; text: string; timestamp: string }>,
): string {
	// Sanitize user message first
	const validationResult = validateAndSanitizePrompt(userMessage);
	if (!validationResult.valid) {
		throw new ValidationError(validationResult.reason || "Validation failed", {
			operation: "build_prompt",
			promptLength: userMessage.length,
		});
	}

	const historyLines = history
		.filter((m) => m.text !== userMessage) // exclude current message (we'll add it)
		.reverse()
		.map(
			(m) =>
				`<message sender="${escapeXml(m.sender)}" timestamp="${m.timestamp}">${escapeXml(m.text)}</message>`,
		);

	return `<messages>\n${historyLines.join("\n")}\n<message sender="user">${validationResult.sanitized}</message>\n</messages>`;
}

/**
 * Executes a Claude command via IPC with retry logic (raw version using container/instance IDs)
 * This is the core execution method that can be called from any context
 */
export async function executeClaudeRaw(
	containerId: string,
	instanceName: string,
	prompt: string,
	config: ClaudeExecutionConfig = {},
): Promise<ClaudeExecutionResult> {
	const maxRetries = 1;
	let retries = maxRetries;

	const errorContext: ErrorContext = {
		containerId,
		instanceName,
		operation: "execute_claude_raw",
		promptLength: prompt.length,
	};

	while (retries >= 0) {
		try {
			logger.debug(
				{
					...errorContext,
					chatId: "unknown",
					timeout: config.timeout,
				},
				"Sending request to Claude agent",
			);

			const client = new IpcClient(containerId, instanceName);
			const requestId = crypto.randomUUID();
			errorContext.requestId = requestId;

			const response = await client.sendRequest({
				id: requestId,
				method: "POST",
				path: "/execute",
				body: {
					command: config.command || "claude",
					args:
						config.args ||
						[
							"-p",
							prompt,
							config.allowDangerouslySkipPermissions
								? "--dangerously-skip-permissions"
								: "",
							config.allowedTools !== undefined
								? `--allowedTools=${config.allowedTools}`
								: "",
						].filter(Boolean),
					cwd: `/workspaces/${config.workspace || "cc-bridge"}`,
				},
				timeout: config.timeout,
			});

			// Explicit timeout detection - status 408 means request timeout
			if (response.status === HTTP_STATUS_REQUEST_TIMEOUT) {
				const timeoutMsg = response.error?.message || "Request timeout";
				const timeoutMs = config.timeout || 120000; // Default from IpcClient

				logger.warn(
					{
						...errorContext,
						errorType: "timeout",
						statusCode: response.status,
						timeoutMs,
						retriesRemaining: retries,
					},
					"Claude execution timed out",
				);

				return {
					success: false,
					error: timeoutMsg,
					exitCode: response.status,
					retryable: retries > 0,
					isTimeout: true, // Explicit timeout flag
				};
			}

			if (response.error) {
				const errorMsg = response.error.message || "Unknown IPC error";
				errorContext.exitCode = response.status;

				// Check if this is a stale container error (retryable)
				if (retries > 0 && errorMsg.includes("No such container")) {
					logger.warn(
						{
							...errorContext,
							errorType: "stale_container",
						},
						"Stale container ID detected, request is retryable",
					);
					return {
						success: false,
						error: errorMsg,
						retryable: true,
					};
				}

				// Non-retryable IPC error
				logger.error(
					{
						...errorContext,
						errorType: "ipc_error",
						statusCode: response.status,
					},
					"IPC request failed with error response",
				);
				return {
					success: false,
					error: errorMsg,
					exitCode: response.status,
					retryable: false,
				};
			}

			if (response.result) {
				const result = response.result as IpcExecuteResult;
				const output =
					result.stdout || result.content || JSON.stringify(result);

				logger.debug(
					{
						...errorContext,
						outputLength: output.length,
						exitCode: result.exitCode,
					},
					"Claude agent response received successfully",
				);

				return {
					success: true,
					output,
					exitCode: result.exitCode,
				};
			}

			// No result and no error - unexpected response format
			logger.error(
				{
					...errorContext,
					errorType: "invalid_response",
				},
				"IPC response missing both result and error",
			);
			return {
				success: false,
				error: "No result or error in IPC response",
				retryable: false,
			};
		} catch (error: unknown) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			errorContext.cause = error;

			// Determine if this error is retryable
			if (retries > 0) {
				const isTimeoutError = errorMsg.toLowerCase().includes("timeout");
				const isConnectionError =
					errorMsg.toLowerCase().includes("econnrefused") ||
					errorMsg.toLowerCase().includes("econnreset");

				if (isTimeoutError || isConnectionError) {
					logger.warn(
						{
							...errorContext,
							errorType: isTimeoutError ? "timeout" : "connection_error",
							retriesRemaining: retries - 1,
							errorMessage: errorMsg,
						},
						"IPC call failed with retryable error",
					);
					retries--;
					continue; // Retry
				}
			}

			// Non-retryable error or out of retries
			logger.error(
				{
					...errorContext,
					errorType: "exception",
					errorMessage: errorMsg,
					retriesRemaining: retries,
				},
				"IPC call failed with exception",
			);
			return {
				success: false,
				error: errorMsg,
				retryable: retries > 0,
			};
		}
	}

	// Should not reach here
	logger.error(
		{
			...errorContext,
			errorType: "unexpected_flow",
		},
		"Unexpected exit from retry loop",
	);
	return {
		success: false,
		error: "Unknown error in Claude execution",
		retryable: false,
	};
}

/**
 * Executes a Claude command via IPC with retry logic (convenience wrapper for AgentInstance)
 */
export async function executeClaudeViaIpc(
	instance: AgentInstance,
	prompt: string,
	config: ClaudeExecutionConfig = {},
): Promise<ClaudeExecutionResult> {
	return executeClaudeRaw(instance.containerId, instance.name, prompt, config);
}

/**
 * Executes Claude with full history context and returns the result
 */
export async function executeClaudeWithHistory(
	instance: AgentInstance,
	userMessage: string,
	history: Array<{ sender: string; text: string; timestamp: string }>,
	config?: ClaudeExecutionConfig,
): Promise<ClaudeExecutionResult> {
	try {
		const prompt = buildClaudePrompt(userMessage, history);
		return await executeClaudeViaIpc(instance, prompt, config);
	} catch (error: unknown) {
		if (error instanceof ValidationError) {
			// Re-raise validation errors as-is
			throw error;
		}

		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.error(
			{
				instanceName: instance.name,
				containerId: instance.containerId,
				operation: "execute_with_history",
				error: errorMsg,
				cause: error,
			},
			"Failed to execute Claude with history",
		);
		return {
			success: false,
			error: errorMsg,
			retryable: false,
		};
	}
}
