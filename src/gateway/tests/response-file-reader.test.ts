import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileReadError, FileReadErrorType, ResponseFileReader } from "@/gateway/services/ResponseFileReader";

describe("ResponseFileReader", () => {
	let testDir: string;
	let reader: ResponseFileReader;

	beforeEach(async () => {
		testDir = `/tmp/test-reader-${Date.now()}`;
		await mkdir(path.join(testDir, "test-workspace", "responses"), {
			recursive: true,
		});

		reader = new ResponseFileReader({
			ipcBasePath: testDir,
			maxFileSize: 1024 * 100, // 100KB for testing
			maxReadRetries: 3,
			readRetryDelayMs: 10,
		});
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test("should read valid response file", async () => {
		const validResponse = {
			requestId: "test-001",
			chatId: "123456",
			workspace: "test-workspace",
			timestamp: new Date().toISOString(),
			output: "Hello World",
			exitCode: 0,
		};

		await writeFile(path.join(testDir, "test-workspace", "responses", "test-001.json"), JSON.stringify(validResponse));

		const result = await reader.readResponseFile("test-workspace", "test-001");

		expect(result.requestId).toBe("test-001");
		expect(result.output).toBe("Hello World");
		expect(result.exitCode).toBe(0);
	});

	test("should sanitize paths to prevent directory traversal", async () => {
		// Sanitization keeps alphanumeric, underscore, and hyphen
		// "../other-workspace" -> "other-workspace" (dots/slashes removed, hyphen kept)
		// "../../etc/passwd" -> "etcpasswd" (dots/slashes removed)
		const validResponse = {
			requestId: "etcpasswd",
			chatId: "123456",
			workspace: "other-workspace",
			timestamp: new Date().toISOString(),
			output: "Safe output",
			exitCode: 0,
		};

		// Create the directory structure for the sanitized path
		await mkdir(path.join(testDir, "other-workspace", "responses"), {
			recursive: true,
		});
		await writeFile(
			path.join(testDir, "other-workspace", "responses", "etcpasswd.json"),
			JSON.stringify(validResponse),
		);

		// Try to read with path traversal - special chars are sanitized
		const result = await reader.readResponseFile("../other-workspace", "../../etc/passwd");

		// The path should be sanitized and read from the correct location
		expect(result).toBeDefined();
		expect(result.requestId).toBe("etcpasswd");
	});

	test("should reject paths outside base directory", async () => {
		const reader2 = new ResponseFileReader({
			ipcBasePath: testDir,
			maxFileSize: 1024 * 100,
		});

		// Try to construct a path that escapes the base directory
		// This should throw a directory traversal error
		await expect(reader2.readResponseFile("../../../etc", "passwd")).rejects.toThrow();
	});

	test("should throw NOT_FOUND for missing file", async () => {
		await expect(reader.readResponseFile("test-workspace", "nonexistent")).rejects.toThrow(FileReadError);

		try {
			await reader.readResponseFile("test-workspace", "nonexistent");
			expect(true).toBe(false); // Should not reach here
		} catch (err) {
			expect(err).toBeInstanceOf(FileReadError);
			if (err instanceof FileReadError) {
				expect(err.type).toBe(FileReadErrorType.NOT_FOUND);
			}
		}
	});

	test("should throw INVALID_JSON for malformed JSON", async () => {
		await writeFile(path.join(testDir, "test-workspace", "responses", "bad-json.json"), "{ invalid json }");

		try {
			await reader.readResponseFile("test-workspace", "bad-json");
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(FileReadError);
			if (err instanceof FileReadError) {
				expect(err.type).toBe(FileReadErrorType.INVALID_JSON);
			}
		}
	});

	test("should throw SCHEMA_VALIDATION_FAILED for invalid schema", async () => {
		const invalidSchema = {
			// Missing required fields
			requestId: "test-001",
			// Missing chatId, workspace, timestamp, output, exitCode
		};

		await writeFile(
			path.join(testDir, "test-workspace", "responses", "invalid-schema.json"),
			JSON.stringify(invalidSchema),
		);

		try {
			await reader.readResponseFile("test-workspace", "invalid-schema");
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(FileReadError);
			if (err instanceof FileReadError) {
				expect(err.type).toBe(FileReadErrorType.SCHEMA_VALIDATION_FAILED);
			}
		}
	});

	test("should throw TOO_LARGE for oversized files", async () => {
		// Create a file larger than the limit (100KB)
		const largeContent = "x".repeat(200 * 1024); // 200KB
		const largeResponse = {
			requestId: "large-001",
			chatId: "123456",
			workspace: "test-workspace",
			timestamp: new Date().toISOString(),
			output: largeContent,
			exitCode: 0,
		};

		await writeFile(path.join(testDir, "test-workspace", "responses", "large-001.json"), JSON.stringify(largeResponse));

		try {
			await reader.readResponseFile("test-workspace", "large-001");
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(FileReadError);
			if (err instanceof FileReadError) {
				expect(err.type).toBe(FileReadErrorType.TOO_LARGE);
				expect(err.message).toContain("too large");
			}
		}
	});

	test("should handle empty files", async () => {
		await writeFile(path.join(testDir, "test-workspace", "responses", "empty.json"), "");

		try {
			await reader.readResponseFile("test-workspace", "empty");
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(FileReadError);
			if (err instanceof FileReadError) {
				expect(err.type).toBe(FileReadErrorType.INVALID_JSON);
				expect(err.message).toContain("empty");
			}
		}
	});

	test("should check file existence", async () => {
		const validResponse = {
			requestId: "exists-001",
			chatId: "123456",
			workspace: "test-workspace",
			timestamp: new Date().toISOString(),
			output: "Test",
			exitCode: 0,
		};

		await writeFile(
			path.join(testDir, "test-workspace", "responses", "exists-001.json"),
			JSON.stringify(validResponse),
		);

		expect(await reader.exists("test-workspace", "exists-001")).toBe(true);
		expect(await reader.exists("test-workspace", "nonexistent")).toBe(false);
	});

	test("should get file size", async () => {
		const response = {
			requestId: "size-001",
			chatId: "123456",
			workspace: "test-workspace",
			timestamp: new Date().toISOString(),
			output: "Test content",
			exitCode: 0,
		};

		const filePath = path.join(testDir, "test-workspace", "responses", "size-001.json");
		await writeFile(filePath, JSON.stringify(response));

		const size = await reader.getFileSize("test-workspace", "size-001");
		expect(size).toBeDefined();
		expect(size).toBeGreaterThan(0);
	});

	test("should return undefined for getFileSize on non-existent file", async () => {
		const size = await reader.getFileSize("test-workspace", "nonexistent");
		expect(size).toBeUndefined();
	});

	test("should validate response file with optional fields", async () => {
		const responseWithOptionals = {
			requestId: "opt-001",
			chatId: "123456",
			workspace: "test-workspace",
			timestamp: "2024-01-01T00:00:00Z",
			output: "Test",
			exitCode: 1,
			error: "Something went wrong",
			metadata: {
				duration: 1234,
				model: "claude-3-opus",
				tokens: 1000,
			},
			callback: {
				success: false,
				attempts: 3,
				error: "server_error: HTTP 500",
				retryTimestamps: ["2024-01-01T00:00:01Z", "2024-01-01T00:00:03Z", "2024-01-01T00:00:07Z"],
			},
		};

		await writeFile(
			path.join(testDir, "test-workspace", "responses", "opt-001.json"),
			JSON.stringify(responseWithOptionals),
		);

		const result = await reader.readResponseFile("test-workspace", "opt-001");

		expect(result.exitCode).toBe(1);
		expect(result.error).toBe("Something went wrong");
		expect(result.metadata?.duration).toBe(1234);
		expect(result.metadata?.model).toBe("claude-3-opus");
		expect(result.metadata?.tokens).toBe(1000);
		expect(result.callback?.success).toBe(false);
		expect(result.callback?.attempts).toBe(3);
		expect(result.callback?.error).toBe("server_error: HTTP 500");
		expect(result.callback?.retryTimestamps).toHaveLength(3);
	});

	test("should handle number and string chatId", async () => {
		const stringResponse = {
			requestId: "chat-001",
			chatId: "123456",
			workspace: "test-workspace",
			timestamp: new Date().toISOString(),
			output: "Test",
			exitCode: 0,
		};

		await writeFile(path.join(testDir, "test-workspace", "responses", "chat-001.json"), JSON.stringify(stringResponse));

		const result1 = await reader.readResponseFile("test-workspace", "chat-001");
		expect(result1.chatId).toBe("123456");

		// Test with number chatId
		const numberResponse = { ...stringResponse, chatId: 789012 };
		await writeFile(path.join(testDir, "test-workspace", "responses", "chat-002.json"), JSON.stringify(numberResponse));

		const result2 = await reader.readResponseFile("test-workspace", "chat-002");
		expect(result2.chatId).toBe(789012);
	});

	test("should reject invalid timestamp format", async () => {
		const invalidResponse = {
			requestId: "time-001",
			chatId: "123456",
			workspace: "test-workspace",
			timestamp: "not-a-valid-timestamp",
			output: "Test",
			exitCode: 0,
		};

		await writeFile(
			path.join(testDir, "test-workspace", "responses", "time-001.json"),
			JSON.stringify(invalidResponse),
		);

		try {
			await reader.readResponseFile("test-workspace", "time-001");
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(FileReadError);
			if (err instanceof FileReadError) {
				expect(err.type).toBe(FileReadErrorType.SCHEMA_VALIDATION_FAILED);
			}
		}
	});

	test("should sanitize workspace and requestId", async () => {
		// "test-workspace/../../etc" -> "test-workspaceetc" (dots/slashes removed, hyphens kept)
		// "sanitized-001../../../passwd" -> "sanitized-001passwd" (dots/slashes removed)
		const response = {
			requestId: "sanitized-001passwd",
			chatId: "123456",
			workspace: "test-workspaceetc",
			timestamp: new Date().toISOString(),
			output: "Test",
			exitCode: 0,
		};

		// Create the file with sanitized names
		await mkdir(path.join(testDir, "test-workspaceetc", "responses"), {
			recursive: true,
		});
		await writeFile(
			path.join(testDir, "test-workspaceetc", "responses", "sanitized-001passwd.json"),
			JSON.stringify(response),
		);

		// Try to read with special characters in names - they should be sanitized
		const result = await reader.readResponseFile("test-workspace/../../etc", "sanitized-001../../../passwd");

		// Should successfully read the sanitized file
		expect(result).toBeDefined();
		expect(result.requestId).toBe("sanitized-001passwd");
	});
});
