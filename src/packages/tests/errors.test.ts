import { describe, expect, test } from "bun:test";
import {
	AuthError,
	ConflictError,
	createErrorResponse,
	ErrorCode,
	type ErrorResponse,
	getStatusCode,
	HTTPError,
	NotFoundError,
	ValidationError,
} from "@/packages/errors";

describe("ErrorCode enum", () => {
	test("should have all client error codes", () => {
		expect(ErrorCode.BAD_REQUEST).toBe(400);
		expect(ErrorCode.UNAUTHORIZED).toBe(401);
		expect(ErrorCode.FORBIDDEN).toBe(403);
		expect(ErrorCode.NOT_FOUND).toBe(404);
		expect(ErrorCode.CONFLICT).toBe(409);
		expect(ErrorCode.UNPROCESSABLE_ENTITY).toBe(422);
		expect(ErrorCode.TOO_MANY_REQUESTS).toBe(429);
	});

	test("should have all server error codes", () => {
		expect(ErrorCode.INTERNAL_SERVER_ERROR).toBe(500);
		expect(ErrorCode.NOT_IMPLEMENTED).toBe(501);
		expect(ErrorCode.BAD_GATEWAY).toBe(502);
		expect(ErrorCode.SERVICE_UNAVAILABLE).toBe(503);
		expect(ErrorCode.GATEWAY_TIMEOUT).toBe(504);
	});
});

describe("HTTPError", () => {
	test("should create error with message and default status code", () => {
		const error = new HTTPError("Something went wrong");
		expect(error.message).toBe("Something went wrong");
		expect(error.statusCode).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
		expect(error.name).toBe("HTTPError");
	});

	test("should create error with custom status code", () => {
		const error = new HTTPError("Not found", ErrorCode.NOT_FOUND);
		expect(error.message).toBe("Not found");
		expect(error.statusCode).toBe(ErrorCode.NOT_FOUND);
		expect(error.name).toBe("HTTPError");
	});

	test("should be instanceof Error", () => {
		const error = new HTTPError("Test");
		expect(error instanceof Error).toBe(true);
		expect(error instanceof HTTPError).toBe(true);
	});

	test("should have stack trace", () => {
		const error = new HTTPError("Test");
		expect(error.stack).toBeDefined();
		expect(typeof error.stack).toBe("string");
	});

	test("should work with try-catch", () => {
		try {
			throw new HTTPError("Caught error", ErrorCode.BAD_REQUEST);
		} catch (e) {
			expect(e).toBeInstanceOf(HTTPError);
			if (e instanceof HTTPError) {
				expect(e.message).toBe("Caught error");
				expect(e.statusCode).toBe(ErrorCode.BAD_REQUEST);
			}
		}
	});
});

describe("ValidationError", () => {
	test("should create error with message and BAD_REQUEST status", () => {
		const error = new ValidationError("Validation failed");
		expect(error.message).toBe("Validation failed");
		expect(error.statusCode).toBe(ErrorCode.BAD_REQUEST);
		expect(error.name).toBe("ValidationError");
	});

	test("should accept details parameter", () => {
		const details = { field: "email", issue: "Invalid format" };
		const error = new ValidationError("Validation failed", details);
		expect(error.details).toEqual(details);
	});

	test("should have default status code BAD_REQUEST", () => {
		const error = new ValidationError("Test");
		expect(error.statusCode).toBe(400);
	});

	test("should work with optional details", () => {
		const error = new ValidationError("Test");
		expect(error.details).toBeUndefined();
	});
});

describe("NotFoundError", () => {
	test("should create error with resource name", () => {
		const error = new NotFoundError("User");
		expect(error.message).toBe("User not found");
		expect(error.statusCode).toBe(ErrorCode.NOT_FOUND);
		expect(error.name).toBe("NotFoundError");
	});

	test("should format message correctly", () => {
		const error = new NotFoundError("Configuration file");
		expect(error.message).toBe("Configuration file not found");
	});

	test("should handle empty resource name", () => {
		const error = new NotFoundError("");
		expect(error.message).toBe(" not found");
	});
});

