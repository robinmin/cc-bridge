import crypto from "node:crypto";
import type { AgentInstance } from "@/gateway/instance-manager";
import { TmuxManager } from "@/gateway/services/tmux-manager";
import { IpcFactory } from "@/packages/ipc";
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
export class ClaudeValidationError extends ClaudeExecutionError {
	constructor(message: string, context: ErrorContext) {
		super(message, { ...context, operation: "validation" });
		this.name = "ClaudeValidationError";
	}
}

/**
 * Error for timeout failures
 */
export class ClaudeTimeoutError extends ClaudeExecutionError {
	constructor(message: string, context: ErrorContext & { timeoutMs?: number }, cause?: Error) {
		super(message, { ...context, operation: "timeout" }, cause);
		this.name = "ClaudeTimeoutError";
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
 * @throws {ValidationError} if user message validation fails
 */
export function buildClaudePrompt(
	userMessage: string,
	history: Array<{ sender: string; text: string; timestamp: string }>,
): string {
	// Sanitize user message first
	const validationResult = validateAndSanitizePrompt(userMessage);
	if (!validationResult.valid) {
		throw new ClaudeValidationError(validationResult.reason || "Validation failed", {
			operation: "build_prompt",
			promptLength: userMessage.length,
		});
	}

	const historyLines = history
		.filter((m) => m.text !== userMessage) // exclude current message (we'll add it)
		.reverse()
		.map((m) => `<message sender="${escapeXml(m.sender)}" timestamp="${m.timestamp}">${escapeXml(m.text)}</message>`);

	return `<messages>\n${historyLines.join("\n")}\n<message sender="user">${validationResult.sanitized}</message>\n</messages>`;
}

/**
 * Executes a Claude command via IPC with retry logic (raw version using container/instance IDs)
 * This is the core execution method that can be called from any context
 *
 * @param containerId - Docker container ID
 * @param instanceName - Instance name for logging
 * @param prompt - Claude prompt to execute
 * @param config - Execution configuration
 * @param config.workspace - Workspace name (used for working directory)
 * @param config.chatId - Chat ID for tracking and logging
 * @param config.timeout - Request timeout in milliseconds
 * @param config.command - Command to execute (default: "claude")
 * @param config.args - Additional command arguments
 * @param config.allowDangerouslySkipPermissions - Skip permission checks
 * @param config.allowedTools - Restrict Claude to specific tools
 *
 * @returns Execution result with success status, output, or error
 */
export async function executeClaudeRaw(
	containerId: string,
	instanceName: string,
	prompt: string,
	config: ClaudeExecutionConfig = {},
): Promise<ClaudeExecutionResult> {
	const maxRetries = 1;
	let retries = maxRetries;

	// Extract tracking metadata from config
	const workspace = config.workspace || "cc-bridge";
	const chatId = config.chatId || "unknown";

	const errorContext: ErrorContext = {
		containerId,
		instanceName,
		operation: "execute_claude_raw",
		promptLength: prompt.length,
		workspace,
		chatId,
	};

	while (retries >= 0) {
		try {
			logger.debug(
				{
					...errorContext,
					timeout: config.timeout,
				},
				"Sending request to Claude agent",
			);

			const client = IpcFactory.create("auto", { containerId, instanceName });
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
							config.allowDangerouslySkipPermissions ? "--dangerously-skip-permissions" : "",
							config.allowedTools !== undefined ? `--allowedTools=${config.allowedTools}` : "",
						].filter(Boolean),
					cwd: `/workspaces/${workspace}`,
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
				const output = result.stdout || result.content || JSON.stringify(result);

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
					errorMsg.toLowerCase().includes("econnrefused") || errorMsg.toLowerCase().includes("econnreset");

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
		if (error instanceof ClaudeValidationError) {
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

// =============================================================================
// Tmux Execution Mode (Async)
// =============================================================================

/**
 * Singleton TmuxManager instance
 */
let tmuxManagerInstance: TmuxManager | null = null;

/**
 * Get or create the TmuxManager singleton
 */
function getTmuxManager(): TmuxManager {
	if (!tmuxManagerInstance) {
		tmuxManagerInstance = new TmuxManager();
	}
	return tmuxManagerInstance;
}

/**
 * Result type for tmux async execution
 */
export interface ClaudeAsyncExecutionResult {
	requestId: string;
	mode: "tmux";
}

/**
 * Union type for sync or async execution results
 */
export type ClaudeExecutionResultOrAsync = ClaudeExecutionResult | ClaudeAsyncExecutionResult;

/**
 * Type guard to check if result is async (tmux mode)
 */
export function isAsyncResult(result: ClaudeExecutionResultOrAsync): result is ClaudeAsyncExecutionResult {
	return "mode" in result && result.mode === "tmux";
}

/**
 * Update ClaudeExecutionConfig to support tmux mode and history
 */
export interface ClaudeExecutionConfigExtended extends ClaudeExecutionConfig {
	useTmux?: boolean; // Explicitly enable/disable tmux mode
	history?: Array<{ sender: string; text: string; timestamp: string }>; // Conversation history
}

/**
 * Execute Claude via persistent tmux session (async mode)
 * Returns immediately with request ID, response arrives via callback endpoint
 *
 * @param containerId - Docker container ID
 * @param instanceName - Instance name (for logging)
 * @param prompt - Claude prompt
 * @param config - Execution configuration
 * @returns Async result with request ID
 */
export async function executeClaudeViaTmux(
	containerId: string,
	instanceName: string,
	prompt: string,
	config: ClaudeExecutionConfigExtended = {},
): Promise<ClaudeAsyncExecutionResult> {
	const requestId = crypto.randomUUID();
	const manager = getTmuxManager();

	const workspace = config.workspace || "cc-bridge";
	const chatId = String(config.chatId || "default");

	logger.info({ requestId, containerId, instanceName, workspace, chatId }, "Executing Claude via tmux");

	try {
		// 1. Get or create session
		const sessionName = await manager.getOrCreateSession(containerId, workspace, chatId);

		logger.debug({ requestId, sessionName, workspace, chatId }, "Tmux session acquired");

		// 2. Build prompt with history if provided
		const promptToSend = config.history ? buildClaudePrompt(prompt, config.history) : prompt;

		if (config.history) {
			logger.debug({ requestId, historyLength: config.history.length }, "Built prompt with conversation history");
		}

		// 3. Send prompt to session
		await manager.sendToSession(containerId, sessionName, promptToSend, {
			requestId,
			chatId,
			workspace,
		});

		logger.info({ requestId, sessionName, promptLength: promptToSend.length }, "Prompt sent to tmux session");

		// 4. Return request ID (response arrives via callback)
		return { requestId, mode: "tmux" };
	} catch (error) {
		logger.error(
			{
				error: error instanceof Error ? error.message : String(error),
				requestId,
				containerId,
				instanceName,
			},
			"Failed to execute via tmux",
		);
		throw error;
	}
}

/**
 * Unified execution method with automatic mode selection
 *
 * Mode selection priority:
 * 1. Explicit config.useTmux flag
 * 2. Global ENABLE_TMUX environment variable
 * 3. Default: false (sync mode for backward compatibility)
 *
 * @param containerId - Docker container ID
 * @param instanceName - Instance name
 * @param prompt - Claude prompt
 * @param config - Execution configuration
 * @returns Sync result with output OR async result with request ID
 */
export async function executeClaude(
	containerId: string,
	instanceName: string,
	prompt: string,
	config: ClaudeExecutionConfigExtended = {},
): Promise<ClaudeExecutionResultOrAsync> {
	// Determine execution mode
	// If explicitly set, use that value; otherwise default to env var or false
	const useTmux = config.useTmux ?? process.env.ENABLE_TMUX === "true";

	// Build prompt with history if provided
	const promptToSend = config.history ? buildClaudePrompt(prompt, config.history) : prompt;

	if (config.history && !useTmux) {
		logger.debug(
			{ containerId, instanceName, historyLength: config.history.length },
			"Built prompt with conversation history for sync mode",
		);
	}

	if (useTmux) {
		// Async mode: return request ID immediately
		return await executeClaudeViaTmux(containerId, instanceName, prompt, config);
	} else {
		// Sync mode: return result immediately
		return await executeClaudeRaw(containerId, instanceName, promptToSend, config);
	}
}
