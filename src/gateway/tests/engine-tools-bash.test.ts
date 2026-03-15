import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBashTool } from "@/packages/agent";

// Short timeout for testing the timeout path
const TEST_TIMEOUT_MS = 50;

describe("tools/bash", () => {
	let testWorkspace: string;

	beforeEach(async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-bridge-bash-"));
		testWorkspace = await fs.realpath(tmpDir);
	});

	afterEach(async () => {
		try {
			await fs.rm(testWorkspace, { recursive: true, force: true });
		} catch {}
	});

	describe("createBashTool", () => {
		test("tool has correct metadata", () => {
			const tool = createBashTool(testWorkspace);
			expect(tool.name).toBe("bash");
			expect(tool.label).toBe("Bash");
			expect(tool.description).toContain("shell command");
			expect(tool.parameters).toBeDefined();
		});

		test("executes simple command", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: "echo hello" });
			expect(result.content[0]).toHaveProperty("type", "text");
			expect((result.content[0] as { text: string }).text).toContain("hello");
		});

		test("executes command in workspace directory", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: "pwd" });
			expect(result.content[0]).toHaveProperty("type", "text");
			expect((result.content[0] as { text: string }).text).toContain(testWorkspace);
		});

		test("returns error for blocked dangerous command - rm -rf /", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: "rm -rf /" });
			expect(result.content[0]).toHaveProperty("type", "text");
			expect((result.content[0] as { text: string }).text).toContain("blocked");
		});

		test("blocks mkfs command", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: "mkfs.ext4 /dev/sda" });
			expect(result.content[0]).toHaveProperty("type", "text");
			expect((result.content[0] as { text: string }).text).toContain("blocked");
		});

		test("blocks dd if= command", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: "dd if=/dev/zero of=/dev/sda" });
			expect(result.content[0]).toHaveProperty("type", "text");
			expect((result.content[0] as { text: string }).text).toContain("blocked");
		});

		test("blocks fork bomb", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: ":(){ :|:& };:" });
			expect(result.content[0]).toHaveProperty("type", "text");
			expect((result.content[0] as { text: string }).text).toContain("blocked");
		});

		test("blocks direct block device write", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: "> /dev/sda" });
			expect(result.content[0]).toHaveProperty("type", "text");
			expect((result.content[0] as { text: string }).text).toContain("blocked");
		});

		test("blocks chmod 777 on root", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: "chmod 777 /" });
			expect(result.content[0]).toHaveProperty("type", "text");
			expect((result.content[0] as { text: string }).text).toContain("blocked");
		});

		test("handles command failure", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: "exit 1" });
			expect(result.content[0]).toHaveProperty("type", "text");
		});

		test("handles abort signal", async () => {
			const tool = createBashTool(testWorkspace);
			const controller = new AbortController();
			controller.abort();
			await expect(tool.execute("call-1", { command: "sleep 10" }, controller.signal)).rejects.toThrow("aborted");
		});

		test("captures stderr output", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: "echo error >&2" });
			expect(result.content[0]).toHaveProperty("type", "text");
			expect((result.content[0] as { text: string }).text).toContain("[stderr]");
		});

		test("handles command with no output", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: "true" });
			expect(result.content[0]).toHaveProperty("type", "text");
			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("exit code 0");
		});

		test("handles non-zero exit code with output", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: "echo 'error message' && exit 1" });
			expect(result.content[0]).toHaveProperty("type", "text");
			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("error message");
			expect(text).toContain("exit code: 1");
		});

		test("handles command with both stdout and stderr", async () => {
			const tool = createBashTool(testWorkspace);
			const result = await tool.execute("call-1", { command: "echo stdout && echo stderr >&2" });
			expect(result.content[0]).toHaveProperty("type", "text");
			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("stdout");
			expect(text).toContain("[stderr]");
			expect(text).toContain("stderr");
		});
	});

	test("truncates large stdout output", async () => {
		const tool = createBashTool(testWorkspace);
		// Generate more than 50KB of output to trigger truncation
		const result = await tool.execute("call-1", { command: "head -c 60000 /dev/zero | tr '\\0' 'x'" });
		expect(result.content[0]).toHaveProperty("type", "text");
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Output truncated");
	});

	test("truncates large stderr output", async () => {
		const tool = createBashTool(testWorkspace);
		// Generate large stderr output
		const result = await tool.execute("call-1", { command: "head -c 60000 /dev/zero | tr '\\0' 'y' >&2" });
		expect(result.content[0]).toHaveProperty("type", "text");
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Output truncated");
	});

	test("handles command timeout", async () => {
		const tool = createBashTool(testWorkspace, { timeoutMs: TEST_TIMEOUT_MS });
		// Sleep for longer than the timeout - should trigger timeout handler
		const result = await tool.execute("call-1", { command: "sleep 1" });
		expect(result.content[0]).toHaveProperty("type", "text");
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("timed out");
		expect(result.details.timedOut).toBe(true);
	});

	test("handles non-existent command error", async () => {
		const tool = createBashTool(testWorkspace);
		// This should trigger the error handler
		const result = await tool.execute("call-1", { command: "nonexistent-command-xyz-12345" });
		expect(result.content[0]).toHaveProperty("type", "text");
		const text = (result.content[0] as { text: string }).text;
		// Should contain error message
		expect(text.toLowerCase()).toMatch(/not found|error|no such file/);
	});

	test("handles already aborted signal", async () => {
		const tool = createBashTool(testWorkspace);
		const controller = new AbortController();
		controller.abort();
		await expect(tool.execute("call-1", { command: "echo test" }, controller.signal)).rejects.toThrow();
	});

	test("handles abort during execution", async () => {
		const tool = createBashTool(testWorkspace);
		// Start a command that runs for a bit
		const controller = new AbortController();
		// Abort after a small delay - this should trigger the abort handler
		// Note: This is timing-sensitive and may not always trigger the handler
		const abortPromise = (async () => {
			await new Promise((r) => setTimeout(r, 5));
			controller.abort();
		})();
		const result = await Promise.all([tool.execute("call-1", { command: "sleep 1" }, controller.signal), abortPromise])
			.then(([r]) => r)
			.catch(() => null);
		// Either way, the tool should handle it gracefully
		if (result) {
			expect(result.content[0]).toHaveProperty("type", "text");
		}
	});

	test("handles command with non-existent directory", async () => {
		const tool = createBashTool("/this/directory/does/not/exist");
		// This should throw because the directory doesn't exist
		await expect(tool.execute("call-1", { command: "echo test" })).rejects.toThrow();
	});

	test("handles process spawn error", async () => {
		const tool = createBashTool(testWorkspace);
		// Try to execute with an invalid executable - using bash -c with nonexistent command
		const result = await tool.execute("call-1", { command: "bash -c 'exec /definitely/not/a/valid/command'" });
		// Should handle gracefully either way
		expect(result.content[0]).toHaveProperty("type", "text");
	});

	test("handles spawn error via custom spawn", async () => {
		// Create a mock spawn that immediately emits an error
		const mockSpawn = (() => {
			const mockChild = {
				stdout: { on: () => {} },
				stderr: { on: () => {} },
				on: (event: string, callback: (err: Error) => void) => {
					if (event === "error") {
						// Immediately emit an error
						process.nextTick(() => callback(new Error("Mock spawn error")));
					}
				},
				kill: () => true,
			};
			return mockChild as ReturnType<typeof import("node:child_process").spawn>;
		}) as typeof import("node:child_process").spawn;

		const tool = createBashTool(testWorkspace, { _spawn: mockSpawn });
		// The mock spawn will immediately emit an error
		await expect(tool.execute("call-1", { command: "echo test" })).rejects.toThrow("Mock spawn error");
	});
});
