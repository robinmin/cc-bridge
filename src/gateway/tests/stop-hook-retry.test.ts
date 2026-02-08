import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ResponseFile } from "@/gateway/schemas/callback";

// Helper to run the stop hook script
async function runStopHook(env: Record<string, string>): Promise<{
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}> {
	return new Promise((resolve, reject) => {
		const proc = spawn("bash", ["scripts/stop-hook.sh"], {
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		if (proc.stdout) {
			proc.stdout.on("data", (data) => {
				stdout += data.toString();
			});
		}

		if (proc.stderr) {
			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});
		}

		proc.on("close", (code, signal) => {
			resolve({ exitCode: code, signal, stdout, stderr });
		});

		proc.on("error", (err) => {
			reject(err);
		});
	});
}

// Helper to read response file
async function readResponseFile(workspace: string, requestId: string): Promise<ResponseFile | null> {
	const testIpcDir = process.env.TEST_IPC_DIR || "./data/test-ipc";
	const responsePath = path.join(testIpcDir, workspace, "responses", `${requestId}.json`);

	if (!existsSync(responsePath)) {
		return null;
	}

	const content = await Bun.file(responsePath).text();
	return JSON.parse(content);
}

// Mock server helper
class MockCallbackServer {
	private server: import("http").Server | null = null;
	private port: number;
	private responses: Array<() => number> = [];
	private requestCount = 0;

	constructor(port: number) {
		this.port = port;
	}

	async start() {
		const http = await import("node:http");
		this.server = http.createServer((_req, res) => {
			const responseCode = this.responses[this.requestCount] || 200;
			this.requestCount++;

			// Set headers
			res.setHeader("Content-Type", "application/json");

			// Send response
			res.writeHead(responseCode);
			res.end(JSON.stringify({ success: responseCode < 400 }));
		});

		await new Promise<void>((resolve) => {
			this.server.listen(this.port, resolve);
		});
	}

	async stop() {
		if (this.server) {
			await new Promise<void>((resolve) => {
				this.server.close(resolve);
			});
		}
	}

	setResponses(responses: number[]) {
		this.responses = responses;
	}

	getRequestCount(): number {
		return this.requestCount;
	}
}

