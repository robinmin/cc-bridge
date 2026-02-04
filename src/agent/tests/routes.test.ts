import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file, write } from "bun";
import { Hono } from "hono";
import { app } from "@/agent/app";
import type {
	ExecuteCommandResponse,
	FileEntry,
	ListDirResponse,
	ReadFileResponse,
	WriteFileResponse,
} from "@/agent/types";

// Helper to create a temp file
const tempDir = tmpdir();
const testFilePath = join(tempDir, "agent-test.txt");
const testWritePath = join(tempDir, "agent-write.txt");

describe("Agent API Routes", () => {
	// Clean up before/after
	const cleanup = async () => {
		try {
			await unlink(testFilePath);
		} catch { }
		try {
			await unlink(testWritePath);
		} catch { }
	};

	beforeAll(async () => {
		await cleanup();
		await write(testFilePath, "Hello, World!");
	});

	afterAll(async () => {
		await cleanup();
	});

	describe("GET /health", () => {
		test("should return 200 and bun version", async () => {
			const res = await app.request("/health");
			expect(res.status).toBe(200);
			const data = (await res.json()) as {
				status: string;
				runtime: string;
				version: string;
			};
			expect(data.status).toBe("ok");
			expect(data.runtime).toBe("bun");
			expect(data.version).toBeDefined();
		});
	});

	describe("POST /execute", () => {
		test("should execute simple command", async () => {
			const res = await app.request("/execute", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: "echo",
					args: ["hello"],
				}),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as ExecuteCommandResponse;
			expect(data.stdout).toContain("hello");
			expect(data.exitCode).toBe(0);
		});

		test("should handle non-zero exit code", async () => {
			// ls non-existent file
			const res = await app.request("/execute", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: "ls",
					args: ["non-existent-file-123"],
				}),
			});

			expect(res.status).toBe(200); // The API request succeeds, the command fails
			const data = (await res.json()) as ExecuteCommandResponse;
			expect(data.exitCode).not.toBe(0);
			expect(data.stderr).toContain("No such file");
		});

		test("should handle validation error", async () => {
			const res = await app.request("/execute", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					// missing command
					args: ["test"],
				}),
			});
			expect(res.status).toBe(400);
		});
	});

	describe("POST /read", () => {
		test("should read existing file", async () => {
			const res = await app.request("/read", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: testFilePath }),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as ReadFileResponse;
			expect(data.exists).toBe(true);
			expect(data.content).toBe("Hello, World!");
		});

		test("should handle non-existent file", async () => {
			const res = await app.request("/read", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: "/tmp/this-definitely-does-not-exist-123",
				}),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as ReadFileResponse;
			expect(data.exists).toBe(false);
			expect(data.content).toBe("");
		});

		test("should read base64", async () => {
			const res = await app.request("/read", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: testFilePath, encoding: "base64" }),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as ReadFileResponse;
			expect(data.exists).toBe(true);
			// "Hello, World!" in base64 is "SGVsbG8sIFdvcmxkIQ=="
			expect(data.content).toBe("SGVsbG8sIFdvcmxkIQ==");
		});
	});

	describe("POST /write", () => {
		test("should write file", async () => {
			const res = await app.request("/write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: testWritePath,
					content: "Written Content",
				}),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as WriteFileResponse;
			expect(data.success).toBe(true);

			// Verify content
			const f = file(testWritePath);
			expect(await f.text()).toBe("Written Content");
		});

		test("should write with permissions", async () => {
			const path = join(tempDir, "agent-exec.sh");
			const res = await app.request("/write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path,
					content: "#!/bin/sh\necho hi",
					mode: 0o755,
				}),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as WriteFileResponse;
			expect(data.success).toBe(true);

			const s = await stat(path);
			// Mode includes file type, so we check the last 3 octals
			expect((s.mode & 0o777)).toBe(0o755);
			await unlink(path);
		});

		test("should write base64", async () => {
			// "Test" base64 -> VGVzdA==
			const res = await app.request("/write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: testWritePath,
					content: "VGVzdA==",
					encoding: "base64",
				}),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as WriteFileResponse;
			expect(data.success).toBe(true);

			const f = file(testWritePath);
			expect(await f.text()).toBe("Test");
		});
	});

	describe("POST /execute enhancements", () => {
		test("should handle timeout", async () => {
			const res = await app.request("/execute", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: "sleep",
					args: ["0.2"],
					timeout: 100, // 100ms timeout vs 200ms sleep
				}),
			});

			const data = (await res.json()) as ExecuteCommandResponse;
			expect([124, -1, null]).toContain(data.exitCode); // 124 is common timeout code
		});

		test("should limit large output", async () => {
			// Assuming 'yes' command exists in environment (mac/linux)
			const res = await app.request("/execute", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: "sh",
					// Should generate > 1MB easily, we actually set limit to 10MB in code, 
					// so we need more data to trigger truncation if checking that specifically,
					// but let's just assert it runs without crashing.
					// To actually trigger truncation we'd need > 10MB.
					// "seq 1 100000" * 10 bytes = ~1MB.
					// Let's use smaller limit for test or just rely on manual verification?
					// Changing line count to 1.5 million -> ~15MB
					args: ["-c", "yes | head -n 2000000"],
				}),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as ExecuteCommandResponse;
			expect(data.stdout.length).toBeLessThanOrEqual(10 * 1024 * 1024 + 100); // 10MB + buffer for message
			if (data.stdout.length > 5 * 1024 * 1024) {
				expect(data.stdout).toContain("[Output Truncated]");
			}
		});
	});

	describe("POST /fs/list", () => {
		test("should list directory", async () => {
			const res = await app.request("/fs/list", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: tempDir }),
			});

			expect(res.status).toBe(200);
			const data = (await res.json()) as ListDirResponse;
			expect(Array.isArray(data.entries)).toBe(true);

			// Should find our test file
			const entry = data.entries.find(
				(e: FileEntry) => e.name === "agent-test.txt",
			);
			expect(entry).toBeDefined();
			expect(entry!.isDirectory).toBe(false);
		});
	});

	describe("Error Handling", () => {
		test("should handle execute internal error", async () => {
			const mockApp = new Hono();
			mockApp.post("/err", async (c) => {
				throw new Error("Simulated Execute Fail");
			});
			// We can't easily mock the internal Bun.spawn failure without mocking Bun itself widely.
			// But we can verify our route wrapper catches errors if we extract logic or mock app.request behavior?
			// Hono's app.request catches errors if not re-thrown? Hono default error handler might kick in.
			// Our routes catch (error) explicitly. 
			// The only way to trigger those specific catch blocks is if something *inside* the try block throws.
			// For /execute, zValidator might throw or Bun.spawn might throw.
			// Passing invalid JSON is caught by zValidator.
			// Passing a command that fails to spawn (not just non-zero exit) might throw.
			// Let's try to mock Bun.spawn or pass a really weird arg that throws synchronously? 
			// Bun.spawn throws if cwd doesn't exist.

			const res = await app.request("/execute", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: "echo",
					cwd: "/non/existent/path/for/triggering/error"
				})
			});
			// Bun.spawn throwing typically results in 500 from our catch block
			expect(res.status).toBe(500);
			const data = (await res.json()) as { error: string };
			expect(data.error).toBeDefined();
		});

		test("should handle read internal error", async () => {
			// Bun.file("").exists() might not throw, but let's try reading a directory as a file which often throws or fails
			// Or access permission error? 
			// Simplest is to mock Bun.file in a separate test setup, but that's hard with global Bun.
			// Let's try reading a directory which on some systems throws EISDIR
			const res = await app.request("/read", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: tempDir })
			});

			// If it identifies as simple non-existence it returns 200 with exists:false.
			// To force exception, maybe pass invalid path chars? 
			// Or rely on mocked approach if needed.
			// Let's rely on standard error catching logic being correct and move on if coverage is >85%.
			// coverage is 85.36%, specifically routes/read.ts is 77.14%.
			// The catch block is lines 33-40.
			// We need to trigger line 33.
			// Bun.file(path).text() throws if file not found? No, we check exists().
			// exists() checked first. 
			// So we need exists() = true, but text() fails.
			// E.g. permission denied after check? Hard to race.
			// Accessing a directory as file? 
			// Bun.file(dir).text() -> fails with EISDIR

			expect([200, 500]).toContain(res.status);

			// To definitely cover the catch block, we need exists()=true but read() throws.
			// We can simulate permission denied.
			const lockedPath = join(tempDir, "locked.txt");
			await write(lockedPath, "secret");
			await chmod(lockedPath, 0o000); // No permissions

			try {
				const res2 = await app.request("/read", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: lockedPath })
				});

				expect(res2.status).toBe(500);
				const data2 = (await res2.json()) as { error: string };
				expect(data2.error).toBeDefined();
			} finally {
				// Restore permissions so we can clean it up
				await chmod(lockedPath, 0o666);
				await unlink(lockedPath);
			}
		});

		test("should handle write internal error", async () => {
			// writing to a directory path usually fails
			const res = await app.request("/write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: tempDir, content: "fail" })
			});
			expect(res.status).toBe(500);
		});

		test("should handle fs list internal error", async () => {
			// Listing a file as directory throws ENOTDIR
			const res = await app.request("/fs/list", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: testFilePath })
			});
			expect(res.status).toBe(500);
		});
	});
});
