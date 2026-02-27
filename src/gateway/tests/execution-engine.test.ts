import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as claudeExecutor from "@/gateway/services/claude-executor";
import { executeMiniAppPrompt } from "@/gateway/services/execution-engine";
import { logger } from "@/packages/logger";

function textStream(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

describe("execution-engine", () => {
	afterEach(() => {
		mock.restore();
	});

	test("returns error for container engine without instance", async () => {
		const result = await executeMiniAppPrompt({
			engine: "claude_container",
			contextMode: "fresh",
			basePrompt: "hello",
			workspace: "cc-bridge",
			timeoutMs: 1000,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("requires a running instance");
	});

	test("uses container Claude path and forwards command overrides", async () => {
		const rawSpy = spyOn(claudeExecutor, "executeClaudeRaw").mockResolvedValue({
			success: true,
			output: "ok",
		});

		const result = await executeMiniAppPrompt({
			engine: "claude_container",
			contextMode: "fresh",
			basePrompt: "run this",
			workspace: "cc-bridge",
			timeoutMs: 2000,
			chatId: "chat-1",
			history: [{ sender: "user", text: "older", timestamp: "2026-01-01 00:00:00" }],
			instance: {
				name: "cc-bridge",
				containerId: "container-1",
				status: "running",
				image: "img",
			},
			engineCommand: "claude-custom",
			engineArgs: ["-p", "{{prompt}}"],
		});

		expect(result.success).toBe(true);
		expect(rawSpy).toHaveBeenCalledWith("container-1", "cc-bridge", "run this", {
			workspace: "cc-bridge",
			chatId: "chat-1",
			timeout: 2000,
			command: "claude-custom",
			args: ["-p", "{{prompt}}"],
		});
	});

	test("builds history-aware prompt for container engine in existing mode", async () => {
		const rawSpy = spyOn(claudeExecutor, "executeClaudeRaw").mockResolvedValue({
			success: true,
			output: "ok",
		});

		await executeMiniAppPrompt({
			engine: "claude_container",
			contextMode: "existing",
			basePrompt: "current",
			workspace: "cc-bridge",
			timeoutMs: 2000,
			instance: {
				name: "cc-bridge",
				containerId: "container-1",
				status: "running",
				image: "img",
			},
			history: [{ sender: "user", text: "older", timestamp: "2026-01-01 00:00:00" }],
		});

		const call = rawSpy.mock.calls[0];
		expect(call).toBeDefined();
		const prompt = call?.[2] as string;
		expect(prompt).toContain("<messages>");
		expect(prompt).toContain("older");
		expect(prompt).toContain("current");
	});

	test("runs claude_host with default command/args", async () => {
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: textStream("host-ok"),
			stderr: textStream(""),
			exited: Promise.resolve(0),
			kill: () => {},
		} as unknown as ReturnType<typeof Bun.spawn>);

		const result = await executeMiniAppPrompt({
			engine: "claude_host",
			contextMode: "existing",
			basePrompt: "do it",
			workspace: "cc-bridge",
			timeoutMs: 2000,
			history: [{ sender: "user", text: "older", timestamp: "2026-01-01 00:00:00" }],
		});

		expect(result.success).toBe(true);
		expect(result.output).toBe("host-ok");

		const [cmd, options] = spawnSpy.mock.calls[0] as [string[], { cwd?: string }];
		expect(cmd[0]).toBe("claude");
		expect(cmd).toContain("--dangerously-skip-permissions");
		expect(cmd).toContain("--allowedTools=*");
		expect(cmd.join(" ")).toContain("<messages>");
		expect(options.cwd).toContain("cc-bridge");
	});

	test("runs codex_host with plain context prompt for existing mode", async () => {
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: textStream("codex-ok"),
			stderr: textStream(""),
			exited: Promise.resolve(0),
			kill: () => {},
		} as unknown as ReturnType<typeof Bun.spawn>);

		const result = await executeMiniAppPrompt({
			engine: "codex_host",
			contextMode: "existing",
			basePrompt: "current request",
			workspace: "cc-bridge",
			timeoutMs: 2000,
			history: [{ sender: "user", text: "older", timestamp: "2026-01-01 00:00:00" }],
		});

		expect(result.success).toBe(true);
		const [cmd] = spawnSpy.mock.calls[0] as [string[]];
		expect(cmd[0]).toBe("codex");
		expect(cmd[1]).toContain("Conversation context:");
		expect(cmd[1]).toContain("older");
		expect(cmd[1]).toContain("Current request:");
	});

	test("applies placeholder interpolation and missing workspace fallback for host engine", async () => {
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: textStream("ok"),
			stderr: textStream(""),
			exited: Promise.resolve(0),
			kill: () => {},
		} as unknown as ReturnType<typeof Bun.spawn>);

		await executeMiniAppPrompt({
			engine: "claude_host",
			contextMode: "fresh",
			basePrompt: "payload",
			workspace: "workspace-does-not-exist-xyz",
			timeoutMs: 2000,
			chatId: 42,
			engineCommand: "my-claude",
			engineArgs: ["-p", "{{prompt}}", "--ws", "{{workspace}}", "--chat", "{{chat_id}}"],
		});

		const [cmd, options] = spawnSpy.mock.calls[0] as [string[], { cwd?: string }];
		expect(cmd).toEqual(["my-claude", "-p", "payload", "--ws", "workspace-does-not-exist-xyz", "--chat", "42"]);
		expect(options.cwd).toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();
	});

	test("returns command failure when host process exits non-zero", async () => {
		spyOn(Bun, "spawn").mockReturnValue({
			stdout: textStream(""),
			stderr: textStream("boom"),
			exited: Promise.resolve(2),
			kill: () => {},
		} as unknown as ReturnType<typeof Bun.spawn>);

		const result = await executeMiniAppPrompt({
			engine: "claude_host",
			contextMode: "fresh",
			basePrompt: "x",
			workspace: "cc-bridge",
			timeoutMs: 2000,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("boom");
		expect(result.exitCode).toBe(2);
	});

	test("returns timeout when host command exceeds timeout", async () => {
		const killSpy = spyOn({ kill: () => {} }, "kill");
		spyOn(Bun, "spawn").mockReturnValue({
			stdout: textStream(""),
			stderr: textStream(""),
			exited: Promise.resolve(0),
			kill: killSpy,
		} as unknown as ReturnType<typeof Bun.spawn>);

		const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler) => {
			if (typeof fn === "function") fn();
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout);

		const result = await executeMiniAppPrompt({
			engine: "codex_host",
			contextMode: "fresh",
			basePrompt: "x",
			workspace: "cc-bridge",
			timeoutMs: 5,
		});

		expect(result.success).toBe(false);
		expect(result.isTimeout).toBe(true);
		expect(killSpy).toHaveBeenCalled();

		timeoutSpy.mockRestore();
	});

	test("returns exception message when host subprocess promise rejects", async () => {
		spyOn(Bun, "spawn").mockReturnValue({
			stdout: textStream(""),
			stderr: textStream(""),
			exited: Promise.reject(new Error("subprocess failed")),
			kill: () => {},
		} as unknown as ReturnType<typeof Bun.spawn>);

		const result = await executeMiniAppPrompt({
			engine: "claude_host",
			contextMode: "fresh",
			basePrompt: "x",
			workspace: "cc-bridge",
			timeoutMs: 2000,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("subprocess failed");
	});
});
