import { z } from "zod";

/**
 * Callback request schema for Stop Hook callback
 * Validates requestId, chatId, and workspace format
 */
export const CallbackRequestSchema = z.object({
	requestId: z
		.string({
			required_error: "requestId is required",
		})
		.min(1, "requestId cannot be empty")
		.max(128, "requestId too long")
		.regex(/^[a-zA-Z0-9_-]+$/, "requestId must contain only alphanumeric characters, underscores, and hyphens"),
	chatId: z
		.union([z.string(), z.number()], {
			errorMap: () => ({ message: "chatId must be a string or number" }),
		})
		.refine((val) => {
			const numVal = typeof val === "string" ? parseInt(val, 10) : val;
			return !Number.isNaN(numVal) && numVal !== 0;
		}, "chatId must be a non-zero number"),
	workspace: z
		.string({
			required_error: "workspace is required",
		})
		.min(1, "workspace cannot be empty")
		.max(64, "workspace name too long")
		.regex(/^[a-zA-Z0-9_-]+$/, "workspace must contain only alphanumeric characters, underscores, and hyphens"),
});

export type CallbackRequest = z.infer<typeof CallbackRequestSchema>;

/**
 * Callback metadata from Stop Hook retry logic
 */
export const CallbackMetadataSchema = z.object({
	success: z.boolean(),
	attempts: z.number().nonnegative(),
	error: z.string().optional(),
	retryTimestamps: z.array(z.string()),
});

export type CallbackMetadata = z.infer<typeof CallbackMetadataSchema>;

/**
 * Response file structure written by Agent, read by Gateway
 * Validates the complete response file structure
 */
export const ResponseFileSchema = z.object({
	requestId: z.string(),
	chatId: z.union([z.string(), z.number()]),
	workspace: z.string(),
	timestamp: z.string().datetime({ message: "Invalid ISO 8601 timestamp" }),
	output: z.string(),
	exitCode: z.number(),
	error: z.string().optional(),
	metadata: z
		.object({
			duration: z.number().optional(),
			model: z.string().optional(),
			tokens: z.number().optional(),
		})
		.optional(),
	callback: CallbackMetadataSchema.optional(),
});

export type ResponseFile = z.infer<typeof ResponseFileSchema>;

/**
 * Error response schema for callback errors
 */
export const CallbackErrorResponseSchema = z.object({
	error: z.string(),
	reason: z.string().optional(),
	details: z.array(z.string()).optional(),
	retryAfter: z.number().optional(),
});

export type CallbackErrorResponse = z.infer<typeof CallbackErrorResponseSchema>;

/**
 * Success response schema
 */
export const CallbackSuccessResponseSchema = z.object({
	success: z.boolean(),
	duplicate: z.boolean().optional(),
});

export type CallbackSuccessResponse = z.infer<typeof CallbackSuccessResponseSchema>;

/**
 * Health check response schema
 */
export const CallbackHealthResponseSchema = z.object({
	status: z.literal("healthy"),
	services: z.object({
		idempotency: z.object({
			size: z.number(),
			maxSize: z.number(),
			hitRate: z.number(),
		}),
		rateLimit: z.object({
			workspaces: z.number(),
			ips: z.number(),
		}),
	}),
});

export type CallbackHealthResponse = z.infer<typeof CallbackHealthResponseSchema>;