describe("AuthError", () => {
	test("should create error with default message", () => {
		const error = new AuthError();
		expect(error.message).toBe("Unauthorized");
		expect(error.statusCode).toBe(ErrorCode.UNAUTHORIZED);
		expect(error.name).toBe("AuthError");
	});

	test("should create error with custom message", () => {
		const error = new AuthError("Invalid token");
		expect(error.message).toBe("Invalid token");
		expect(error.statusCode).toBe(ErrorCode.UNAUTHORIZED);
	});
});

describe("ConflictError", () => {
	test("should create error with message", () => {
		const error = new ConflictError("Resource already exists");
		expect(error.message).toBe("Resource already exists");
		expect(error.statusCode).toBe(ErrorCode.CONFLICT);
		expect(error.name).toBe("ConflictError");
	});

	test("should have CONFLICT status code", () => {
		const error = new ConflictError("Test");
		expect(error.statusCode).toBe(409);
	});
});

describe("getStatusCode", () => {
	test("should return status code from HTTPError", () => {
		const error = new HTTPError("Test", ErrorCode.FORBIDDEN);
		expect(getStatusCode(error)).toBe(ErrorCode.FORBIDDEN);
	});

	test("should return status code from ValidationError", () => {
		const error = new ValidationError("Test");
		expect(getStatusCode(error)).toBe(ErrorCode.BAD_REQUEST);
	});

	test("should return status code from NotFoundError", () => {
		const error = new NotFoundError("Resource");
		expect(getStatusCode(error)).toBe(ErrorCode.NOT_FOUND);
	});

	test("should return status code from AuthError", () => {
		const error = new AuthError();
		expect(getStatusCode(error)).toBe(ErrorCode.UNAUTHORIZED);
	});

	test("should return status code from ConflictError", () => {
		const error = new ConflictError("Test");
		expect(getStatusCode(error)).toBe(ErrorCode.CONFLICT);
	});

	test("should return status code from error object with statusCode property", () => {
		const error = { statusCode: 418, message: "I'm a teapot" };
		expect(getStatusCode(error)).toBe(418);
	});

	test("should return status code for valid 4xx error objects", () => {
		const error = { statusCode: 402 };
		expect(getStatusCode(error)).toBe(402);
	});

	test("should return status code for valid 5xx error objects", () => {
		const error = { statusCode: 503 };
		expect(getStatusCode(error)).toBe(503);
	});

	test("should return INTERNAL_SERVER_ERROR for unknown error type", () => {
		const error = new Error("Generic error");
		expect(getStatusCode(error)).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
	});

	test("should return INTERNAL_SERVER_ERROR for string errors", () => {
		expect(getStatusCode("String error")).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
	});

	test("should return INTERNAL_SERVER_ERROR for null", () => {
		expect(getStatusCode(null)).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
	});

	test("should return INTERNAL_SERVER_ERROR for undefined", () => {
		expect(getStatusCode(undefined)).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
	});

	test("should return INTERNAL_SERVER_ERROR for object without statusCode", () => {
		const error = { message: "No statusCode" };
		expect(getStatusCode(error)).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
	});

	test("should return INTERNAL_SERVER_ERROR for invalid statusCode range (below 400)", () => {
		const error = { statusCode: 200 };
		expect(getStatusCode(error)).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
	});

	test("should return INTERNAL_SERVER_ERROR for invalid statusCode range (above 599)", () => {
		const error = { statusCode: 999 };
		expect(getStatusCode(error)).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
	});

	test("should return INTERNAL_SERVER_ERROR for non-numeric statusCode", () => {
		const error = { statusCode: "400" as unknown as number };
		expect(getStatusCode(error)).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
	});

	test("should handle number status codes not in ErrorCode enum", () => {
		const error = { statusCode: 418 };
		expect(getStatusCode(error)).toBe(418);
	});
});

