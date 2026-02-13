import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { TmuxManager, TmuxManagerError } from "@/gateway/services/tmux-manager";

// Test container ID
const TEST_CONTAINER_ID = "test-container-123";
const TEST_WORKSPACE = "test-workspace";
const TEST_CHAT_ID = "123456789";

// Test helper that exposes protected methods for testing
class TestableTmuxManager extends TmuxManager {
	// Expose protected methods as public for testing
	public generateSessionName(workspace: string, chatId: string | number): string {
		return super.generateSessionName(workspace, chatId);
	}

	public escapeForShell(str: string): string {
		return super.escapeForShell(str);
	}

	// Store mock for execInContainer
	public mockExecInContainer: ReturnType<typeof mock> | null = null;

	// Override execInContainer to use mock if available
	protected async execInContainer(
		containerId: string,
		command: string[],
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		if (this.mockExecInContainer) {
			return this.mockExecInContainer(containerId, command);
		}
		return super.execInContainer(containerId, command);
	}
}

describe("TmuxManager", () => {
	let tmuxManager: TestableTmuxManager;

	beforeEach(() => {
		tmuxManager = new TestableTmuxManager({ sessionIdleTimeoutMs: 1000 });
		// Mock the execInContainer method
		tmuxManager.mockExecInContainer = mock(async (_containerId: string, _command: string[]) => ({
			stdout: "",
			stderr: "",
			exitCode: 0,
		}));
	});

	afterEach(() => {
		tmuxManager.mockExecInContainer = null;
	});

	describe("Session Naming", () => {
		test("should generate deterministic session names", () => {
			const name1 = tmuxManager.generateSessionName(TEST_WORKSPACE, TEST_CHAT_ID);
			const name2 = tmuxManager.generateSessionName(TEST_WORKSPACE, TEST_CHAT_ID);

			expect(name1).toBe(name2);
			expect(name1).toBe("claude-test-workspace-123456789");
		});

		test("should sanitize workspace and chatId in session names", () => {
			const name = tmuxManager.generateSessionName("my workspace!", "chat@123");

			// Special characters should be replaced with underscores
			// "my workspace!" → "my_workspace_"
			// "chat@123" → "chat_123"
			// Result: claude-my_workspace_-chat_123 (hyphen is separator)
			expect(name).toBe("claude-my_workspace_-chat_123");
		});

		test("should handle special characters in workspace names", () => {
			const testCases = [
				["simple-workspace", "123", "claude-simple-workspace-123"],
				["workspace.with.dots", "456", "claude-workspace_with_dots-456"],
				["workspace_with_underscore", "789", "claude-workspace_with_underscore-789"],
			];

			for (const [workspace, chatId, expected] of testCases) {
				expect(tmuxManager.generateSessionName(workspace, chatId)).toBe(expected);
			}
		});
	});

	describe("Shell Escaping", () => {
		test("should escape single quotes correctly", () => {
			const escapeForShell = tmuxManager.escapeForShell;

			expect(escapeForShell("Simple message")).toBe("Simple message");
			expect(escapeForShell("Message with 'quotes'")).toBe("Message with '\\''quotes'\\''");
			expect(escapeForShell("Message with $variables")).toBe("Message with $variables");
			expect(escapeForShell("Message with `backticks`")).toBe("Message with `backticks`");
		});

		test("should handle multiple single quotes", () => {
			const result = tmuxManager.escapeForShell("'hello' 'world'");

			expect(result).toBe("'\\''hello'\\'' '\\''world'\\''");
		});

		test("should handle empty string", () => {
			expect(tmuxManager.escapeForShell("")).toBe("");
		});
	});

	describe("Session Creation", () => {
		test("should create new session successfully", async () => {
			// Mock: session doesn't exist, list is empty, then create succeeds
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }) // has-session: not exists
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // list-sessions: empty
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // new-session: success

			const sessionName = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			expect(sessionName).toBe("claude-test-workspace-123456789");
			expect(tmuxManager.mockExecInContainer).toHaveBeenCalledTimes(3);

			// Verify create session was called (third call)
			const createCall = tmuxManager.mockExecInContainer.mock.calls[2];
			expect(createCall[0]).toBe(TEST_CONTAINER_ID);
			expect(createCall[1]).toContain("tmux");
			expect(createCall[1]).toContain("new-session");
			expect(createCall[1]).toContain("-s");
			expect(createCall[1]).toContain(sessionName);
		});

		test("should reuse existing session", async () => {
			// Mock: session exists
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 0,
			});

			const session1 = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);
			const session2 = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			expect(session1).toBe(session2);
			expect(session1).toBe("claude-test-workspace-123456789");
			expect(tmuxManager.mockExecInContainer).toHaveBeenCalledTimes(2);
		});

		test("should enforce max sessions per container limit", async () => {
			// Mock: session doesn't exist, list returns max sessions
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({
					stdout: Array(10)
						.fill(0)
						.map((_, i) => `claude-workspace-${i}`)
						.join("\n"),
					stderr: "",
					exitCode: 0,
				});

			expect(tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID)).rejects.toThrow(
				"Maximum sessions per container reached",
			);
		});

		test("should handle tmux create failure", async () => {
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 }) // has-session: not exists
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // list-sessions: empty
				.mockResolvedValueOnce({
					stdout: "",
					stderr: "tmux: failed to connect to server",
					exitCode: 1,
				}); // new-session: fails

			await expect(tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID)).rejects.toThrow(
				TmuxManagerError,
			);
		});
	});

	describe("Send to Session", () => {
		test("should send prompt to existing session", async () => {
			// Create session first
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			const sessionName = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			// Reset and mock sendToSession calls
			tmuxManager.mockExecInContainer.mockClear();
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // has-session
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // send-keys

			await tmuxManager.sendToSession(TEST_CONTAINER_ID, sessionName, "Hello Claude!", {
				requestId: "req-001",
				chatId: TEST_CHAT_ID,
				workspace: TEST_WORKSPACE,
			});

			const sendKeysCall = tmuxManager.mockExecInContainer.mock.calls[1];
			expect(sendKeysCall[0]).toBe(TEST_CONTAINER_ID);
			expect(sendKeysCall[1]).toContain("tmux");
			expect(sendKeysCall[1]).toContain("send-keys");
			expect(sendKeysCall[1]).toContain("-t");
			expect(sendKeysCall[1]).toContain(sessionName);
		});

		test("should escape prompts with special characters", async () => {
			const testCases = [
				"Simple message",
				'Message with "quotes"',
				"Message with 'single quotes'",
				"Message with $variables",
				"Message with `backticks`",
			];

			// Create session first
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			const sessionName = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			// Test each prompt type
			for (const prompt of testCases) {
				tmuxManager.mockExecInContainer.mockClear();
				tmuxManager.mockExecInContainer
					.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
					.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

				await tmuxManager.sendToSession(TEST_CONTAINER_ID, sessionName, prompt, {
					requestId: `req-${Math.random()}`,
					chatId: TEST_CHAT_ID,
					workspace: TEST_WORKSPACE,
				});

				// Should not throw
				expect(tmuxManager.mockExecInContainer).toHaveBeenCalled();
			}
		});

		test("should throw error when session does not exist", async () => {
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 1,
			});

			expect(
				tmuxManager.sendToSession(TEST_CONTAINER_ID, "non-existent-session", "Hello!", {
					requestId: "req-001",
					chatId: TEST_CHAT_ID,
					workspace: TEST_WORKSPACE,
				}),
			).rejects.toThrow("does not exist");
		});
	});

	describe("Session Discovery", () => {
		test("should list active sessions", async () => {
			const expectedSessions = ["claude-workspace1-123", "claude-workspace2-456", "claude-workspace3-789"];

			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: expectedSessions.join("\n"),
				stderr: "",
				exitCode: 0,
			});

			const sessions = await tmuxManager.listSessions(TEST_CONTAINER_ID);

			expect(sessions).toEqual(expectedSessions);
		});

		test("should filter out non-claude sessions", async () => {
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: ["claude-workspace-123", "other-session", "claud-extra-456"].join("\n"),
				stderr: "",
				exitCode: 0,
			});

			const sessions = await tmuxManager.listSessions(TEST_CONTAINER_ID);

			expect(sessions).toEqual(["claude-workspace-123"]);
		});

		test("should handle empty session list", async () => {
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: "",
				stderr: "no server running",
				exitCode: 1,
			});

			const sessions = await tmuxManager.listSessions(TEST_CONTAINER_ID);

			expect(sessions).toEqual([]);
		});

		test("should treat exit code 1 with empty output as no sessions", async () => {
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 1,
			});

			const sessions = await tmuxManager.listSessions(TEST_CONTAINER_ID);

			expect(sessions).toEqual([]);
		});

		test("should check if session exists", async () => {
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 0,
			});

			const exists = await tmuxManager.sessionExists(TEST_CONTAINER_ID, "claude-test-workspace-123456789");

			expect(exists).toBe(true);
			expect(tmuxManager.mockExecInContainer).toHaveBeenCalledWith(TEST_CONTAINER_ID, [
				"tmux",
				"has-session",
				"-t",
				"claude-test-workspace-123456789",
			]);
		});
	});

	describe("Session Lifecycle", () => {
		test("should kill session", async () => {
			// Create session first
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			const sessionName = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			// Reset and mock kill-session
			tmuxManager.mockExecInContainer.mockClear();
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 0,
			});

			await tmuxManager.killSession(TEST_CONTAINER_ID, sessionName);

			expect(tmuxManager.mockExecInContainer).toHaveBeenCalledWith(TEST_CONTAINER_ID, [
				"tmux",
				"kill-session",
				"-t",
				sessionName,
			]);

			// Verify session was removed from tracking
			expect(tmuxManager.getSessionInfo(sessionName)).toBeUndefined();
		});
	});

	describe("Idle Session Cleanup", () => {
		test("should cleanup idle sessions after timeout", async () => {
			// Create a session
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			const sessionName = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			// Mock kill for cleanup
			tmuxManager.mockExecInContainer.mockClear();
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 0,
			});

			// Wait for timeout (1 second)
			await new Promise((resolve) => setTimeout(resolve, 1500));

			const cleaned = await tmuxManager.cleanupIdleSessions();

			expect(cleaned).toBe(1);
			expect(tmuxManager.mockExecInContainer).toHaveBeenCalledWith(TEST_CONTAINER_ID, [
				"tmux",
				"kill-session",
				"-t",
				sessionName,
			]);
		});

		test("should not cleanup active sessions", async () => {
			// Create a session
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			// Mock kill for cleanup
			tmuxManager.mockExecInContainer.mockClear();
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 0,
			});

			// Run cleanup immediately (before timeout)
			const cleaned = await tmuxManager.cleanupIdleSessions();

			expect(cleaned).toBe(0);
			expect(tmuxManager.mockExecInContainer).not.toHaveBeenCalled();
		});
	});

	describe("Concurrent Requests", () => {
		test("should handle concurrent requests to same session", async () => {
			// Create session first
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			const sessionName = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			// Mock send-keys for concurrent requests
			tmuxManager.mockExecInContainer.mockClear();
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 0,
			});

			// Send multiple prompts concurrently
			const promises = [
				tmuxManager.sendToSession(TEST_CONTAINER_ID, sessionName, "Prompt 1", {
					requestId: "req-001",
					chatId: TEST_CHAT_ID,
					workspace: TEST_WORKSPACE,
				}),
				tmuxManager.sendToSession(TEST_CONTAINER_ID, sessionName, "Prompt 2", {
					requestId: "req-002",
					chatId: TEST_CHAT_ID,
					workspace: TEST_WORKSPACE,
				}),
				tmuxManager.sendToSession(TEST_CONTAINER_ID, sessionName, "Prompt 3", {
					requestId: "req-003",
					chatId: TEST_CHAT_ID,
					workspace: TEST_WORKSPACE,
				}),
			];

			// Should all complete without errors - sendToSession returns void
			const results = await Promise.all(promises);
			expect(results).toEqual([undefined, undefined, undefined]);
		});
	});

	describe("Error Handling", () => {
		test("should handle non-existent container gracefully", async () => {
			tmuxManager.mockExecInContainer.mockRejectedValue(new Error("No such container: invalid-container"));

			expect(tmuxManager.getOrCreateSession("invalid-container", TEST_WORKSPACE, TEST_CHAT_ID)).rejects.toThrow();
		});

		test("should handle tmux command failures gracefully", async () => {
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: "",
				stderr: "tmux: command not found",
				exitCode: 127,
			});

			const sessions = await tmuxManager.listSessions(TEST_CONTAINER_ID);

			// Should return empty array on error
			expect(sessions).toEqual([]);
		});
	});

	describe("Session Metadata", () => {
		test("should track session info correctly", async () => {
			// Create session
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			const sessionName = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			const sessionInfo = tmuxManager.getSessionInfo(sessionName);

			expect(sessionInfo).toBeDefined();
			expect(sessionInfo?.sessionName).toBe(sessionName);
			expect(sessionInfo?.workspace).toBe(TEST_WORKSPACE);
			expect(sessionInfo?.chatId).toBe(TEST_CHAT_ID);
			expect(sessionInfo?.containerId).toBe(TEST_CONTAINER_ID);
			expect(sessionInfo?.createdAt).toBeInstanceOf(Date);
			expect(sessionInfo?.lastUsedAt).toBeInstanceOf(Date);
		});

		test("should update last used timestamp on activity", async () => {
			// Create session
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			const sessionName = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			const originalTimestamp = tmuxManager.getSessionInfo(sessionName)?.lastUsedAt;

			// Wait a bit and update session
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Reuse session (which updates timestamp)
			tmuxManager.mockExecInContainer.mockClear();
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 0,
			});

			await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			const updatedTimestamp = tmuxManager.getSessionInfo(sessionName)?.lastUsedAt;

			expect(updatedTimestamp?.getTime()).toBeGreaterThan(originalTimestamp?.getTime() ?? 0);
		});
	});
});
