import type { Context } from "hono";
import type { TelegramChannel } from "@/gateway/channels/telegram";
import {
	type CallbackErrorResponse,
	CallbackErrorResponseSchema,
	type CallbackHealthResponse,
	CallbackHealthResponseSchema,
	CallbackRequestSchema,
	type CallbackSuccessResponse,
	CallbackSuccessResponseSchema,
} from "@/gateway/schemas/callback";
import type { IdempotencyService } from "@/gateway/services/IdempotencyService";
import type { RateLimitService } from "@/gateway/services/RateLimitService";
import { FileReadError, FileReadErrorType, type ResponseFileReader } from "@/gateway/services/ResponseFileReader";
import { logger } from "@/packages/logger";

/**
 * Configuration for callback handler
 */
export interface CallbackContext {
	telegram: TelegramChannel;
	idempotencyService?: IdempotencyService;
	rateLimitService?: RateLimitService;
	responseFileReader?: ResponseFileReader;
}

/**
 * Maximum request payload size (10KB)
 */
const MAX_REQUEST_SIZE = 10 * 1024;

/**
 * Maximum processing timeout (5 seconds)
 */
const _MAX_PROCESSING_TIME_MS = 5000;

/**
 * Validate request payload size
 */
function validateRequestSize(contentLength: string | null): boolean {
	if (!contentLength) return true; // No size info, allow it
	const size = Number.parseInt(contentLength, 10);
	return size <= MAX_REQUEST_SIZE;
}

/**
 * Create a standardized error response
 */
function createErrorResponse(
	error: string,
	reason?: string,
	details?: string[],
	retryAfter?: number,
): CallbackErrorResponse {
	const response: CallbackErrorResponse = { error };

	if (reason) response.reason = reason;
	if (details && details.length > 0) response.details = details;
	if (retryAfter !== undefined) response.retryAfter = retryAfter;

	return response;
}

/**
 * Get client IP from request headers
 * Handles various proxy scenarios (X-Forwarded-For, CF-Connecting-IP, etc.)
 */
function getClientIp(c: Context): string {
	// Check Cloudflare header
	const cfIp = c.req.header("CF-Connecting-IP");
	if (cfIp) return cfIp;

	// Check X-Forwarded-For header
	const xff = c.req.header("X-Forwarded-For");
	if (xff) {
		// X-Forwarded-For can contain multiple IPs, take the first one
		const ips = xff.split(",").map((ip) => ip.trim());
		return ips[0] || "unknown";
	}

	// Check X-Real-IP header
	const xRealIp = c.req.header("X-Real-IP");
	if (xRealIp) return xRealIp;

	// Fall back to remote address (Hono might not expose this directly)
	return c.req.header("X-Client-IP") || "unknown";
}

/**
 * Send success response (with duplicate flag if applicable)
 */
function sendSuccessResponse(c: Context, isDuplicate: boolean): Response {
	const response: CallbackSuccessResponse = {
		success: true,
	};

	if (isDuplicate) {
		response.duplicate = true;
	}

	// Validate response before sending
	const result = CallbackSuccessResponseSchema.safeParse(response);
	if (!result.success) {
		logger.error({ errors: result.error.errors }, "Failed to validate success response");
		return c.json({ error: "Internal server error" }, 500);
	}

	c.res.headers.set("X-Request-Id", c.req.header("X-Request-Id") || "unknown");
	return c.json(response, 200);
}

/**
 * Handle Claude callback from Stop Hook (hardened version)
 *
 * This endpoint:
 * 1. Validates request payload (schema, size)
 * 2. Enforces rate limiting (per-workspace and per-IP)
 * 3. Checks for duplicate requests (idempotency)
 * 4. Reads and validates response file with retry
 * 5. Processes the response (sends to Telegram)
 * 6. Cleans up resources
 *
 * @param c - Hono context
 * @param context - Callback context with services
 * @returns Response with appropriate status code
 */
