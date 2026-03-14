import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWorkspacePath } from "@/gateway/engine/tools/utils";

describe("tools/utils", () => {
	let testWorkspace: string;

	beforeEach(async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.homedir(), ".cc-bridge-utils-"));
		testWorkspace = await fs.realpath(tmpDir);
	});

	afterEach(async () => {
		if (testWorkspace) {
			try {
				await fs.rm(testWorkspace, { recursive: true, force: true });
			} catch {}
		}
	});

	test("resolveWorkspacePath - valid path within workspace", async () => {
		const filePath = "subdir/test.txt";
		const result = await resolveWorkspacePath(testWorkspace, filePath);
		expect(result).toContain("subdir");
		expect(result).toContain("test.txt");
	});

	test("resolveWorkspacePath - path traversal attempt rejected", async () => {
		await expect(resolveWorkspacePath(testWorkspace, "../etc/passwd")).rejects.toThrow();
	});

	test("resolveWorkspacePath - absolute path traversal rejected", async () => {
		await expect(resolveWorkspacePath(testWorkspace, "/etc/passwd")).rejects.toThrow();
	});

	test("resolveWorkspacePath - same as workspace directory", async () => {
		const result = await resolveWorkspacePath(testWorkspace, ".");
		expect(result.startsWith(testWorkspace)).toBe(true);
	});

	test("resolveWorkspacePath - nested path traversal rejected", async () => {
		await expect(resolveWorkspacePath(testWorkspace, "foo/../../../bar")).rejects.toThrow();
	});

	test("resolveWorkspacePath - non-existent file in existing parent", async () => {
		const result = await resolveWorkspacePath(testWorkspace, "nonexistent.txt");
		expect(result).toContain("nonexistent.txt");
	});

	test("resolveWorkspacePath - deeply nested valid path", async () => {
		const result = await resolveWorkspacePath(testWorkspace, "a/b/c/d/file.txt");
		expect(result).toContain("a/b/c/d/file.txt");
	});

	test("resolveWorkspacePath - rejects symlink pointing outside workspace", async () => {
		// Create a subdirectory
		const subDir = path.join(testWorkspace, "subdir");
		await fs.mkdir(subDir);

		// Create a symlink outside workspace
		const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
		const symlinkPath = path.join(subDir, "escape");
		await fs.symlink(outsideDir, symlinkPath);

		// Try to resolve a path through the symlink
		await expect(resolveWorkspacePath(testWorkspace, "subdir/escape")).rejects.toThrow();

		// Clean up
		await fs.rm(outsideDir, { recursive: true, force: true });
	});

	test("resolveWorkspacePath - throws for non-existent workspace", async () => {
		const nonExistent = path.join(os.tmpdir(), `nonexistent-${Date.now()}`);
		await expect(resolveWorkspacePath(nonExistent, "test.txt")).rejects.toThrow();
	});

	test("resolveWorkspacePath - existing file resolves to realpath", async () => {
		const filePath = path.join(testWorkspace, "existing.txt");
		await fs.writeFile(filePath, "content");

		const result = await resolveWorkspacePath(testWorkspace, "existing.txt");
		expect(result).toBe(filePath);
	});
});
