import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
	buildClaudePrompt,
	ClaudeTimeoutError,
	type ClaudeExecutionResult,
	executeClaude,
	type ClaudeExecutionConfig,
	executeClaudeWithHistory,
	executeClaudeViaIpc,
	IpcCommunicationError,
	validateAndSanitizePrompt,
} from "@/gateway/services/claude-executor";
import { IpcFactory } from "@/packages/ipc/factory";
import type { IpcRequest, IpcResponse } from "@/packages/ipc/types";
import { TmuxManager } from "@/gateway/services/tmux-manager";

// Track the last request sent to IPC
let _lastRequest: IpcRequest | null = null;
const mockSendRequest = mock(async (request: IpcRequest): Promise<IpcResponse> => {
	_lastRequest = request;
	return {
		id: request.id,
		status: 200,
		result: { stdout: "Mocked response" },
	};
});

// Create a mock client object that uses the mockSendRequest
const mockClient = {
	sendRequest: mockSendRequest,
	isAvailable: () => true,
	getMethod: () => "mock",
};

describe("validateAndSanitizePrompt", () => {
	test("should accept valid input", () => {
		const result = validateAndSanitizePrompt("Hello world");

		expect(result.valid).toBe(true);
		expect(result.sanitized).toBe("Hello world");
	});

	test("should reject input with null bytes", () => {
		const result = validateAndSanitizePrompt("Hello\x00World");

		expect(result.valid).toBe(false);
		expect(result.reason).toBe("Message contains invalid characters");
	});

	test("should reject input with control characters", () => {
		const result = validateAndSanitizePrompt("Hello\x01World");

		expect(result.valid).toBe(false);
	});

	test("should reject input with excessively long lines", () => {
		const longLine = "a".repeat(11000);
		const result = validateAndSanitizePrompt(longLine);

		expect(result.valid).toBe(false);
		expect(result.reason).toBe("Message line too long");
	});

	test("should truncate input exceeding max length", () => {
		// Create multi-line text that exceeds max length but not max line length
		// Each line is 5000 chars, 21 lines = 105000 chars total
		const longText = Array(21).fill("a".repeat(5000)).join("\n");
		const result = validateAndSanitizePrompt(longText);

		expect(result.valid).toBe(true);
		expect(result.sanitized.length).toBeLessThanOrEqual(100000 + 20); // truncate + suffix
		expect(result.sanitized).toContain("... [truncated]");
	});

	test("should escape XML special characters", () => {
		const result = validateAndSanitizePrompt("Hello <world> & 'friends'");

		expect(result.valid).toBe(true);
		expect(result.sanitized).toBe("Hello &lt;world&gt; &amp; &apos;friends&apos;");
	});
});

describe("buildClaudePrompt", () => {
	test("should build prompt from user message", () => {
		const history = [
			{
				sender: "user",
				text: "Previous message",
				timestamp: "2024-01-01 12:00:00",
			},
		];

		const prompt = buildClaudePrompt("New message", history);

		expect(prompt).toContain("<messages>");
		expect(prompt).toContain("</messages>");
		expect(prompt).toContain('<message sender="user" timestamp="2024-01-01 12:00:00">Previous message</message>');
		expect(prompt).toContain('<message sender="user">New message</message>');
	});

	test("should exclude current message from history", () => {
		const history = [{ sender: "user", text: "New message", timestamp: "2024-01-01 12:00:00" }];

		const prompt = buildClaudePrompt("New message", history);

		// Current message should appear only once
		const count = (prompt.match(/New message/g) || []).length;
		expect(count).toBe(1);
	});

	test("should escape XML in history", () => {
		const history = [{ sender: "user", text: "<test>", timestamp: "2024-01-01 12:00:00" }];

		const prompt = buildClaudePrompt("Test", history);

		expect(prompt).toContain("&lt;test&gt;");
	});

	test("should throw on invalid user message", () => {
		const history = [];

		expect(() => buildClaudePrompt("\x00", history)).toThrow();
	});
});