export async function handleClaudeCallback(c: Context, context: CallbackContext): Promise<Response> {
	const startTime = Date.now();

	try {
		// 0. Validate request size
		const contentLength = c.req.header("Content-Length");
		if (!validateRequestSize(contentLength)) {
			logger.warn({ contentLength, maxSize: MAX_REQUEST_SIZE }, "Request payload too large");
			return c.json(createErrorResponse("Request too large", "payload_too_large"), 413);
		}

		// 1. Parse and validate request body
		let requestBody: unknown;
		try {
			requestBody = await c.req.json();
		} catch (err) {
			logger.warn({ error: err }, "Failed to parse request JSON");
			return c.json(createErrorResponse("Invalid JSON", "parse_error"), 400);
		}

		const validationResult = CallbackRequestSchema.safeParse(requestBody);
		if (!validationResult.success) {
			const errors = validationResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
			logger.warn({ errors, body: requestBody }, "Invalid callback payload");
			return c.json(createErrorResponse("Validation failed", "invalid_payload", errors), 400);
		}

		const { requestId, chatId, workspace } = validationResult.data;
		const clientIp = getClientIp(c);

		logger.info({ requestId, chatId, workspace, clientIp }, "Received Claude callback");

		// Set request ID header for tracing
		c.res.headers.set("X-Request-Id", requestId);

		// 2. Rate limiting
		if (context.rateLimitService) {
			const rateLimitResult = context.rateLimitService.checkLimit(workspace, clientIp);

			if (!rateLimitResult.allowed) {
				logger.warn(
					{
						workspace,
						clientIp,
						reason: rateLimitResult.reason,
						retryAfter: rateLimitResult.retryAfter,
					},
					"Rate limit exceeded",
				);

				const response = createErrorResponse(
					"Rate limit exceeded",
					rateLimitResult.reason,
					undefined,
					rateLimitResult.retryAfter,
				);

				const validated = CallbackErrorResponseSchema.safeParse(response);
				if (!validated.success) {
					logger.error({ errors: validated.error.errors }, "Failed to validate error response");
					return c.json({ error: "Internal server error" }, 500);
				}

				c.res.headers.set("Retry-After", String(rateLimitResult.retryAfter || 60));
				return c.json(response, 429);
			}
		}

		// 3. Idempotency check
		let isDuplicate = false;
		if (context.idempotencyService) {
			if (context.idempotencyService.isDuplicate(requestId)) {
				logger.info({ requestId }, "Duplicate callback detected");
				isDuplicate = true;
			} else {
				// Mark as processed early to prevent race conditions
				context.idempotencyService.markProcessed(requestId, chatId, workspace);
			}
		}

		// If duplicate, return success immediately
		if (isDuplicate) {
			return sendSuccessResponse(c, true);
		}

		// 4. Read and validate response file
		let responseData: unknown;
		try {
			if (context.responseFileReader) {
				responseData = await context.responseFileReader.readResponseFile(workspace, requestId);
			} else {
				// Fallback: return 503 if no reader configured
				logger.error({ requestId, workspace }, "No ResponseFileReader configured");
				return c.json(createErrorResponse("Service unavailable", "no_reader_configured"), 503);
			}
		} catch (err) {
			if (err instanceof FileReadError) {
				logger.error(
					{
						errorType: err.type,
						errorMessage: err.message,
						requestId,
						workspace,
					},
					"Failed to read response file",
				);

				// Map error types to HTTP status codes
				let statusCode = 500;
				let userMessage = "Failed to read response file";

				switch (err.type) {
					case FileReadErrorType.NOT_FOUND:
						statusCode = 404;
						userMessage = "Response file not found";
						break;
					case FileReadErrorType.INVALID_JSON:
					case FileReadErrorType.SCHEMA_VALIDATION_FAILED:
						statusCode = 422;
						userMessage = "Corrupted response file";
						break;
					case FileReadErrorType.TOO_LARGE:
						statusCode = 413;
						userMessage = "Response file too large";
						break;
					case FileReadErrorType.PERMISSION_DENIED:
						statusCode = 403;
						userMessage = "Permission denied";
						break;
					case FileReadErrorType.DIRECTORY_TRAVERSAL:
						statusCode = 400;
						userMessage = "Invalid file path";
						break;
				}

				return c.json(createErrorResponse(userMessage, err.type), statusCode);
			}

			// Unknown error
			logger.error({ err, requestId, workspace }, "Unexpected error reading response file");
			return c.json(createErrorResponse("Internal server error", "unknown_error"), 500);
		}

		// 5. Process response asynchronously
		// We respond immediately and process in the background
		const response = c.json({ status: "accepted" }, 202);

		processCallbackAsync(requestId, chatId, workspace, responseData, context).catch((err) => {
			logger.error({ err, requestId, chatId, workspace }, "Async callback processing failed");
		});

		const duration = Date.now() - startTime;
		logger.debug({ requestId, duration }, "Callback response sent");

		return response;
	} catch (error) {
		const duration = Date.now() - startTime;

		logger.error(
			{
				error: error instanceof Error ? error.message : String(error),
				duration,
			},
			"Callback handler error",
		);

		return c.json(createErrorResponse("Internal server error", "handler_error"), 500);
	}
}

/**
 * Process callback asynchronously
 *
 * This function:
 * 1. Formats the response output for Telegram
 * 2. Sends the message to the user
 * 3. Cleans up the response file
 */
