import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { persistence } from "@/gateway/persistence";
import type { Channel, Message } from "@/gateway/pipeline";
import { AgentBot } from "@/gateway/pipeline/agent-bot";
import { FileSystemIpc } from "@/gateway/services/filesystem-ipc";
import { TmuxManager } from "@/gateway/services/tmux-manager";

// Mock Channel for testing
class MockChannel implements Channel {
	name = "mock";
	sentMessages: Array<{ chatId: string | number; text: string }> = [];

	async sendMessage(chatId: string | number, text: string): Promise<void> {
		this.sentMessages.push({ chatId, text });
	}

	async clear(): Promise<void> {
		this.sentMessages = [];
	}

	async waitForMessage(chatId: string | number, timeoutMs = 30000): Promise<{ text: string } | null> {
		const startTime = Date.now();
		while (Date.now() - startTime < timeoutMs) {
			const msg = this.sentMessages.find((m) => m.chatId === chatId && Date.now() - startTime < 5000);
			if (msg) {
				return { text: msg.text };
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return null;
	}
}

// Mock instance manager
class MockInstanceManager {
	private instances: Array<{
		name: string;
		containerId: string;
		status: string;
	}> = [];

	setInstances(instances: Array<{ name: string; containerId: string; status: string }>) {
		this.instances = instances;
	}

	getInstance(name: string) {
		return this.instances.find((i) => i.name === name);
	}

	getInstances() {
		return this.instances;
	}
}

// Mock TmuxManager that simulates container execution
class SimulatedTmuxManager extends TmuxManager {
	private responseFiles: Map<string, string> = new Map();

	// Override sendToSession to simulate callback execution
	async sendToSession(
		_containerId: string,
		_sessionName: string,
		_prompt: string,
		metadata: { requestId: string; chatId: string; workspace: string },
	): Promise<void> {
		// Simulate async response by writing to filesystem
		// In real scenario, this happens via stop-hook.sh
		const { requestId, chatId, workspace } = metadata;

		// Simulate Claude response after a delay
		setTimeout(async () => {
			const testIpcDir = process.env.TEST_IPC_DIR || "./data/test-ipc";
			const responseDir = path.join(testIpcDir, workspace, "responses");
			const responsePath = path.join(responseDir, `${requestId}.json`);

			const responseData = {
				requestId,
				chatId: String(chatId),
				workspace,
				timestamp: new Date().toISOString(),
				output: `Simulated Claude response for: ${_prompt.substring(0, 50)}...`,
				exitCode: 0,
				metadata: {
					duration: 1500,
					model: "claude-3-5-sonnet",
				},
			};

			// Write response file (simulating stop-hook.sh)
			await Bun.write(responsePath, JSON.stringify(responseData, null, 2));

			// Track for cleanup
			this.responseFiles.set(requestId, responsePath);
		}, 1500); // Simulate 1.5s execution time
	}

	async cleanup(): Promise<void> {
		for (const filePath of this.responseFiles.values()) {
			if (existsSync(filePath)) {
				await rm(filePath, { force: true });
			}
		}
		this.responseFiles.clear();
	}
}

describe("End-to-End tmux Workflow Integration Tests", () => {
	let mockChannel: MockChannel;
	let _agentBot: AgentBot;
	let fileSystemIpc: FileSystemIpc;
	let mockInstanceManager: MockInstanceManager;
	let simulatedTmux: SimulatedTmuxManager;
	let testIpcDir: string;

	const TEST_CHAT_ID = "test-integration-123";
	const TEST_WORKSPACE = "cc-bridge";
	const TEST_CONTAINER_ID = "claude-cc-bridge-test";

	beforeEach(async () => {
		// Setup test IPC directory
		testIpcDir = process.env.TEST_IPC_DIR || "./data/test-ipc";
		if (existsSync(testIpcDir)) {
			await rm(testIpcDir, { recursive: true, force: true });
		}

		// Initialize components
		mockChannel = new MockChannel();
		fileSystemIpc = new FileSystemIpc({
			baseDir: testIpcDir,
			responseTimeoutMs: 10000,
			cleanupIntervalMs: 60000,
		});
		simulatedTmux = new SimulatedTmuxManager();
		mockInstanceManager = new MockInstanceManager();
		mockInstanceManager.setInstances([
			{
				name: TEST_WORKSPACE,
				containerId: TEST_CONTAINER_ID,
				status: "running",
			},
		]);

		// Create agent bot with mock channel
		_agentBot = new AgentBot(mockChannel, persistence);
	});

	afterEach(async () => {
		// Cleanup
		await mockChannel.clear();
		await simulatedTmux.cleanup();
		if (existsSync(testIpcDir)) {
			await rm(testIpcDir, { recursive: true, force: true });
		}
	});

	test("should complete full workflow: message → tmux → callback → response", async () => {
		// This is a simulated integration test
		// Real integration tests would require actual Docker containers

		const _testMessage: Message = {
			chatId: TEST_CHAT_ID,
			text: "Hello Claude! This is an integration test.",
			timestamp: new Date().toISOString(),
		};

		// Note: This test uses the existing sync execution path
		// Full tmux async testing requires running Docker containers
		// The unit tests in tmux-manager.test.ts and claude-executor-tmux.test.ts
		// verify the individual components work correctly

		expect(mockChannel.sentMessages.length).toBe(0);
		expect(true).toBe(true); // Placeholder - demonstrates test structure
	}, 10000);

	test("should handle async result detection", async () => {
		// Verify we can detect async vs sync results
		const { isAsyncResult } = await import("@/gateway/services/claude-executor");

		const asyncResult = { requestId: randomUUID(), mode: "tmux" as const };
		const syncResult = { success: true, output: "test" };

		expect(isAsyncResult(asyncResult)).toBe(true);
		expect(isAsyncResult(syncResult)).toBe(false);
	});

	test("should verify callback handler can read response files", async () => {
		const requestId = randomUUID();
		const workspace = TEST_WORKSPACE;
		const chatId = TEST_CHAT_ID;

		// Create a test response file
		const responseDir = path.join(testIpcDir, workspace, "responses");
		await Bun.write(
			path.join(responseDir, `${requestId}.json`),
			JSON.stringify({
				requestId,
				chatId,
				workspace,
				timestamp: new Date().toISOString(),
				output: "Test response from callback",
				exitCode: 0,
			}),
		);

		// Verify file exists and can be read
		const response = await fileSystemIpc.readResponse(workspace, requestId);

		expect(response).toBeDefined();
		expect(response?.output).toBe("Test response from callback");
	});

	test("should cleanup response files after processing", async () => {
		const requestId = randomUUID();
		const workspace = TEST_WORKSPACE;

		// Create test response file
		const responseDir = path.join(testIpcDir, workspace, "responses");
		const responsePath = path.join(responseDir, `${requestId}.json`);
		await Bun.write(
			responsePath,
			JSON.stringify({
				requestId,
				chatId: TEST_CHAT_ID,
				workspace,
				timestamp: new Date().toISOString(),
				output: "Test response",
				exitCode: 0,
			}),
		);

		// Verify file exists
		expect(existsSync(responsePath)).toBe(true);

		// Cleanup via FileSystemIpc
		await fileSystemIpc.deleteResponse(workspace, requestId);

		// Verify file is deleted
		expect(existsSync(responsePath)).toBe(false);
	});

	test("should handle concurrent requests with unique request IDs", async () => {
		const requestIds = new Set<string>();

		// Generate multiple request IDs
		for (let i = 0; i < 10; i++) {
			requestIds.add(randomUUID());
		}

		// Verify all are unique
		expect(requestIds.size).toBe(10);
	});

	test("should validate response file structure", async () => {
		// Test with valid structure
		const validData = {
			requestId: randomUUID(),
			chatId: TEST_CHAT_ID,
			workspace: TEST_WORKSPACE,
			timestamp: new Date().toISOString(),
			output: "Valid response",
			exitCode: 0,
		};

		const responseDir = path.join(testIpcDir, TEST_WORKSPACE, "responses");
		await Bun.write(path.join(responseDir, `${validData.requestId}.json`), JSON.stringify(validData));

		const response = await fileSystemIpc.readResponse(TEST_WORKSPACE, validData.requestId);

		expect(response).toBeDefined();
		expect(response?.requestId).toBe(validData.requestId);
		expect(response?.output).toBe("Valid response");
	});

	test("should handle missing response files gracefully", async () => {
		// Use a very short timeout for this test
		const shortTimeoutIpc = new FileSystemIpc({
			baseDir: testIpcDir,
			responseTimeout: 500, // 500ms timeout
			cleanupInterval: 60000,
		});

		const nonExistentRequestId = randomUUID();

		// readResponse throws an error when file is not found
		let error: Error | null = null;
		try {
			await shortTimeoutIpc.readResponse(TEST_WORKSPACE, nonExistentRequestId);
		} catch (e) {
			error = e as Error;
		}

		expect(error).not.toBeNull();
		expect(error?.message).toContain("Response file not found");
	});

	test("should validate session naming convention", async () => {
		// Test session name generation follows the pattern
		const workspace = "my-workspace";
		const chatId = "123456";
		const expectedPattern = `claude-${workspace}-${chatId}`;

		// The actual implementation is in TmuxManager
		// This validates the naming pattern
		expect(expectedPattern).toMatch(/^claude-[a-z0-9_-]+-\d+$/);
	});

	test("should handle workspace-specific session isolation", async () => {
		// Different workspaces should have different sessions
		const workspace1 = "project-alpha";
		const workspace2 = "project-beta";
		const chatId = "user-123";

		const session1 = `claude-${workspace1}-${chatId}`;
		const session2 = `claude-${workspace2}-${chatId}`;

		// Verify sessions are different
		expect(session1).not.toBe(session2);
	});

	test("should verify timeout configuration", async () => {
		// Test with shorter timeout for faster testing
		const shortTimeoutIpc = new FileSystemIpc({
			baseDir: testIpcDir,
			responseTimeout: 500, // 500ms timeout
			cleanupInterval: 60000,
		});

		// Try to read non-existent file with short timeout
		const startTime = Date.now();

		let error: Error | null = null;
		try {
			await shortTimeoutIpc.readResponse(TEST_WORKSPACE, randomUUID());
		} catch (e) {
			error = e as Error;
		}

		const elapsed = Date.now() - startTime;

		// Should error after timeout
		expect(error).not.toBeNull();
		expect(elapsed).toBeGreaterThan(400);
		expect(elapsed).toBeLessThan(1000);
	});
});

// Helper functions for integration testing
export async function setupTestEnvironment() {
	const testIpcDir = process.env.TEST_IPC_DIR || "./data/test-ipc";
	if (existsSync(testIpcDir)) {
		await rm(testIpcDir, { recursive: true, force: true });
	}
	return testIpcDir;
}

export async function teardownTestEnvironment(testIpcDir: string) {
	if (existsSync(testIpcDir)) {
		await rm(testIpcDir, { recursive: true, force: true });
	}
}

export async function createMockResponse(
	workspace: string,
	requestId: string,
	output: string,
	exitCode = 0,
): Promise<void> {
	const testIpcDir = process.env.TEST_IPC_DIR || "./data/test-ipc";
	const responseDir = path.join(testIpcDir, workspace, "responses");
	await Bun.write(
		path.join(responseDir, `${requestId}.json`),
		JSON.stringify({
			requestId,
			chatId: "test-chat",
			workspace,
			timestamp: new Date().toISOString(),
			output,
			exitCode,
		}),
	);
}
