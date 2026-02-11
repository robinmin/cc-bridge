import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ResponseFile } from "@/gateway/schemas/callback";

// Helper to run the response command (replacement for stop-hook.sh)
async function runResponseCommand(env: Record<string, string>): Promise<{
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}> {
	const baseEnv = {
		CALLBACK_SLEEP_BEFORE_SEC: "0",
		CALLBACK_RETRY_DELAY_SEC: "0.1",
		CALLBACK_MAX_TIME_SEC: "1",
		CALLBACK_MAX_RETRIES: "3",
	};

	return new Promise((resolve, reject) => {
		const proc = spawn("bash", ["scripts/container_cmd.sh", "response"], {
			env: { ...process.env, ...baseEnv, ...env },
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

async function writeDataFile(
	ipcDataDir: string,
	workspace: string,
	requestId: string,
	output: string,
	exitCode: number,
	chatId: string,
) {
	const dataDir = path.join(ipcDataDir, workspace);
	await mkdir(dataDir, { recursive: true });
	const dataFile = path.join(dataDir, `${requestId}.json`);
	const payload = {
		claude_output: output,
		exit_code: exitCode,
		chat_id: chatId,
	};
	await Bun.write(dataFile, JSON.stringify(payload));
}

describe("Stop Hook Retry Logic", () => {
	let testIpcDir: string;
	let mockServer: MockCallbackServer;
	let testDataDir: string;

	beforeEach(async () => {
		testIpcDir = process.env.TEST_IPC_DIR || "./data/test-ipc";
		testDataDir = path.join(testIpcDir, "data");

		// Clean up test directory
		if (existsSync(testIpcDir)) {
			await rm(testIpcDir, { recursive: true, force: true });
		}

		// Create test directory structure
		await mkdir(path.join(testIpcDir, "cc-bridge", "responses"), {
			recursive: true,
		});
		await mkdir(testDataDir, { recursive: true });

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

	test("should write response file on success", async () => {
		mockServer.setResponses([200]); // Success on first try
		await writeDataFile(testDataDir, "cc-bridge", "test-success-001", "Hello World", 0, "123456");

		const result = await runResponseCommand({
			IPC_BASE_DIR: testIpcDir,
			IPC_DATA_DIR: testDataDir,
			REQUEST_ID: "test-success-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_URL: "http://localhost:18888",
		});

		expect(result.exitCode).toBe(0);
		expect(mockServer.getRequestCount()).toBe(1);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-success-001");
		expect(response).not.toBeNull();
		expect(response.output).toBe("Hello World");
	});

	test("should retry on network error (000 status)", async () => {
		// First 2 requests fail (connection refused), 3rd succeeds
		// We'll simulate this by having the mock server return 500 twice then 200
		mockServer.setResponses([500, 500, 200]);
		await writeDataFile(testDataDir, "cc-bridge", "test-retry-001", "Retry test", 0, "123456");

		const result = await runResponseCommand({
			IPC_BASE_DIR: testIpcDir,
			IPC_DATA_DIR: testDataDir,
			REQUEST_ID: "test-retry-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_URL: "http://localhost:18888",
		});

		expect(result.exitCode).toBe(0);
		expect(mockServer.getRequestCount()).toBe(3);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-retry-001");
		expect(response).not.toBeNull();
		expect(response.output).toBe("Retry test");
	});

	test("should not retry on client error (4xx)", async () => {
		mockServer.setResponses([400]); // Client error - should not retry
		await writeDataFile(testDataDir, "cc-bridge", "test-4xx-001", "Client error test", 0, "123456");

		const result = await runResponseCommand({
			IPC_BASE_DIR: testIpcDir,
			IPC_DATA_DIR: testDataDir,
			REQUEST_ID: "test-4xx-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_URL: "http://localhost:18888",
		});

		// Should exit 0 even though callback failed (offline mode)
		expect(result.exitCode).toBe(0);
		// Should have made only 1 attempt (no retry for 4xx)
		expect(mockServer.getRequestCount()).toBe(1);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-4xx-001");
		expect(response).not.toBeNull();
		expect(response.output).toBe("Client error test");
	});

	test("should enter offline mode after all retries fail", async () => {
		mockServer.setResponses([500, 500, 500]); // All server errors
		await writeDataFile(testDataDir, "cc-bridge", "test-offline-001", "Offline mode test", 0, "123456");

		const result = await runResponseCommand({
			IPC_BASE_DIR: testIpcDir,
			IPC_DATA_DIR: testDataDir,
			REQUEST_ID: "test-offline-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_URL: "http://localhost:18888",
		});

		// Should exit 0 even though all retries failed (offline mode)
		expect(result.exitCode).toBe(0);
		expect(mockServer.getRequestCount()).toBe(3);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-offline-001");
		expect(response).not.toBeNull();
		expect(response.output).toBe("Offline mode test");
	});

	test("should handle unreachable callback URL gracefully", async () => {
		await writeDataFile(testDataDir, "cc-bridge", "test-no-callback-001", "No callback test", 0, "123456");

		const result = await runResponseCommand({
			IPC_BASE_DIR: testIpcDir,
			IPC_DATA_DIR: testDataDir,
			REQUEST_ID: "test-no-callback-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_URL: "http://localhost:1", // Unreachable
		});

		expect(result.exitCode).toBe(0);
		expect(mockServer.getRequestCount()).toBe(0);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-no-callback-001");
		expect(response).not.toBeNull();
		expect(response.output).toBe("No callback test");
	});

	test("should validate required environment variables", async () => {
		// Missing REQUEST_ID - explicitly set to empty string
		const result = await runResponseCommand({
			IPC_BASE_DIR: testIpcDir,
			IPC_DATA_DIR: testDataDir,
			REQUEST_ID: "", // Explicitly unset
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_URL: "http://localhost:18888",
		});

		expect(result.exitCode).toBe(1);
	});

	test("should handle timeout errors (408, 504)", async () => {
		mockServer.setResponses([508, 200]); // First times out, second succeeds
		await writeDataFile(testDataDir, "cc-bridge", "test-timeout-001", "Timeout test", 0, "123456");

		const result = await runResponseCommand({
			IPC_BASE_DIR: testIpcDir,
			IPC_DATA_DIR: testDataDir,
			REQUEST_ID: "test-timeout-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_URL: "http://localhost:18888",
		});

		expect(result.exitCode).toBe(0);
		expect(mockServer.getRequestCount()).toBe(2);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-timeout-001");
		expect(response).not.toBeNull();
		expect(response.output).toBe("Timeout test");
	});

	test("should include exit code when present", async () => {
		mockServer.setResponses([200]);
		await writeDataFile(testDataDir, "cc-bridge", "test-error-001", "Some output", 1, "123456");

		const result = await runResponseCommand({
			IPC_BASE_DIR: testIpcDir,
			IPC_DATA_DIR: testDataDir,
			REQUEST_ID: "test-error-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_URL: "http://localhost:18888",
		});

		expect(result.exitCode).toBe(0);

		// Check response file
		const response = await readResponseFile("cc-bridge", "test-error-001");
		expect(response).not.toBeNull();
		expect(response.exitCode).toBe(1);
	});

	test("should retry and still write response file", async () => {
		mockServer.setResponses([500, 500, 200]);
		await writeDataFile(testDataDir, "cc-bridge", "test-timestamps-001", "Timestamp test", 0, "123456");

		const result = await runResponseCommand({
			IPC_BASE_DIR: testIpcDir,
			IPC_DATA_DIR: testDataDir,
			REQUEST_ID: "test-timestamps-001",
			CHAT_ID: "123456",
			WORKSPACE_NAME: "cc-bridge",
			GATEWAY_URL: "http://localhost:18888",
		});

		expect(result.exitCode).toBe(0);

		const response = await readResponseFile("cc-bridge", "test-timestamps-001");
		expect(response).not.toBeNull();
		expect(response.output).toBe("Timestamp test");
	});
});
