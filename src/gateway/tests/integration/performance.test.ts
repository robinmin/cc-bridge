import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, utimes } from "node:fs/promises";
import path from "node:path";
import { FileSystemIpc } from "@/gateway/services/filesystem-ipc";

describe("Performance Benchmarks", () => {
	let testIpcDir: string;
	let fileSystemIpc: FileSystemIpc;

	beforeEach(async () => {
		testIpcDir = process.env.TEST_IPC_DIR || "./data/test-ipc";
		if (existsSync(testIpcDir)) {
			await rm(testIpcDir, { recursive: true, force: true });
		}

		fileSystemIpc = new FileSystemIpc({
			baseDir: testIpcDir,
			responseTimeout: 5000,
			cleanupInterval: 60000,
		});
	});

	afterEach(async () => {
		if (existsSync(testIpcDir)) {
			await rm(testIpcDir, { recursive: true, force: true });
		}
	});

	test("should write and read response file in <100ms", async () => {
		const requestId = randomUUID();
		const workspace = "test-workspace";
		const output = "Test response content";

		const writeStart = performance.now();

		// Write response file
		const responseDir = path.join(testIpcDir, workspace, "responses");
		await Bun.write(
			path.join(responseDir, `${requestId}.json`),
			JSON.stringify({
				requestId,
				chatId: "test",
				workspace,
				timestamp: new Date().toISOString(),
				output,
				exitCode: 0,
			}),
		);

		const writeTime = performance.now() - writeStart;

		const readStart = performance.now();

		// Read response file
		const response = await fileSystemIpc.readResponse(workspace, requestId);

		const readTime = performance.now() - readStart;
		const totalTime = writeTime + readTime;

		expect(response).toBeDefined();
		expect(response?.output).toBe(output);

		console.log(`  Write time: ${writeTime.toFixed(2)}ms`);
		console.log(`  Read time: ${readTime.toFixed(2)}ms`);
		console.log(`  Total time: ${totalTime.toFixed(2)}ms`);

		expect(totalTime).toBeLessThan(100); // Should complete in <100ms
	});

	test("should handle 100 sequential file operations efficiently", async () => {
		const workspace = "bench-workspace";
		const latencies: number[] = [];

		// Create 100 response files
		for (let i = 0; i < 100; i++) {
			const requestId = randomUUID();
			const start = performance.now();

			const responseDir = path.join(testIpcDir, workspace, "responses");
			await Bun.write(
				path.join(responseDir, `${requestId}.json`),
				JSON.stringify({
					requestId,
					chatId: "test",
					workspace,
					timestamp: new Date().toISOString(),
					output: `Response ${i}`,
					exitCode: 0,
				}),
			);

			latencies.push(performance.now() - start);
		}

		const avgLatency = latencies.reduce((a, b) => a + b) / latencies.length;
		const maxLatency = Math.max(...latencies);
		const minLatency = Math.min(...latencies);
		const totalTime = latencies.reduce((a, b) => a + b);

		console.log(`  Average: ${avgLatency.toFixed(2)}ms`);
		console.log(`  Min: ${minLatency.toFixed(2)}ms`);
		console.log(`  Max: ${maxLatency.toFixed(2)}ms`);
		console.log(`  Total: ${totalTime.toFixed(2)}ms`);

		// Average should be under 10ms per file
		expect(avgLatency).toBeLessThan(10);
		// Max should be under 50ms (no significant spikes)
		expect(maxLatency).toBeLessThan(50);
	});

	test("should handle 50 concurrent file reads efficiently", async () => {
		const workspace = "concurrent-workspace";

		// Pre-create 50 response files
		const requestIds: string[] = [];
		for (let i = 0; i < 50; i++) {
			const requestId = randomUUID();
			requestIds.push(requestId);

			const responseDir = path.join(testIpcDir, workspace, "responses");
			await Bun.write(
				path.join(responseDir, `${requestId}.json`),
				JSON.stringify({
					requestId,
					chatId: "test",
					workspace,
					timestamp: new Date().toISOString(),
					output: `Concurrent response ${i}`,
					exitCode: 0,
				}),
			);
		}

		// Read all concurrently
		const start = performance.now();

		const results = await Promise.all(requestIds.map((id) => fileSystemIpc.readResponse(workspace, id)));

		const totalTime = performance.now() - start;
		const avgTime = totalTime / results.length;

		console.log(`  Total time: ${totalTime.toFixed(2)}ms`);
		console.log(`  Average per read: ${avgTime.toFixed(2)}ms`);

		// All should succeed
		expect(results.every((r) => r !== null)).toBe(true);

		// Concurrent reads should be faster than sequential
		expect(totalTime).toBeLessThan(500); // 50 reads in <500ms
	});

	test("should generate unique request IDs efficiently", async () => {
		const ids = new Set<string>();
		const latencies: number[] = [];

		// Generate 1000 request IDs
		for (let i = 0; i < 1000; i++) {
			const start = performance.now();
			const id = randomUUID();
			latencies.push(performance.now() - start);
			ids.add(id);
		}

		const avgLatency = latencies.reduce((a, b) => a + b) / latencies.length;
		const maxLatency = Math.max(...latencies);

		console.log(`  Average UUID generation: ${avgLatency.toFixed(3)}ms`);
		console.log(`  Max UUID generation: ${maxLatency.toFixed(3)}ms`);

		// All should be unique
		expect(ids.size).toBe(1000);

		// UUID generation should be very fast
		expect(avgLatency).toBeLessThan(1);
	});

	test("should clean up old files efficiently", async () => {
		// Create a FileSystemIpc with short TTL for testing
		const shortTtlIpc = new FileSystemIpc({
			baseDir: testIpcDir,
			responseTimeout: 5000,
			cleanupInterval: 60000,
			fileTtl: 1000, // 1 second TTL
		});

		const workspace = "cleanup-workspace";

		// Create 100 response files
		const requestIds: string[] = [];
		for (let i = 0; i < 100; i++) {
			const requestId = randomUUID();
			requestIds.push(requestId);

			const responseDir = path.join(testIpcDir, workspace, "responses");
			const filePath = path.join(responseDir, `${requestId}.json`);
			await Bun.write(
				filePath,
				JSON.stringify({
					requestId,
					chatId: "test",
					workspace,
					timestamp: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
					output: `Old response ${i}`,
					exitCode: 0,
				}),
			);

			// Set file mtime to make it old (2 seconds ago)
			const oldTime = Date.now() - 2000;
			await utimes(filePath, oldTime / 1000, oldTime / 1000);
		}

		// Wait a bit to ensure files are considered old
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Measure cleanup time
		const start = performance.now();

		const cleanedCount = await shortTtlIpc.cleanupOrphanedFiles();

		const cleanupTime = performance.now() - start;

		console.log(`  Cleaned ${cleanedCount} files in ${cleanupTime.toFixed(2)}ms`);
		if (cleanedCount > 0) {
			console.log(`  Average per file: ${(cleanupTime / cleanedCount).toFixed(2)}ms`);
		}

		// All files should be cleaned up
		expect(cleanedCount).toBe(100);
		// Cleanup should be fast
		expect(cleanupTime).toBeLessThan(1000);
	});

	test("should handle large response files efficiently", async () => {
		const workspace = "large-workspace";
		const requestId = randomUUID();

		// Create a large response (simulating Claude output with lots of tool use)
		const largeOutput = "x".repeat(100000); // 100KB of text
		const responseDir = path.join(testIpcDir, workspace, "responses");
		const filePath = path.join(responseDir, `${requestId}.json`);

		const writeStart = performance.now();

		await Bun.write(
			filePath,
			JSON.stringify({
				requestId,
				chatId: "test",
				workspace,
				timestamp: new Date().toISOString(),
				output: largeOutput,
				exitCode: 0,
			}),
		);

		const writeTime = performance.now() - writeStart;

		const readStart = performance.now();

		const response = await fileSystemIpc.readResponse(workspace, requestId);

		const readTime = performance.now() - readStart;
		const totalTime = writeTime + readTime;

		console.log(`  File size: ${(largeOutput.length / 1024).toFixed(2)}KB`);
		console.log(`  Write time: ${writeTime.toFixed(2)}ms`);
		console.log(`  Read time: ${readTime.toFixed(2)}ms`);
		console.log(`  Total time: ${totalTime.toFixed(2)}ms`);

		expect(response).toBeDefined();
		expect(response?.output.length).toBe(100000);

		// Even large files should be handled quickly
		expect(totalTime).toBeLessThan(500);
	});

	test("should verify session name generation performance", async () => {
		const latencies: number[] = [];

		// Generate 1000 session names
		for (let i = 0; i < 1000; i++) {
			const workspace = `workspace-${i % 10}`;
			const chatId = `${1000 + i}`;

			const start = performance.now();
			// Simulate session name generation logic
			const sessionName = `claude-${workspace}-${chatId}`;
			latencies.push(performance.now() - start);

			expect(sessionName).toMatch(/^claude-[a-z0-9_-]+-\d+$/);
		}

		const avgLatency = latencies.reduce((a, b) => a + b) / latencies.length;

		console.log(`  Average session name generation: ${avgLatency.toFixed(3)}ms`);

		// Session name generation should be extremely fast
		expect(avgLatency).toBeLessThan(0.1);
	});

	test("should measure retry logic overhead", async () => {
		// Use a short timeout for this test
		const shortTimeoutIpc = new FileSystemIpc({
			baseDir: testIpcDir,
			responseTimeout: 500, // 500ms timeout
			cleanupInterval: 60000,
		});

		const workspace = "retry-workspace";
		const nonExistentRequestId = randomUUID();

		// Measure time to fail (with retries)
		const start = performance.now();

		let error: Error | null = null;
		try {
			await shortTimeoutIpc.readResponse(workspace, nonExistentRequestId);
		} catch (e) {
			error = e as Error;
		}

		const totalTime = performance.now() - start;

		console.log(`  Read with retries returned in: ${totalTime.toFixed(2)}ms`);

		expect(error).not.toBeNull();
		// Should return after timeout (500ms + some overhead)
		expect(totalTime).toBeGreaterThan(400);
		expect(totalTime).toBeLessThan(1000);
	});

	test("should validate timeout precision", async () => {
		const shortTimeoutIpc = new FileSystemIpc({
			baseDir: testIpcDir,
			responseTimeout: 300, // 300ms timeout
			cleanupInterval: 60000,
		});

		const requestId = randomUUID();

		const start = performance.now();

		let error: Error | null = null;
		try {
			await shortTimeoutIpc.readResponse("test", requestId);
		} catch (e) {
			error = e as Error;
		}

		const elapsed = performance.now() - start;

		console.log(`  Actual timeout: ${elapsed.toFixed(2)}ms`);
		console.log(`  Configured timeout: 300ms`);

		expect(error).not.toBeNull();
		// Should be close to configured timeout (within 100ms tolerance)
		expect(elapsed).toBeGreaterThan(250);
		expect(elapsed).toBeLessThan(500);
	});
});
