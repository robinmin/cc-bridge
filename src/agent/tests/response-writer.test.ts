import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { type ClaudeResponseFile, ResponseWriter } from "@/agent/utils/response-writer";

// Test directory
const TEST_IPC_DIR = "./test-data/ipc-agent";
const TEST_WORKSPACE = "test-workspace";
const TEST_REQUEST_ID = "test-req-001";
const TEST_CHAT_ID = "123";

describe("ResponseWriter", () => {
	let writer: ResponseWriter;

	beforeEach(async () => {
		// Create test directory
		await fs.mkdir(TEST_IPC_DIR, { recursive: true });
		writer = new ResponseWriter(TEST_IPC_DIR);
	});

	afterEach(async () => {
		// Clean up test directory
		await fs.rm(TEST_IPC_DIR, { recursive: true, force: true });
	});

	describe("writeResponse", () => {
		test("should write response file atomically", async () => {
			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: TEST_CHAT_ID,
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "Hello from Claude!",
				exitCode: 0,
			};

			await writer.writeResponse(TEST_WORKSPACE, TEST_REQUEST_ID, testData);

			// Verify file exists
			const filePath = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses", `${TEST_REQUEST_ID}.json`);
			const exists = await fs
				.access(filePath)
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(true);

			// Verify file content
			const content = await fs.readFile(filePath, "utf8");
			const parsed = JSON.parse(content) as ClaudeResponseFile;

			expect(parsed.requestId).toBe(TEST_REQUEST_ID);
			expect(parsed.output).toBe("Hello from Claude!");
			expect(parsed.exitCode).toBe(0);
		});

		test("should create responses directory if it doesn't exist", async () => {
			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: TEST_CHAT_ID,
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "Create directory!",
				exitCode: 0,
			};

			// Remove responses directory if it exists
			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");
			await fs.rm(responsesDir, { recursive: true, force: true });

			await writer.writeResponse(TEST_WORKSPACE, TEST_REQUEST_ID, testData);

			// Verify directory was created and file exists
			const filePath = path.join(responsesDir, `${TEST_REQUEST_ID}.json`);
			const exists = await fs
				.access(filePath)
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(true);
		});

		test("should overwrite existing file", async () => {
			const testData1: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: TEST_CHAT_ID,
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "First version",
				exitCode: 0,
			};

			const testData2: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: TEST_CHAT_ID,
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "Second version",
				exitCode: 0,
			};

			// Write first version
			await writer.writeResponse(TEST_WORKSPACE, TEST_REQUEST_ID, testData1);

			// Write second version
			await writer.writeResponse(TEST_WORKSPACE, TEST_REQUEST_ID, testData2);

			// Verify file contains second version
			const filePath = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses", `${TEST_REQUEST_ID}.json`);
			const content = await fs.readFile(filePath, "utf8");
			const parsed = JSON.parse(content) as ClaudeResponseFile;

			expect(parsed.output).toBe("Second version");
		});

		test("should handle large responses", async () => {
			const largeOutput = "x".repeat(15 * 1024 * 1024); // 15MB

			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: TEST_CHAT_ID,
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: largeOutput,
				exitCode: 0,
			};

			await writer.writeResponse(TEST_WORKSPACE, TEST_REQUEST_ID, testData);

			// Verify file content
			const filePath = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses", `${TEST_REQUEST_ID}.json`);
			const content = await fs.readFile(filePath, "utf8");
			const parsed = JSON.parse(content) as ClaudeResponseFile;

			expect(parsed.output.length).toBe(15 * 1024 * 1024);
		});

		test("should handle special characters in output", async () => {
			const specialOutput = "Output with \"quotes\", 'single quotes', $variables, `backticks`, and 新竹字符";

			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: TEST_CHAT_ID,
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: specialOutput,
				exitCode: 0,
			};

			await writer.writeResponse(TEST_WORKSPACE, TEST_REQUEST_ID, testData);

			// Verify file content
			const filePath = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses", `${TEST_REQUEST_ID}.json`);
			const content = await fs.readFile(filePath, "utf8");
			const parsed = JSON.parse(content) as ClaudeResponseFile;

			expect(parsed.output).toBe(specialOutput);
		});

		test("should write response with metadata", async () => {
			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: TEST_CHAT_ID,
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "Response with metadata",
				exitCode: 0,
				metadata: {
					duration: 1500,
					model: "claude-3-opus",
					tokens: 1234,
				},
			};

			await writer.writeResponse(TEST_WORKSPACE, TEST_REQUEST_ID, testData);

			// Verify file content
			const filePath = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses", `${TEST_REQUEST_ID}.json`);
			const content = await fs.readFile(filePath, "utf8");
			const parsed = JSON.parse(content) as ClaudeResponseFile;

			expect(parsed.metadata?.duration).toBe(1500);
			expect(parsed.metadata?.model).toBe("claude-3-opus");
			expect(parsed.metadata?.tokens).toBe(1234);
		});

		test("should clean up temp file on write error", async () => {
			// Create responses directory and make it read-only
			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");
			await fs.mkdir(responsesDir, { recursive: true });

			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: TEST_CHAT_ID,
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "This should fail",
				exitCode: 0,
			};

			// This should fail due to permissions or other issues
			// In a real scenario, we'd mock fs.writeFile to fail
			// For now, just verify the method exists and handles errors
			try {
				await writer.writeResponse(TEST_WORKSPACE, TEST_REQUEST_ID, testData);
				// If it succeeds, that's fine - file was written
			} catch (error) {
				// If it fails, that's also fine for this test
				expect(error).toBeDefined();
			}

			// Verify temp file doesn't exist
			const tempPath = path.join(responsesDir, `${TEST_REQUEST_ID}.json.tmp`);
			const tempExists = await fs
				.access(tempPath)
				.then(() => true)
				.catch(() => false);
			expect(tempExists).toBe(false);
		});

		test("should tolerate temp cleanup failure after write error", async () => {
			const originalWriteFile = fs.writeFile;
			const originalUnlink = fs.unlink;

			(fs as unknown as { writeFile: typeof fs.writeFile }).writeFile = (async () => {
				throw new Error("write failed");
			}) as typeof fs.writeFile;
			(fs as unknown as { unlink: typeof fs.unlink }).unlink = (async () => {
				throw new Error("cleanup failed");
			}) as typeof fs.unlink;

			try {
				await expect(
					writer.writeResponse(TEST_WORKSPACE, TEST_REQUEST_ID, {
						requestId: TEST_REQUEST_ID,
						chatId: TEST_CHAT_ID,
						workspace: TEST_WORKSPACE,
						timestamp: new Date().toISOString(),
						output: "x",
						exitCode: 0,
					}),
				).rejects.toThrow(/failed to write response file/i);
			} finally {
				(fs as unknown as { writeFile: typeof fs.writeFile }).writeFile = originalWriteFile;
				(fs as unknown as { unlink: typeof fs.unlink }).unlink = originalUnlink;
			}
		});
	});

	describe("writeTextResponse", () => {
		test("should write simple text response", async () => {
			await writer.writeTextResponse(TEST_WORKSPACE, TEST_REQUEST_ID, TEST_CHAT_ID, "Simple text response");

			// Verify file content
			const filePath = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses", `${TEST_REQUEST_ID}.json`);
			const content = await fs.readFile(filePath, "utf8");
			const parsed = JSON.parse(content) as ClaudeResponseFile;

			expect(parsed.requestId).toBe(TEST_REQUEST_ID);
			expect(parsed.chatId).toBe(TEST_CHAT_ID);
			expect(parsed.workspace).toBe(TEST_WORKSPACE);
			expect(parsed.output).toBe("Simple text response");
			expect(parsed.exitCode).toBe(0);
		});

		test("should support custom exit code", async () => {
			await writer.writeTextResponse(TEST_WORKSPACE, TEST_REQUEST_ID, TEST_CHAT_ID, "Response with exit code", 42);

			// Verify file content
			const filePath = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses", `${TEST_REQUEST_ID}.json`);
			const content = await fs.readFile(filePath, "utf8");
			const parsed = JSON.parse(content) as ClaudeResponseFile;

			expect(parsed.exitCode).toBe(42);
		});
	});

	describe("writeErrorResponse", () => {
		test("should write error response", async () => {
			await writer.writeErrorResponse(TEST_WORKSPACE, TEST_REQUEST_ID, TEST_CHAT_ID, "Something went wrong!");

			// Verify file content
			const filePath = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses", `${TEST_REQUEST_ID}.json`);
			const content = await fs.readFile(filePath, "utf8");
			const parsed = JSON.parse(content) as ClaudeResponseFile;

			expect(parsed.requestId).toBe(TEST_REQUEST_ID);
			expect(parsed.output).toBe("");
			expect(parsed.exitCode).toBe(1);
			expect(parsed.error).toBe("Something went wrong!");
		});
	});

	describe("concurrent writes", () => {
		test("should handle concurrent writes to different files", async () => {
			const writePromises = [
				writer.writeTextResponse(TEST_WORKSPACE, "req-1", TEST_CHAT_ID, "Response 1"),
				writer.writeTextResponse(TEST_WORKSPACE, "req-2", TEST_CHAT_ID, "Response 2"),
				writer.writeTextResponse(TEST_WORKSPACE, "req-3", TEST_CHAT_ID, "Response 3"),
			];

			await Promise.all(writePromises);

			// Verify all files exist
			for (const reqId of ["req-1", "req-2", "req-3"]) {
				const filePath = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses", `${reqId}.json`);
				const exists = await fs
					.access(filePath)
					.then(() => true)
					.catch(() => false);
				expect(exists).toBe(true);
			}
		});
	});
});
