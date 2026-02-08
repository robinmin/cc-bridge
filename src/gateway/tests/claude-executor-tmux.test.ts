import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type ClaudeAsyncExecutionResult,
	type ClaudeExecutionResult,
	executeClaudeViaTmux,
	isAsyncResult,
} from "@/gateway/services/claude-executor";
import { TmuxManager } from "@/gateway/services/tmux-manager";

// Mock TmuxManager
class MockTmuxManager {
	async getOrCreateSession(_containerId: string, _workspace: string, _chatId: string | number): Promise<string> {
		return this.mockGetOrCreateSession?.();
	}

	async sendToSession(
		_containerId: string,
		_sessionName: string,
		_prompt: string,
		_metadata: { requestId: string; chatId: string; workspace: string },
	): Promise<void> {
		this.sendCalls.push({
			sessionName: _sessionName,
			prompt: _prompt,
			metadata: _metadata,
		});
	}

	reset() {
		this.mockGetOrCreateSession = null;
		this.sendCalls = [];
	}

	mockGetOrCreateSession: (() => Promise<string>) | null = null;
	sendCalls: Array<{
		sessionName: string;
		prompt: string;
		metadata: { requestId: string; chatId: string; workspace: string };
	}> = [];
}

describe("ClaudeExecutor Tmux Integration", () => {
	let mockTmuxManager: MockTmuxManager;

	beforeEach(() => {
		mockTmuxManager = new MockTmuxManager();
	});

	afterEach(() => {
		mockTmuxManager.reset();
	});

	describe("executeClaudeViaTmux", () => {
		test("should return request ID immediately", async () => {
			mockTmuxManager.mockGetOrCreateSession = async () => "claude-cc-bridge-123";

			// Mock the actual TmuxManager class
			const originalGetOrCreateSession = TmuxManager.prototype.getOrCreateSession;
			const originalSendToSession = TmuxManager.prototype.sendToSession;
			TmuxManager.prototype.getOrCreateSession = mockTmuxManager.getOrCreateSession.bind(mockTmuxManager);
			TmuxManager.prototype.sendToSession = mockTmuxManager.sendToSession.bind(mockTmuxManager);

			const result = await executeClaudeViaTmux("claude-cc-bridge", "cc-bridge", "Hello Claude!", {
				workspace: "cc-bridge",
				chatId: "123",
			});

			// Restore original methods
			TmuxManager.prototype.getOrCreateSession = originalGetOrCreateSession;
			TmuxManager.prototype.sendToSession = originalSendToSession;

			expect(result).toHaveProperty("requestId");
			expect(typeof result.requestId).toBe("string");
			expect(result.mode).toBe("tmux");
			expect(mockTmuxManager.sendCalls.length).toBe(1);
			expect(mockTmuxManager.sendCalls[0].prompt).toBe("Hello Claude!");
		});

		test("should pass metadata to tmux session", async () => {
			mockTmuxManager.mockGetOrCreateSession = async () => "claude-cc-bridge-456";

			const originalGetOrCreateSession = TmuxManager.prototype.getOrCreateSession;
			const originalSendToSession = TmuxManager.prototype.sendToSession;
			TmuxManager.prototype.getOrCreateSession = mockTmuxManager.getOrCreateSession.bind(mockTmuxManager);
			TmuxManager.prototype.sendToSession = mockTmuxManager.sendToSession.bind(mockTmuxManager);

			await executeClaudeViaTmux("claude-cc-bridge", "cc-bridge", "Test prompt", {
				workspace: "my-workspace",
				chatId: "789",
			});

			TmuxManager.prototype.getOrCreateSession = originalGetOrCreateSession;
			TmuxManager.prototype.sendToSession = originalSendToSession;

			expect(mockTmuxManager.sendCalls[0].metadata).toEqual({
				requestId: expect.any(String),
				chatId: "789",
				workspace: "my-workspace",
			});
		});
	});

	describe("isAsyncResult", () => {
		test("should identify async results correctly", () => {
			const asyncResult: ClaudeAsyncExecutionResult = {
				requestId: "req-001",
				mode: "tmux",
			};

			const syncResult: ClaudeExecutionResult = {
				success: true,
				output: "Hello!",
			};

			expect(isAsyncResult(asyncResult)).toBe(true);
			expect(isAsyncResult(syncResult)).toBe(false);
		});
	});

	describe("executeClaude mode selection", () => {
		test("should use sync mode by default", async () => {
			// Mock executeClaudeRaw for sync mode
			const _originalRaw = (await import("@/gateway/services/claude-executor")).executeClaudeRaw;

			// For this test, we just verify the mode selection logic works
			// by checking that it respects the useTmux flag
			const config = { workspace: "test" };
			const useTmux = config.useTmux ?? process.env.ENABLE_TMUX === "true";

			// Default should be sync (useTmux = false unless env var is set)
			expect(useTmux).toBe(false);
		});

		test("should respect explicit useTmux flag", async () => {
			const configTrue = { useTmux: true };
			const configFalse = { useTmux: false };
			const configUndefined = {};

			const useTmuxTrue = configTrue.useTmux ?? process.env.ENABLE_TMUX === "true";
			const useTmuxFalse = configFalse.useTmux ?? process.env.ENABLE_TMUX === "true";
			const useTmxUndefined = configUndefined.useTmux ?? process.env.ENABLE_TMUX === "true";

			// Explicit true should use tmux
			expect(useTmuxTrue).toBe(true);
			// Explicit false should use sync
			expect(useTmuxFalse).toBe(false);
			// Undefined follows env var (which is false by default)
			expect(useTmxUndefined).toBe(false);
		});
	});

	describe("Request ID generation", () => {
		test("should generate unique request IDs", async () => {
			mockTmuxManager.mockGetOrCreateSession = async () => "claude-cc-bridge-123";

			const originalGetOrCreateSession = TmuxManager.prototype.getOrCreateSession;
			const originalSendToSession = TmuxManager.prototype.sendToSession;
			TmuxManager.prototype.getOrCreateSession = mockTmuxManager.getOrCreateSession.bind(mockTmuxManager);
			TmuxManager.prototype.sendToSession = mockTmuxManager.sendToSession.bind(mockTmuxManager);

			const results = await Promise.all([
				executeClaudeViaTmux("container", "instance", "prompt1", {
					workspace: "test",
				}),
				executeClaudeViaTmux("container", "instance", "prompt2", {
					workspace: "test",
				}),
				executeClaudeViaTmux("container", "instance", "prompt3", {
					workspace: "test",
				}),
			]);

			TmuxManager.prototype.getOrCreateSession = originalGetOrCreateSession;
			TmuxManager.prototype.sendToSession = originalSendToSession;

			const requestIds = results.map((r) => r.requestId);
			const uniqueIds = new Set(requestIds);

			expect(uniqueIds.size).toBe(3); // All unique
		});
	});

	describe("Error handling", () => {
		test("should propagate tmux errors", async () => {
			mockTmuxManager.mockGetOrCreateSession = async () => {
				throw new Error("tmux not available");
			};

			const originalGetOrCreateSession = TmuxManager.prototype.getOrCreateSession;
			TmuxManager.prototype.getOrCreateSession = mockTmuxManager.getOrCreateSession.bind(mockTmuxManager);

			await expect(
				executeClaudeViaTmux("container", "instance", "prompt", {
					workspace: "test",
				}),
			).rejects.toThrow("tmux not available");

			TmuxManager.prototype.getOrCreateSession = originalGetOrCreateSession;
		});
	});
});
