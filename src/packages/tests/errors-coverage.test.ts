import { describe, expect, test } from "bun:test";
import { AuthError, ConflictError, ErrorCode, HTTPError, NotFoundError, ValidationError } from "@/packages/errors";

describe("Error Classes - Coverage", () => {
	describe("HTTPError", () => {
		test("should create error with default status code (lines 36-40)", () => {
			const error = new HTTPError("Test error");
			expect(error.message).toBe("Test error");
			expect(error.statusCode).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
			expect(error.name).toBe("HTTPError");
		});

		test("should create error with custom status code (lines 36-40)", () => {
			const error = new HTTPError("Not found", ErrorCode.NOT_FOUND);
			expect(error.message).toBe("Not found");
			expect(error.statusCode).toBe(ErrorCode.NOT_FOUND);
		});
	});

	describe("ValidationError", () => {
		test("should create error without details (lines 49-53)", () => {
			const error = new ValidationError("Invalid input");
			expect(error.message).toBe("Invalid input");
			expect(error.statusCode).toBe(ErrorCode.BAD_REQUEST);
			expect(error.details).toBeUndefined();
		});

		test("should create error with details (lines 49-53)", () => {
			const details = { field: "email", issue: "invalid format" };
			const error = new ValidationError("Invalid input", details);
			expect(error.message).toBe("Invalid input");
			expect(error.details).toBe(details);
		});
	});

	describe("NotFoundError", () => {
		test("should create error with resource name (lines 62-63)", () => {
			const error = new NotFoundError("User");
			expect(error.message).toBe("User not found");
			expect(error.statusCode).toBe(ErrorCode.NOT_FOUND);
		});

		test("should create error for different resources (lines 62-63)", () => {
			const error = new NotFoundError("Configuration");
			expect(error.message).toBe("Configuration not found");
		});
	});

	describe("AuthError", () => {
		test("should create error with default message (lines 72-73)", () => {
			const error = new AuthError();
			expect(error.message).toBe("Unauthorized");
			expect(error.statusCode).toBe(ErrorCode.UNAUTHORIZED);
		});

		test("should create error with custom message (lines 72-73)", () => {
			const error = new AuthError("Invalid token");
			expect(error.message).toBe("Invalid token");
		});
	});

	describe("ConflictError", () => {
		test("should create conflict error (lines 82-83)", () => {
			const error = new ConflictError("Resource already exists");
			expect(error.message).toBe("Resource already exists");
			expect(error.statusCode).toBe(ErrorCode.CONFLICT);
		});
	});
});
