import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadFileTool } from "@/packages/agent";

describe("tools/read-file", () => {
	let testWorkspace: string;

	beforeEach(async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.homedir(), ".cc-bridge-read-"));
		testWorkspace = await fs.realpath(tmpDir);
	});

	afterEach(async () => {
		if (testWorkspace) {
			try {
				await fs.rm(testWorkspace, { recursive: true, force: true });
			} catch {}
		}
	});

	test("reads existing file successfully", async () => {
		const filePath = path.join(testWorkspace, "test.txt");
		await fs.writeFile(filePath, "Hello, World!");
		const tool = createReadFileTool(testWorkspace);
		const result = await tool.execute("call-1", { path: "test.txt" });
		expect(result.content[0]).toEqual({ type: "text", text: "Hello, World!" });
	});

	test("returns error for non-existent file", async () => {
		const tool = createReadFileTool(testWorkspace);
		await expect(tool.execute("call-1", { path: "nonexistent.txt" })).rejects.toThrow();
	});

	test("returns error for path traversal attempt", async () => {
		const tool = createReadFileTool(testWorkspace);
		await expect(tool.execute("call-1", { path: "../etc/passwd" })).rejects.toThrow();
	});

	test("returns error for directory instead of file", async () => {
		const dirPath = path.join(testWorkspace, "subdir");
		await fs.mkdir(dirPath);
		const tool = createReadFileTool(testWorkspace);
		const result = await tool.execute("call-1", { path: "subdir" });
		expect(result.content[0]).toHaveProperty("type", "text");
		expect((result.content[0] as { text: string }).text).toContain("not a regular file");
	});

	test("reads nested file path", async () => {
		const subdir = path.join(testWorkspace, "a", "b", "c");
		await fs.mkdir(subdir, { recursive: true });
		const filePath = path.join(subdir, "nested.txt");
		await fs.writeFile(filePath, "nested content");
		const tool = createReadFileTool(testWorkspace);
		const result = await tool.execute("call-1", { path: "a/b/c/nested.txt" });
		expect(result.content[0]).toEqual({ type: "text", text: "nested content" });
	});

	test("handles abort signal", async () => {
		const filePath = path.join(testWorkspace, "test.txt");
		await fs.writeFile(filePath, "content");
		const tool = createReadFileTool(testWorkspace);
		const controller = new AbortController();
		controller.abort();
		await expect(tool.execute("call-1", { path: "test.txt" }, controller.signal)).rejects.toThrow("aborted");
	});

	test("tool has correct metadata", () => {
		const tool = createReadFileTool(testWorkspace);
		expect(tool.name).toBe("read_file");
		expect(tool.label).toBe("Read File");
		expect(tool.description).toContain("workspace");
		expect(tool.parameters).toBeDefined();
	});

	test("returns error for file exceeding 100KB size limit", async () => {
		const filePath = path.join(testWorkspace, "large.txt");
		// Create a file larger than 100KB
		const largeContent = "x".repeat(100 * 1024 + 1);
		await fs.writeFile(filePath, largeContent);

		const tool = createReadFileTool(testWorkspace);
		const result = await tool.execute("call-1", { path: "large.txt" });

		expect(result.content[0]).toHaveProperty("type", "text");
		expect((result.content[0] as { text: string }).text).toContain("exceeds");
	});
});
