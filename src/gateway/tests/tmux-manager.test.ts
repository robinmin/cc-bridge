import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
	public mockExecInContainerWithStdin: ReturnType<typeof mock> | null = null;

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

	protected async execInContainerWithStdin(
		containerId: string,
		command: string[],
		stdinContent: string,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		if (this.mockExecInContainerWithStdin) {
			return this.mockExecInContainerWithStdin(containerId, command, stdinContent);
		}
		return super.execInContainerWithStdin(containerId, command, stdinContent);
	}
}

describe("TmuxManager", () => {
	let tmuxManager: TestableTmuxManager;
	let originalSpawn: typeof Bun.spawn;

	const streamFrom = (text: string): ReadableStream<Uint8Array> =>
		(new Response(text).body as ReadableStream<Uint8Array>);

	const spawnResult = (stdout: string, stderr: string, exitCode: number) =>
		({
			stdout: streamFrom(stdout),
			stderr: streamFrom(stderr),
			exited: Promise.resolve(exitCode),
		}) as unknown as ReturnType<typeof Bun.spawn>;

	beforeEach(() => {
		originalSpawn = Bun.spawn;
		tmuxManager = new TestableTmuxManager({ sessionIdleTimeoutMs: 1000 });
		// Mock the execInContainer method
		tmuxManager.mockExecInContainer = mock(async (_containerId: string, _command: string[]) => ({
			stdout: "",
			stderr: "",
			exitCode: 0,
		}));
		tmuxManager.mockExecInContainerWithStdin = mock(
			async (_containerId: string, _command: string[], _stdinContent: string) => ({
				stdout: "",
				stderr: "",
				exitCode: 0,
			}),
		);
	});

	afterEach(() => {
		tmuxManager.mockExecInContainer = null;
		tmuxManager.mockExecInContainerWithStdin = null;
		Bun.spawn = originalSpawn;
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
			tmuxManager.mockExecInContainerWithStdin?.mockResolvedValueOnce({
				stdout: "",
				stderr: "",
				exitCode: 0,
			});

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
			expect(tmuxManager.mockExecInContainerWithStdin).toHaveBeenCalledTimes(1);
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
				tmuxManager.mockExecInContainerWithStdin?.mockResolvedValueOnce({
					stdout: "",
					stderr: "",
					exitCode: 0,
				});

				await tmuxManager.sendToSession(TEST_CONTAINER_ID, sessionName, prompt, {
					requestId: `req-${Math.random()}`,
					chatId: TEST_CHAT_ID,
					workspace: TEST_WORKSPACE,
				});

				// Should not throw
				expect(tmuxManager.mockExecInContainer).toHaveBeenCalled();
			}
		});

		test("should avoid embedding full prompt in tmux send-keys command", async () => {
			// Create session first
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
			const sessionName = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			tmuxManager.mockExecInContainer.mockClear();
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // has-session
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // send-keys
			tmuxManager.mockExecInContainerWithStdin?.mockResolvedValueOnce({
				stdout: "",
				stderr: "",
				exitCode: 0,
			});

			const longPrompt = "A".repeat(20000);
			await tmuxManager.sendToSession(TEST_CONTAINER_ID, sessionName, longPrompt, {
				requestId: "req-very-long",
				chatId: TEST_CHAT_ID,
				workspace: TEST_WORKSPACE,
			});

			const stagedStdin = tmuxManager.mockExecInContainerWithStdin?.mock.calls[0]?.[2];
			expect(stagedStdin).toBe(longPrompt);

			const sendKeysCommand = tmuxManager.mockExecInContainer.mock.calls[1]?.[1]?.[4];
			expect(typeof sendKeysCommand).toBe("string");
			expect(sendKeysCommand).toContain("$(cat ");
			expect(String(sendKeysCommand).length).toBeLessThan(500);
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

		test("should return false when session existence check throws", async () => {
			tmuxManager.mockExecInContainer.mockRejectedValueOnce(new Error("docker error"));
			await expect(tmuxManager.sessionExists(TEST_CONTAINER_ID, "missing")).resolves.toBe(false);
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

		test("should wrap timeout-shaped errors when sending to session", async () => {
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
			const sessionName = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			tmuxManager.mockExecInContainer.mockClear();
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
				.mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
			tmuxManager.mockExecInContainerWithStdin?.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			await expect(
				tmuxManager.sendToSession(TEST_CONTAINER_ID, sessionName, "hi", {
					requestId: "req-timeout",
					chatId: TEST_CHAT_ID,
					workspace: TEST_WORKSPACE,
				}),
			).rejects.toThrow(TmuxManagerError);
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

	describe("Lifecycle and Workspace Operations", () => {
		test("start discovers local sessions and stop clears tracked sessions", async () => {
			const spawnMock = mock((_cmd: string[]) => spawnResult("", "", 0));
			spawnMock
				.mockImplementationOnce(() => spawnResult("", "", 1))
				.mockImplementationOnce(() => spawnResult("", "", 0))
				.mockImplementationOnce(() => spawnResult("claude-ws-42\nother", "", 0))
				.mockImplementationOnce(() => spawnResult("", "", 0));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			await tmuxManager.start();
			expect(tmuxManager.isRunning()).toBe(true);
			expect(tmuxManager.getSessionInfo("claude-ws-42")?.containerId).toBe("local");

			await tmuxManager.stop();
			expect(tmuxManager.isRunning()).toBe(false);
			expect(tmuxManager.getAllSessions()).toEqual([]);
		});

		test("start short-circuits when already running and stop short-circuits when not started", async () => {
			Bun.spawn = mock((_cmd: string[]) => spawnResult("", "", 0)) as typeof Bun.spawn;
			await tmuxManager.stop();
			await tmuxManager.start();
			await tmuxManager.start();
			expect(tmuxManager.isRunning()).toBe(true);
		});

		test("clearSession returns false when absent and true when killed", async () => {
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			await expect(tmuxManager.clearSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID)).resolves.toBe(false);
			await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);
			await expect(tmuxManager.clearSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID)).resolves.toBe(true);
		});

		test("createWorkspaceSession and listAllSessions handle success and failure branches", async () => {
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
			await expect(
				tmuxManager.createWorkspaceSession(TEST_CONTAINER_ID, "workspace-main", TEST_WORKSPACE),
			).resolves.toBeUndefined();

			tmuxManager.mockExecInContainer.mockResolvedValueOnce({
				stdout: "",
				stderr: "boom",
				exitCode: 1,
			});
			await expect(
				tmuxManager.createWorkspaceSession(TEST_CONTAINER_ID, "workspace-fail", TEST_WORKSPACE),
			).rejects.toThrow(TmuxManagerError);

			tmuxManager.mockExecInContainer.mockResolvedValueOnce({
				stdout: "workspace-main\nclaude-ws-1",
				stderr: "",
				exitCode: 0,
			});
			await expect(tmuxManager.listAllSessions(TEST_CONTAINER_ID)).resolves.toEqual(["workspace-main", "claude-ws-1"]);

			tmuxManager.mockExecInContainer.mockResolvedValueOnce({
				stdout: "",
				stderr: "no server running",
				exitCode: 1,
			});
			await expect(tmuxManager.listAllSessions(TEST_CONTAINER_ID)).resolves.toEqual([]);

			tmuxManager.mockExecInContainer.mockRejectedValueOnce(new Error("docker fail"));
			await expect(tmuxManager.listAllSessions(TEST_CONTAINER_ID)).resolves.toEqual([]);
		});

		test("killWorkspaceSession tolerates already-dead sessions", async () => {
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "session not found", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "other failure", exitCode: 1 });

			await expect(tmuxManager.killWorkspaceSession(TEST_CONTAINER_ID, "ws-1")).resolves.toBeUndefined();
			await expect(tmuxManager.killWorkspaceSession(TEST_CONTAINER_ID, "ws-2")).resolves.toBeUndefined();
		});

		test("syncSessions removes stale tracked sessions for a container", async () => {
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			const stale = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, "stale", "1");
			const keep = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, "keep", "2");

			tmuxManager.mockExecInContainer.mockResolvedValueOnce({
				stdout: `${keep}\nnot-tracked`,
				stderr: "",
				exitCode: 0,
			});

			await tmuxManager.syncSessions(TEST_CONTAINER_ID);
			expect(tmuxManager.getSessionInfo(stale)).toBeUndefined();
			expect(tmuxManager.getSessionInfo(keep)).toBeDefined();
		});

		test("syncSessions serializes concurrent calls through mutex", async () => {
			tmuxManager.mockExecInContainer.mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 0,
			});
			const listSpy = spyOn(tmuxManager, "listSessions");
			listSpy
				.mockImplementationOnce(async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return [];
				})
				.mockResolvedValueOnce([]);

			await Promise.all([tmuxManager.syncSessions(TEST_CONTAINER_ID), tmuxManager.syncSessions(TEST_CONTAINER_ID)]);
			expect(listSpy).toHaveBeenCalledTimes(2);
		});
	});

	describe("Internal Execution Helpers", () => {
		test("execInContainer and execInContainerWithStdin parse spawn output", async () => {
			type TmuxManagerInternals = {
				execInContainer: (
					containerId: string,
					command: string[],
				) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
				execInContainerWithStdin: (
					containerId: string,
					command: string[],
					stdinContent: string,
				) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
			};

			const stdinWrite = mock(() => {});
			const stdinEnd = mock(() => {});
			const spawnMock = mock((_cmd: string[]) => spawnResult("ok-stdout", "ok-stderr", 7));
			spawnMock.mockImplementationOnce((_cmd: string[]) => spawnResult("ok-stdout", "ok-stderr", 7));
			spawnMock.mockImplementationOnce(
				(_cmd: string[]) =>
					({
						stdout: streamFrom("pipe-stdout"),
						stderr: streamFrom("pipe-stderr"),
						exited: Promise.resolve(3),
						stdin: {
							write: stdinWrite,
							end: stdinEnd,
						},
					}) as unknown as ReturnType<typeof Bun.spawn>,
			);
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const rawManager = new TmuxManager();
			const rawManagerInternals = rawManager as unknown as TmuxManagerInternals;
			const execResult = await rawManagerInternals.execInContainer("cid", [
				"echo",
				"hello",
			]);
			expect(execResult).toEqual({ stdout: "ok-stdout", stderr: "ok-stderr", exitCode: 7 });

			const execStdinResult = await rawManagerInternals.execInContainerWithStdin("cid", ["cat"], "payload");
			expect(execStdinResult).toEqual({ stdout: "pipe-stdout", stderr: "pipe-stderr", exitCode: 3 });
			expect(stdinWrite).toHaveBeenCalledTimes(1);
			expect(stdinEnd).toHaveBeenCalledTimes(1);
		});

		test("sendToSession can hit real timeout path", async () => {
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
			const sessionName = await tmuxManager.getOrCreateSession(TEST_CONTAINER_ID, TEST_WORKSPACE, TEST_CHAT_ID);

			tmuxManager.mockExecInContainer.mockClear();
			tmuxManager.mockExecInContainer
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
				.mockImplementationOnce(async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return { stdout: "", stderr: "", exitCode: 0 };
				});
			tmuxManager.mockExecInContainerWithStdin?.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			await expect(
				tmuxManager.sendToSession(
					TEST_CONTAINER_ID,
					sessionName,
					"slow",
					{
						requestId: "req-real-timeout",
						chatId: TEST_CHAT_ID,
						workspace: TEST_WORKSPACE,
					},
					1,
				),
			).rejects.toThrow("timed out");
		});
	});
});