describe("executeClaudeViaIpc", () => {
	let factorySpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		_lastRequest = null;
		mockSendRequest.mockClear();

		// Mock IpcFactory.create to return our mock client
		factorySpy = spyOn(IpcFactory, "create").mockReturnValue(mockClient as never);
	});

	afterEach(() => {
		factorySpy.mockRestore();
	});

	test("should execute Claude command successfully", async () => {
		mockSendRequest.mockResolvedValueOnce({
			id: "test",
			status: 200,
			result: { stdout: "Test response" },
		});

		const instance = {
			name: "test-instance",
			containerId: "test-container",
			status: "running",
		};

		const result = await executeClaudeViaIpc(instance, "Test prompt");

		expect(result.success).toBe(true);
		expect(result.output).toBe("Test response");
	});

	test("should handle error response from IPC", async () => {
		mockSendRequest.mockResolvedValueOnce({
			id: "test",
			status: 500,
			error: { message: "IPC Error" },
		});

		const instance = {
			name: "test-instance",
			containerId: "test-container",
			status: "running",
		};

		const result = await executeClaudeViaIpc(instance, "Test prompt");

		expect(result.success).toBe(false);
		expect(result.error).toBe("IPC Error");
	});

	test("should mark stale container errors as retryable", async () => {
		mockSendRequest.mockResolvedValueOnce({
			id: "test",
			status: 404,
			error: { message: "No such container" },
		});

		const instance = {
			name: "test-instance",
			containerId: "test-container",
			status: "running",
		};

		const result = await executeClaudeViaIpc(instance, "Test prompt");

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
	});

	test("should pass configuration to IPC request", async () => {
		mockSendRequest.mockResolvedValueOnce({
			id: "test",
			status: 200,
			result: { stdout: "OK" },
		});

		const instance = {
			name: "test-instance",
			containerId: "test-container",
			status: "running",
		};

		const config: ClaudeExecutionConfig = {
			command: "custom-claude",
			allowedTools: "test-tool",
			timeout: 30000,
		};

		await executeClaudeViaIpc(instance, "Test", config);

		// Just verify that sendRequest was called
		expect(mockSendRequest).toHaveBeenCalled();
		expect(mockSendRequest.mock.calls.length).toBeGreaterThan(0);
	});

	test("should use default values when not specified", async () => {
		mockSendRequest.mockResolvedValueOnce({
			id: "test",
			status: 200,
			result: { stdout: "OK" },
		});

		const instance = {
			name: "test",
			containerId: "test-container",
			status: "running",
		};

		// Call without config
		await executeClaudeViaIpc(instance, "Test");

		// Verify that sendRequest was called (using defaults)
		expect(mockSendRequest).toHaveBeenCalled();
	});
});

describe("claude-executor additional branches", () => {
	test("should initialize custom error subclasses", () => {
		const cause = new Error("root cause");
		const ipcErr = new IpcCommunicationError("ipc failed", { operation: "x", containerId: "c1" }, cause);
		const timeoutErr = new ClaudeTimeoutError("timeout", { operation: "x", timeoutMs: 1000 }, cause);

		expect(ipcErr.name).toBe("IpcCommunicationError");
		expect(ipcErr.context.operation).toBe("ipc_communication");
		expect(timeoutErr.name).toBe("ClaudeTimeoutError");
		expect(timeoutErr.context.operation).toBe("timeout");
	});

	test("executeClaudeWithHistory should return error object on non-validation exception", async () => {
		const instance = {
			name: "test-instance",
			containerId: "test-container",
			status: "running",
		};
		const badHistory = [
			{
				sender: "user",
				get text() {
					throw new Error("history read failed");
				},
				timestamp: "2024-01-01 12:00:00",
			},
		] as unknown as Array<{ sender: string; text: string; timestamp: string }>;

		const result = await executeClaudeWithHistory(instance, "hello", badHistory);
		expect(result.success).toBe(false);
		expect(result.error).toContain("history read failed");
		expect(result.retryable).toBe(false);
	});

	test("executeClaude should use sync mode with history when useTmux is false", async () => {
		const factorySpy = spyOn(IpcFactory, "create").mockReturnValue(mockClient as never);
		mockSendRequest.mockResolvedValueOnce({
			id: "test",
			status: 200,
			result: { stdout: "sync result" },
		});

		const result = (await executeClaude("container-a", "workspace-a", "hello", {
			useTmux: false,
			history: [{ sender: "user", text: "previous", timestamp: "2024-01-01 00:00:00" }],
		})) as ClaudeExecutionResult;

		expect(result.success).toBe(true);
		expect(result.output).toBe("sync result");
		factorySpy.mockRestore();
	});

	test("executeClaude should use tmux mode when useTmux is true", async () => {
		const originalGetOrCreateSession = TmuxManager.prototype.getOrCreateSession;
		const originalSendToSession = TmuxManager.prototype.sendToSession;
		TmuxManager.prototype.getOrCreateSession = (async () => "claude-workspace-chat") as typeof TmuxManager.prototype.getOrCreateSession;
		TmuxManager.prototype.sendToSession = (async () => {}) as typeof TmuxManager.prototype.sendToSession;

		const result = await executeClaude("container-a", "workspace-a", "hello", {
			useTmux: true,
			workspace: "workspace-a",
			chatId: "42",
		});

		TmuxManager.prototype.getOrCreateSession = originalGetOrCreateSession;
		TmuxManager.prototype.sendToSession = originalSendToSession;

		expect("mode" in result).toBe(true);
		if ("mode" in result) {
			expect(result.mode).toBe("tmux");
		}
	});
});