async function processCallbackAsync(
	requestId: string,
	chatId: string | number,
	workspace: string,
	responseData: unknown,
	context: CallbackContext,
): Promise<void> {
	const startTime = Date.now();

	try {
		// Type assertion after validation in the handler
		const response = responseData as {
			requestId: string;
			chatId: string | number;
			workspace: string;
			timestamp: string;
			output: string;
			exitCode: number;
			error?: string;
			callback?: {
				success: boolean;
				attempts: number;
				error?: string;
				retryTimestamps: string[];
			};
		};

		logger.debug(
			{
				requestId,
				outputLength: response.output.length,
				exitCode: response.exitCode,
			},
			"Processing response asynchronously",
		);

		// 1. Format output for Telegram
		const formattedOutput = formatOutputForTelegram(response);

		// 2. Send to Telegram
		await context.telegram.sendMessage(chatId, formattedOutput, {
			parseMode: "Markdown",
		});

		const duration = Date.now() - startTime;

		logger.info(
			{
				requestId,
				chatId,
				workspace,
				duration,
				callbackAttempts: response.callback?.attempts || 1,
			},
			"Response delivered to Telegram",
		);

		// Note: Response file cleanup is handled by FileCleanupService
		// We don't delete it here to allow for recovery scenarios
	} catch (error) {
		logger.error(
			{
				error: error instanceof Error ? error.message : String(error),
				requestId,
				chatId,
				workspace,
			},
			"Failed to process callback",
		);

		// Send error message to user
		const errorMsg = error instanceof Error ? error.message : "Unknown error";
		const userErrorMsg = sanitizeErrorMessage(errorMsg);

		try {
			await context.telegram.sendMessage(chatId, `❌ Failed to retrieve Claude response: ${userErrorMsg}`);
		} catch (telegramError) {
			logger.error({ error: telegramError }, "Failed to send error message to Telegram");
		}
	}
}

/**
 * Format Claude output for Telegram
 *
 * - Truncates very long outputs (Telegram limit is 4096 chars)
 * - Handles exit codes
 * - Includes callback metadata if available
 */
function formatOutputForTelegram(response: {
	output: string;
	exitCode: number;
	error?: string;
	callback?: {
		success: boolean;
		attempts: number;
		error?: string;
	};
}): string {
	let output = response.output;

	// Telegram message limit is 4096 characters
	const MAX_LENGTH = 4000; // Leave some margin

	if (output.length > MAX_LENGTH) {
		output = `${output.slice(0, MAX_LENGTH)}\n\n... (output truncated)`;
	}

	// Add exit code indicator if non-zero
	if (response.exitCode !== 0) {
		const errorSuffix = response.error ? `\n\nError: ${response.error}` : "";
		output = `${output}${errorSuffix}\n\n(Exit code: ${response.exitCode})`;
	}

	// Add callback metadata if callback failed
	if (response.callback && !response.callback.success) {
		output += `\n\n📡 Callback failed after ${response.callback.attempts} attempts`;
		if (response.callback.error) {
			output += `\nReason: ${response.callback.error}`;
		}
	}

	return output;
}

/**
 * Sanitize error message for user consumption
 *
 * Removes internal paths and sensitive information
 */
function sanitizeErrorMessage(errorMsg: string): string {
	// Remove file paths
	const sanitized = errorMsg.replace(/\/[a-zA-Z0-9_/\-.]+/g, "[path]");

	// Keep the essential error information
	if (sanitized.includes("Response file not found")) {
		return "Response file not found. The request may have timed out.";
	}

	if (sanitized.includes("Invalid response file structure")) {
		return "Invalid response format.";
	}

	if (sanitized.includes("Schema validation failed")) {
		return "Response validation failed.";
	}

	// Return sanitized message or a generic one
	return sanitized.length > 100 ? "An error occurred while processing the response." : sanitized;
}

/**
 * Health check endpoint for callback services
 *
 * Returns statistics about idempotency cache and rate limiting
 */
export async function handleCallbackHealth(c: Context, context: CallbackContext): Promise<Response> {
	const healthData: CallbackHealthResponse = {
		status: "healthy",
		services: {
			idempotency: {
				size: 0,
				maxSize: 0,
				hitRate: 0,
			},
			rateLimit: {
				workspaces: 0,
				ips: 0,
			},
		},
	};

	if (context.idempotencyService) {
		healthData.services.idempotency = context.idempotencyService.getStats();
	}

	if (context.rateLimitService) {
		const rateLimitStats = context.rateLimitService.getStats();
		healthData.services.rateLimit = {
			workspaces: rateLimitStats.workspaces,
			ips: rateLimitStats.ips,
		};
	}

	const result = CallbackHealthResponseSchema.safeParse(healthData);
	if (!result.success) {
		logger.error({ errors: result.error.errors }, "Failed to validate health response");
		return c.json({ error: "Internal server error" }, 500);
	}

	return c.json(healthData, 200);
}