describe("createErrorResponse", () => {
	test("should create response from Error", () => {
		const error = new Error("Something went wrong");
		const response = createErrorResponse(error);

		expect(response.error).toBe("Something went wrong");
		expect(response.code).toBe("Error");
		expect(response.requestId).toBeUndefined();
	});

	test("should create response from HTTPError", () => {
		const error = new HTTPError("Not found", ErrorCode.NOT_FOUND);
		const response = createErrorResponse(error);

		expect(response.error).toBe("Not found");
		expect(response.code).toBe("HTTPError");
	});

	test("should create response from ValidationError", () => {
		const error = new ValidationError("Invalid input");
		const response = createErrorResponse(error);

		expect(response.error).toBe("Invalid input");
		expect(response.code).toBe("ValidationError");
	});

	test("should include requestId when provided", () => {
		const error = new Error("Test");
		const response = createErrorResponse(error, "req-123");

		expect(response.requestId).toBe("req-123");
	});

	test("should handle custom error classes", () => {
		class CustomError extends Error {
			constructor(message: string) {
				super(message);
				this.name = "CustomError";
			}
		}

		const error = new CustomError("Custom message");
		const response = createErrorResponse(error);

		expect(response.error).toBe("Custom message");
		expect(response.code).toBe("CustomError");
	});

	test("should handle string errors", () => {
		const response = createErrorResponse("String error");

		// Non-Error values return "Unknown error"
		expect(response.error).toBe("Unknown error");
		expect(response.code).toBe("UNKNOWN_ERROR");
	});

	test("should handle null errors", () => {
		const response = createErrorResponse(null);

		expect(response.error).toBe("Unknown error");
		expect(response.code).toBe("UNKNOWN_ERROR");
	});

	test("should handle undefined errors", () => {
		const response = createErrorResponse(undefined);

		expect(response.error).toBe("Unknown error");
		expect(response.code).toBe("UNKNOWN_ERROR");
	});

	test("should handle object errors", () => {
		const error = { message: "Object error" };
		const response = createErrorResponse(error);

		// Non-Error objects return "Unknown error"
		expect(response.error).toBe("Unknown error");
		expect(response.code).toBe("UNKNOWN_ERROR");
	});

	test("should handle errors without message property", () => {
		const error = {} as unknown;
		const response = createErrorResponse(error);

		expect(response.error).toBe("Unknown error");
		expect(response.code).toBe("UNKNOWN_ERROR");
	});

	test("should not include requestId when not provided", () => {
		const error = new Error("Test");
		const response = createErrorResponse(error);

		expect(response.requestId).toBeUndefined();
	});

	test("should handle empty requestId", () => {
		const error = new Error("Test");
		const response = createErrorResponse(error, "");

		expect(response.requestId).toBe("");
	});

	test("should work with all error types", () => {
		const errors = [
			new HTTPError("HTTP"),
			new ValidationError("Validation"),
			new NotFoundError("Resource"),
			new AuthError("Auth"),
			new ConflictError("Conflict"),
			new Error("Generic"),
		];

		for (const error of errors) {
			const response = createErrorResponse(error, "test-id");
			expect(response.error).toBeDefined();
			expect(response.code).toBeDefined();
			expect(response.requestId).toBe("test-id");
		}
	});
});

describe("ErrorResponse interface", () => {
	test("should allow all optional fields", () => {
		const response: ErrorResponse = {
			error: "Test error",
			code: "TEST_CODE",
			details: { field: "value" },
			requestId: "req-123",
		};

		expect(response.error).toBe("Test error");
		expect(response.code).toBe("TEST_CODE");
		expect(response.details).toEqual({ field: "value" });
		expect(response.requestId).toBe("req-123");
	});

	test("should allow only required error field", () => {
		const response: ErrorResponse = {
			error: "Test error",
		};

		expect(response.error).toBe("Test error");
		expect(response.code).toBeUndefined();
		expect(response.details).toBeUndefined();
		expect(response.requestId).toBeUndefined();
	});
});
