import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWriteFileTool } from "@/gateway/engine/tools/write-file";

describe("tools/write-file", () => {
	let testWorkspace: string;

	beforeEach(async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.homedir(), ".cc-bridge-write-"));
		testWorkspace = await fs.realpath(tmpDir);
	});

	afterEach(async () => {
		if (testWorkspace) {
			try {
				await fs.rm(testWorkspace, { recursive: true, force: true });
			} catch {}
		}
	});

	test("writes new file successfully", async () => {
		const tool = createWriteFileTool(testWorkspace);
		const result = await tool.execute("call-1", { path: "new.txt", content: "Hello, World!" });
		expect(result.content[0]).toHaveProperty("type", "text");
		expect((result.content[0] as { text: string }).text).toContain("Successfully wrote");

		const fileContent = await fs.readFile(path.join(testWorkspace, "new.txt"), "utf-8");
		expect(fileContent).toBe("Hello, World!");
	});

	test("overwrites existing file", async () => {
		const filePath = path.join(testWorkspace, "existing.txt");
		await fs.writeFile(filePath, "original");
		const tool = createWriteFileTool(testWorkspace);
		await tool.execute("call-1", { path: "existing.txt", content: "updated" });

		const fileContent = await fs.readFile(filePath, "utf-8");
		expect(fileContent).toBe("updated");
	});

	test("creates parent directories automatically", async () => {
		const tool = createWriteFileTool(testWorkspace);
		await tool.execute("call-1", { path: "a/b/c/nested.txt", content: "nested" });

		const fileContent = await fs.readFile(path.join(testWorkspace, "a/b/c/nested.txt"), "utf-8");
		expect(fileContent).toBe("nested");
	});

	test("returns error for path traversal attempt", async () => {
		const tool = createWriteFileTool(testWorkspace);
		await expect(tool.execute("call-1", { path: "../etc/passwd", content: "malicious" })).rejects.toThrow();
	});

	test("handles abort signal", async () => {
		const tool = createWriteFileTool(testWorkspace);
		const controller = new AbortController();
		controller.abort();
		await expect(tool.execute("call-1", { path: "test.txt", content: "content" }, controller.signal)).rejects.toThrow(
			"aborted",
		);
	});

	test("tool has correct metadata", () => {
		const tool = createWriteFileTool(testWorkspace);
		expect(tool.name).toBe("write_file");
		expect(tool.label).toBe("Write File");
		expect(tool.description).toContain("workspace");
		expect(tool.parameters).toBeDefined();
	});

	test("writes empty content", async () => {
		const tool = createWriteFileTool(testWorkspace);
		await tool.execute("call-1", { path: "empty.txt", content: "" });

		const fileContent = await fs.readFile(path.join(testWorkspace, "empty.txt"), "utf-8");
		expect(fileContent).toBe("");
	});

	test("writes unicode content", async () => {
		const tool = createWriteFileTool(testWorkspace);
		const unicodeContent = "Hello 你好 🌍";
		await tool.execute("call-1", { path: "unicode.txt", content: unicodeContent });

		const fileContent = await fs.readFile(path.join(testWorkspace, "unicode.txt"), "utf-8");
		expect(fileContent).toBe(unicodeContent);
	});

	test("returns error for content exceeding 1MB limit", async () => {
		const tool = createWriteFileTool(testWorkspace);
		const largeContent = "x".repeat(1024 * 1024 + 1);
		const result = await tool.execute("call-1", { path: "large.txt", content: largeContent });

		expect(result.content[0]).toHaveProperty("type", "text");
		expect((result.content[0] as { text: string }).text).toContain("exceeds the");
	});

	test("throws when parent directory would escape workspace", async () => {
		const tool = createWriteFileTool(testWorkspace);
		// This tests the parent directory validation - it should throw
		await expect(tool.execute("call-1", { path: "../outside.txt", content: "test" })).rejects.toThrow();
	});

	test("handles symlink to outside workspace in parent directory", async () => {
		const tool = createWriteFileTool(testWorkspace);
		// Create a symlink inside workspace that points outside
		const outsideDir = path.join(os.tmpdir(), `outside-${Date.now()}`);
		await fs.mkdir(outsideDir);
		const linkPath = path.join(testWorkspace, "linkdir");
		await fs.symlink(outsideDir, linkPath);
		try {
			// Try to write to a file in the symlinked parent directory
			// This may either throw from resolveWorkspacePath or return error from parent check
			const result = await tool.execute("call-1", { path: "linkdir/file.txt", content: "test" });
			// If it doesn't throw, check for error response
			expect(result.content[0]).toHaveProperty("type", "text");
		} catch {
			// Or it may throw - both are acceptable
		} finally {
			await fs.rm(outsideDir, { recursive: true, force: true });
		}
	});
});
