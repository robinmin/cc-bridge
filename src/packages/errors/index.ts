/**
 * Standard error codes for HTTP responses
 */
export enum ErrorCode {
	// Client errors (4xx)
	BAD_REQUEST = 400,
	UNAUTHORIZED = 401,
	FORBIDDEN = 403,
	NOT_FOUND = 404,
	CONFLICT = 409,
	UNPROCESSABLE_ENTITY = 422,
	TOO_MANY_REQUESTS = 429,

	// Server errors (5xx)
	INTERNAL_SERVER_ERROR = 500,
	NOT_IMPLEMENTED = 501,
	BAD_GATEWAY = 502,
	SERVICE_UNAVAILABLE = 503,
	GATEWAY_TIMEOUT = 504,
}

/**
 * Standard error response format
 */
export interface ErrorResponse {
	error: string;
	code?: string;
	details?: unknown;
	requestId?: string;
}

/**
 * Base HTTP error class
 */
export class HTTPError extends Error {
	constructor(
		message: string,
		public statusCode: ErrorCode = ErrorCode.INTERNAL_SERVER_ERROR,
	) {
		super(message);
		this.name = "HTTPError";
	}
}

/**
 * Validation error (400/422)
 */
export class ValidationError extends HTTPError {
	constructor(
		message: string,
		public details?: unknown,
	) {
		super(message, ErrorCode.BAD_REQUEST);
		this.name = "ValidationError";
	}
}

/**
 * Not found error (404)
 */
export class NotFoundError extends HTTPError {
	constructor(resource: string) {
		super(`${resource} not found`, ErrorCode.NOT_FOUND);
		this.name = "NotFoundError";
	}
}

/**
 * Unauthorized error (401)
 */
export class AuthError extends HTTPError {
	constructor(message: string = "Unauthorized") {
		super(message, ErrorCode.UNAUTHORIZED);
		this.name = "AuthError";
	}
}

/**
 * Conflict error (409)
 */
export class ConflictError extends HTTPError {
	constructor(message: string) {
		super(message, ErrorCode.CONFLICT);
		this.name = "ConflictError";
	}
}

/**
 * Get appropriate HTTP status code for error
 */
export function getStatusCode(error: unknown): ErrorCode {
	if (error instanceof HTTPError) {
		return error.statusCode;
	}

	// Check for error with statusCode property
	if (error && typeof error === "object" && "statusCode" in error) {
		const code = (error as { statusCode: number }).statusCode;
		if (typeof code === "number" && code >= 400 && code < 600) {
			return code as ErrorCode;
		}
	}

	// Default to internal server error
	return ErrorCode.INTERNAL_SERVER_ERROR;
}

/**
 * Create standard error response
 */
export function createErrorResponse(error: unknown, requestId?: string): ErrorResponse {
	const message = error instanceof Error ? error.message : "Unknown error";
	const code = error instanceof Error ? error.name : "UNKNOWN_ERROR";

	return {
		error: message,
		code,
		requestId,
	};
}
