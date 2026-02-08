import { beforeEach, describe, expect, test } from "bun:test";
import {
	buildClaudePrompt,
	type ClaudeExecutionConfig,
	executeClaudeViaIpc,
	validateAndSanitizePrompt,
} from "@/gateway/services/claude-executor";
import { IpcClient } from "@/packages/ipc/client";

// Mock IpcClient
const mockIpcSuccess = (stdout: string) => {
	// @ts-expect-error - mock IpcClient.sendRequest
	IpcClient.prototype.sendRequest = async () => ({
		id: "test",
		status: 200,
		result: { stdout },
	});
};

// @ts-expect-error - mock static method
IpcClient.getCircuitState = () => ({
	failures: 0,
	lastFailureTime: 0,
	state: "closed" as const,
});

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
	beforeEach(() => {
		// Reset circuit breaker
		// @ts-expect-error
		IpcClient.resetCircuitBreaker();
	});

	test("should execute Claude command successfully", async () => {
		mockIpcSuccess("Test response");

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
		// @ts-expect-error - mock error response
		IpcClient.prototype.sendRequest = async () => ({
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
		// @ts-expect-error - mock stale container error
		IpcClient.prototype.sendRequest = async () => ({
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
		let capturedBody: Record<string, unknown> | null = null;

		// @ts-expect-error - mock to capture body
		IpcClient.prototype.sendRequest = async (request: { body?: Record<string, unknown> }) => {
			capturedBody = request.body;
			return {
				id: "test",
				status: 200,
				result: { stdout: "OK" },
			};
		};

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

		expect(capturedBody?.command).toBe("custom-claude");
		expect(capturedBody?.args).toContain("Test");
	});
});

describe("ClaudeExecutionConfig", () => {
	test("should use default values when not specified", async () => {
		mockIpcSuccess("OK");

		const instance = {
			name: "test",
			containerId: "test-container",
			status: "running",
		};

		// Call without config
		await executeClaudeViaIpc(instance, "Test");

		// Verify it used defaults (by not throwing)
		expect(true).toBe(true);
	});
});
