import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { type ClaudeResponseFile, FileSystemIpc } from "@/gateway/services/filesystem-ipc";

// Test directory
const TEST_IPC_DIR = "./test-data/ipc";
const TEST_WORKSPACE = "test-workspace";
const TEST_REQUEST_ID = "test-req-001";

describe("FileSystemIpc", () => {
	let ipc: FileSystemIpc;
	let _cleanupCalled: number;

	beforeEach(async () => {
		// Create test directory
		await fs.mkdir(TEST_IPC_DIR, { recursive: true });

		// Create IPC instance without automatic cleanup
		ipc = new FileSystemIpc({
			baseDir: TEST_IPC_DIR,
			responseTimeout: 2000,
			cleanupInterval: 0, // Disable auto cleanup
			fileTtl: 1000,
		});

		// Track cleanup calls
		_cleanupCalled = 0;
		const originalCleanup = ipc.cleanupOrphanedFiles.bind(ipc);
		ipc.cleanupOrphanedFiles = async () => {
			_cleanupCalled++;
			return originalCleanup();
		};
	});

	afterEach(async () => {
		// Stop cleanup timer
		ipc.stopCleanup();

		// Clean up test directory
		await fs.rm(TEST_IPC_DIR, { recursive: true, force: true });
	});

	describe("readResponse", () => {
		test("should read existing response file successfully", async () => {
			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: "123",
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "Hello from Claude!",
				exitCode: 0,
			};

			// Write test file
			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");
			await fs.mkdir(responsesDir, { recursive: true });
			await fs.writeFile(path.join(responsesDir, `${TEST_REQUEST_ID}.json`), JSON.stringify(testData, null, 2), "utf8");

			// Read response
			const response = await ipc.readResponse(TEST_WORKSPACE, TEST_REQUEST_ID);

			expect(response.requestId).toBe(TEST_REQUEST_ID);
			expect(response.output).toBe("Hello from Claude!");
			expect(response.exitCode).toBe(0);
		});

		test("should retry when file does not exist initially", async () => {
			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: "123",
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "Delayed response!",
				exitCode: 0,
			};

			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");

			// Start read (file doesn't exist yet)
			const readPromise = ipc.readResponse(TEST_WORKSPACE, TEST_REQUEST_ID);

			// Write file after 500ms
			setTimeout(async () => {
				await fs.mkdir(responsesDir, { recursive: true });
				await fs.writeFile(
					path.join(responsesDir, `${TEST_REQUEST_ID}.json`),
					JSON.stringify(testData, null, 2),
					"utf8",
				);
			}, 500);

			// Should successfully read after retry
			const response = await readPromise;
			expect(response.requestId).toBe(TEST_REQUEST_ID);
			expect(response.output).toBe("Delayed response!");
		});

		test("should timeout when file never appears", async () => {
			await expect(ipc.readResponse(TEST_WORKSPACE, "non-existent-request")).rejects.toThrow(
				"Response file not found after 2000ms",
			);
		});

		test("should reject invalid JSON structure", async () => {
			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");
			await fs.mkdir(responsesDir, { recursive: true });

			// Write invalid JSON
			await fs.writeFile(path.join(responsesDir, `${TEST_REQUEST_ID}.json`), "invalid json{", "utf8");

			// Should retry and eventually timeout
			await expect(ipc.readResponse(TEST_WORKSPACE, TEST_REQUEST_ID)).rejects.toThrow();
		});

		test("should reject response missing required fields", async () => {
			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");
			await fs.mkdir(responsesDir, { recursive: true });

			// Write incomplete response
			await fs.writeFile(
				path.join(responsesDir, `${TEST_REQUEST_ID}.json`),
				JSON.stringify({ requestId: TEST_REQUEST_ID }), // Missing 'output'
				"utf8",
			);

			await expect(ipc.readResponse(TEST_WORKSPACE, TEST_REQUEST_ID)).rejects.toThrow(
				"Invalid response file structure",
			);
		});
	});

	describe("deleteResponse", () => {
		test("should delete existing response file", async () => {
			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: "123",
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "Delete me!",
				exitCode: 0,
			};

			// Write test file
			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");
			await fs.mkdir(responsesDir, { recursive: true });
			const filePath = path.join(responsesDir, `${TEST_REQUEST_ID}.json`);
			await fs.writeFile(filePath, JSON.stringify(testData, null, 2), "utf8");

			// Verify file exists
			expect(await ipc.responseExists(TEST_WORKSPACE, TEST_REQUEST_ID)).toBe(true);

			// Delete file
			await ipc.deleteResponse(TEST_WORKSPACE, TEST_REQUEST_ID);

			// Verify file is gone
			expect(await ipc.responseExists(TEST_WORKSPACE, TEST_REQUEST_ID)).toBe(false);
		});

		test("should not throw when deleting non-existent file", async () => {
			// Should not throw
			await ipc.deleteResponse(TEST_WORKSPACE, "non-existent-request");
		});
	});

	describe("responseExists", () => {
		test("should return true for existing file", async () => {
			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: "123",
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "Exists!",
				exitCode: 0,
			};

			// Write test file
			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");
			await fs.mkdir(responsesDir, { recursive: true });
			await fs.writeFile(path.join(responsesDir, `${TEST_REQUEST_ID}.json`), JSON.stringify(testData, null, 2), "utf8");

			expect(await ipc.responseExists(TEST_WORKSPACE, TEST_REQUEST_ID)).toBe(true);
		});

		test("should return false for non-existent file", async () => {
			expect(await ipc.responseExists(TEST_WORKSPACE, "non-existent")).toBe(false);
		});
	});

	describe("readAndDeleteResponse", () => {
		test("should read and delete response atomically", async () => {
			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: "123",
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "Read and delete!",
				exitCode: 0,
			};

			// Write test file
			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");
			await fs.mkdir(responsesDir, { recursive: true });
			await fs.writeFile(path.join(responsesDir, `${TEST_REQUEST_ID}.json`), JSON.stringify(testData, null, 2), "utf8");

			// Read and delete
			const response = await ipc.readAndDeleteResponse(TEST_WORKSPACE, TEST_REQUEST_ID);

			expect(response.output).toBe("Read and delete!");
			expect(await ipc.responseExists(TEST_WORKSPACE, TEST_REQUEST_ID)).toBe(false);
		});
	});

	describe("cleanupOrphanedFiles", () => {
		test("should clean up files older than TTL", async () => {
			const testData: ClaudeResponseFile = {
				requestId: "old-request",
				chatId: "123",
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "Old response",
				exitCode: 0,
			};

			// Write test file
			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");
			await fs.mkdir(responsesDir, { recursive: true });
			const filePath = path.join(responsesDir, "old-request.json");
			await fs.writeFile(filePath, JSON.stringify(testData, null, 2), "utf8");

			// Set file mtime to 2 seconds ago to ensure it's old enough
			// (TTL is 1000ms = 1 second)
			const oldTime = new Date(Date.now() - 2000);
			await fs.utimes(filePath, oldTime, oldTime);

			// Run cleanup
			const cleaned = await ipc.cleanupOrphanedFiles();

			expect(cleaned).toBe(1);
			expect(await ipc.responseExists(TEST_WORKSPACE, "old-request")).toBe(false);
		});

		test("should not delete recent files", async () => {
			const testData: ClaudeResponseFile = {
				requestId: "recent-request",
				chatId: "123",
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "Recent response",
				exitCode: 0,
			};

			// Write test file
			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");
			await fs.mkdir(responsesDir, { recursive: true });
			await fs.writeFile(path.join(responsesDir, "recent-request.json"), JSON.stringify(testData, null, 2), "utf8");

			// Run cleanup immediately
			const cleaned = await ipc.cleanupOrphanedFiles();

			expect(cleaned).toBe(0);
			expect(await ipc.responseExists(TEST_WORKSPACE, "recent-request")).toBe(true);
		});
	});

	describe("concurrent reads", () => {
		test("should handle concurrent reads of same file", async () => {
			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: "123",
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: "Concurrent read!",
				exitCode: 0,
			};

			// Write test file
			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");
			await fs.mkdir(responsesDir, { recursive: true });
			await fs.writeFile(path.join(responsesDir, `${TEST_REQUEST_ID}.json`), JSON.stringify(testData, null, 2), "utf8");

			// Multiple concurrent reads
			const reads = [
				ipc.readResponse(TEST_WORKSPACE, TEST_REQUEST_ID),
				ipc.readResponse(TEST_WORKSPACE, TEST_REQUEST_ID),
				ipc.readResponse(TEST_WORKSPACE, TEST_REQUEST_ID),
			];

			const responses = await Promise.all(reads);

			expect(responses.length).toBe(3);
			expect(responses[0].requestId).toBe(TEST_REQUEST_ID);
			expect(responses[1].requestId).toBe(TEST_REQUEST_ID);
			expect(responses[2].requestId).toBe(TEST_REQUEST_ID);
		});
	});

	describe("large response handling", () => {
		test("should handle large responses (>10MB)", async () => {
			const largeOutput = "x".repeat(15 * 1024 * 1024); // 15MB

			const testData: ClaudeResponseFile = {
				requestId: TEST_REQUEST_ID,
				chatId: "123",
				workspace: TEST_WORKSPACE,
				timestamp: new Date().toISOString(),
				output: largeOutput,
				exitCode: 0,
			};

			// Write test file
			const responsesDir = path.join(TEST_IPC_DIR, TEST_WORKSPACE, "responses");
			await fs.mkdir(responsesDir, { recursive: true });
			await fs.writeFile(path.join(responsesDir, `${TEST_REQUEST_ID}.json`), JSON.stringify(testData, null, 2), "utf8");

			// Read response
			const response = await ipc.readResponse(TEST_WORKSPACE, TEST_REQUEST_ID);

			expect(response.output.length).toBe(15 * 1024 * 1024);
		});
	});

	describe("lifecycle", () => {
		test("should destroy service and expose destroyed state", () => {
			expect(ipc.isDestroyed()).toBe(false);
			ipc.destroy();
			expect(ipc.isDestroyed()).toBe(true);

			// Idempotent destroy
			expect(() => ipc.destroy()).not.toThrow();
		});

		test("should execute periodic cleanup callback and swallow cleanup errors", async () => {
			const fast = new FileSystemIpc({
				baseDir: TEST_IPC_DIR,
				responseTimeout: 200,
				cleanupInterval: 5,
				fileTtl: 1000,
			});

			let invoked = 0;
			fast.cleanupOrphanedFiles = async () => {
				invoked++;
				throw new Error("forced cleanup failure");
			};

			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(invoked).toBeGreaterThan(0);

			fast.destroy();
		});
	});
});