describe("Stop Hook Retry Logic", () => {
	let testIpcDir: string;
	let mockServer: MockCallbackServer;

	beforeEach(async () => {
		testIpcDir = process.env.TEST_IPC_DIR || "./data/test-ipc";

		// Clean up test directory
		if (existsSync(testIpcDir)) {
			await rm(testIpcDir, { recursive: true, force: true });
		}

		// Create test directory structure
		await mkdir(path.join(testIpcDir, "cc-bridge", "responses"), {
			recursive: true,
		});

		// Start mock callback server
		mockServer = new MockCallbackServer(18888);
		await mockServer.start();
	});

	afterEach(async () => {
		await mockServer.stop();

		// Clean up test directory
		if (existsSync(testIpcDir)) {
			await rm(testIpcDir, { recursive: true, force: true });
		}
	});

	test("should write response file with callback metadata on success", async () => {
		mockServer.setResponses([200]); // Success on first try

		const result = await runStopHook({
			TEST_IPC_DIR: testIpcDir,
			REQUEST_ID: "test-success-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_CALLBACK_URL: "http://localhost:18888/callback",
			CLAUDE_OUTPUT: "Hello World",
			CLAUDE_EXIT_CODE: "0",
			CLAUDE_STDERR: "",
		});

		expect(result.exitCode).toBe(0);
		expect(mockServer.getRequestCount()).toBe(1);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-success-001");
		expect(response).not.toBeNull();
		expect(response.callback?.success).toBe(true);
		expect(response.callback?.attempts).toBe(1);
		expect(response.callback?.retryTimestamps).toHaveLength(1);
		expect(response.output).toBe("Hello World");
	});

	test("should retry on network error (000 status)", async () => {
		// First 2 requests fail (connection refused), 3rd succeeds
		// We'll simulate this by having the mock server return 500 twice then 200
		mockServer.setResponses([500, 500, 200]);

		const startTime = Date.now();

		const result = await runStopHook({
			TEST_IPC_DIR: testIpcDir,
			REQUEST_ID: "test-retry-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_CALLBACK_URL: "http://localhost:18888/callback",
			CLAUDE_OUTPUT: "Retry test",
			CLAUDE_EXIT_CODE: "0",
			CLAUDE_STDERR: "",
		});

		const elapsed = Date.now() - startTime;

		expect(result.exitCode).toBe(0);
		expect(mockServer.getRequestCount()).toBe(3);
		// Should have waited for backoff: ~1s + ~2s = ~3s
		expect(elapsed).toBeGreaterThan(2500);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-retry-001");
		expect(response).not.toBeNull();
		expect(response.callback?.success).toBe(true);
		expect(response.callback?.attempts).toBe(3);
		expect(response.callback?.retryTimestamps).toHaveLength(3);
	});

	test("should not retry on client error (4xx)", async () => {
		mockServer.setResponses([400]); // Client error - should not retry

		const startTime = Date.now();

		const result = await runStopHook({
			TEST_IPC_DIR: testIpcDir,
			REQUEST_ID: "test-4xx-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_CALLBACK_URL: "http://localhost:18888/callback",
			CLAUDE_OUTPUT: "Client error test",
			CLAUDE_EXIT_CODE: "0",
			CLAUDE_STDERR: "",
		});

		const elapsed = Date.now() - startTime;

		// Should exit 0 even though callback failed (offline mode)
		expect(result.exitCode).toBe(0);
		// Should have made only 1 attempt (no retry for 4xx)
		expect(mockServer.getRequestCount()).toBe(1);
		// Should be fast (no retries)
		expect(elapsed).toBeLessThan(1000);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-4xx-001");
		expect(response).not.toBeNull();
		expect(response.callback?.success).toBe(false);
		expect(response.callback?.attempts).toBe(1);
		expect(response.callback?.error).toContain("client_error");
		expect(response.output).toBe("Client error test");
	});

	test("should enter offline mode after all retries fail", async () => {
		mockServer.setResponses([500, 500, 500]); // All server errors

		const startTime = Date.now();

		const result = await runStopHook({
			TEST_IPC_DIR: testIpcDir,
			REQUEST_ID: "test-offline-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_CALLBACK_URL: "http://localhost:18888/callback",
			CLAUDE_OUTPUT: "Offline mode test",
			CLAUDE_EXIT_CODE: "0",
			CLAUDE_STDERR: "",
		});

		const _elapsed = Date.now() - startTime;

		// Should exit 0 even though all retries failed (offline mode)
		expect(result.exitCode).toBe(0);
		expect(mockServer.getRequestCount()).toBe(3);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-offline-001");
		expect(response).not.toBeNull();
		expect(response.callback?.success).toBe(false);
		expect(response.callback?.attempts).toBe(3);
		expect(response.callback?.error).toContain("server_error");
		expect(response.output).toBe("Offline mode test");
	});

	test("should handle missing callback URL gracefully", async () => {
		const result = await runStopHook({
			TEST_IPC_DIR: testIpcDir,
			REQUEST_ID: "test-no-callback-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_CALLBACK_URL: "", // Empty callback URL
			CLAUDE_OUTPUT: "No callback test",
			CLAUDE_EXIT_CODE: "0",
			CLAUDE_STDERR: "",
		});

		expect(result.exitCode).toBe(0);
		expect(mockServer.getRequestCount()).toBe(0);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-no-callback-001");
		expect(response).not.toBeNull();
		expect(response.callback?.success).toBe(false);
		expect(response.callback?.attempts).toBe(0);
		expect(response.callback?.error).toContain("No callback URL");
	});

	test("should validate required environment variables", async () => {
		// Missing REQUEST_ID
		let result = await runStopHook({
			TEST_IPC_DIR: testIpcDir,
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_CALLBACK_URL: "http://localhost:18888/callback",
			CLAUDE_OUTPUT: "Test",
			CLAUDE_EXIT_CODE: "0",
		});

		expect(result.exitCode).toBe(1);

		// Missing CHAT_ID
		result = await runStopHook({
			TEST_IPC_DIR: testIpcDir,
			REQUEST_ID: "test-002",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_CALLBACK_URL: "http://localhost:18888/callback",
			CLAUDE_OUTPUT: "Test",
			CLAUDE_EXIT_CODE: "0",
		});

		expect(result.exitCode).toBe(1);

		// Missing WORKSPACE_NAME
		result = await runStopHook({
			TEST_IPC_DIR: testIpcDir,
			REQUEST_ID: "test-003",
			CHAT_ID: "123456",
			GATEWAY_CALLBACK_URL: "http://localhost:18888/callback",
			CLAUDE_OUTPUT: "Test",
			CLAUDE_EXIT_CODE: "0",
		});

		expect(result.exitCode).toBe(1);
	});

	test("should handle timeout errors (408, 504)", async () => {
		mockServer.setResponses([508, 200]); // First times out, second succeeds

		const result = await runStopHook({
			TEST_IPC_DIR: testIpcDir,
			REQUEST_ID: "test-timeout-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_CALLBACK_URL: "http://localhost:18888/callback",
			CLAUDE_OUTPUT: "Timeout test",
			CLAUDE_EXIT_CODE: "0",
			CLAUDE_STDERR: "",
		});

		expect(result.exitCode).toBe(0);
		expect(mockServer.getRequestCount()).toBe(2);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-timeout-001");
		expect(response).not.toBeNull();
		expect(response.callback?.success).toBe(true);
		expect(response.callback?.attempts).toBe(2);
	});

	test("should include error output when present", async () => {
		mockServer.setResponses([200]);

		const result = await runStopHook({
			TEST_IPC_DIR: testIpcDir,
			REQUEST_ID: "test-error-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_CALLBACK_URL: "http://localhost:18888/callback",
			CLAUDE_OUTPUT: "Some output",
			CLAUDE_EXIT_CODE: "1",
			CLAUDE_STDERR: "Error: Something went wrong",
		});

		expect(result.exitCode).toBe(0);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-error-001");
		expect(response).not.toBeNull();
		expect(response.exitCode).toBe(1);
		expect(response.error).toBe("Error: Something went wrong");
	});

	test("should record retry timestamps", async () => {
		mockServer.setResponses([500, 500, 200]);

		const result = await runStopHook({
			TEST_IPC_DIR: testIpcDir,
			REQUEST_ID: "test-timestamps-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_CALLBACK_URL: "http://localhost:18888/callback",
			CLAUDE_OUTPUT: "Timestamp test",
			CLAUDE_EXIT_CODE: "0",
			CLAUDE_STDERR: "",
		});

		expect(result.exitCode).toBe(0);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-timestamps-001");
		expect(response).not.toBeNull();
		expect(response.callback?.retryTimestamps).toHaveLength(3);

		// Verify timestamps are valid ISO dates
		const timestamps = response.callback?.retryTimestamps || [];
		for (const ts of timestamps) {
			expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
		}
	});
});
