import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BuiltinMemoryBackend } from "@/gateway/memory/backend-builtin";

describe("memory/backend-builtin", () => {
	const testWorkspace = path.join(os.tmpdir(), `cc-bridge-memory-test-${Date.now()}`);

	beforeEach(async () => {
		await fs.mkdir(testWorkspace, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(testWorkspace, { recursive: true, force: true });
	});

	test("constructor sets workspace root", () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		expect(backend).toBeDefined();
	});

	test("status returns available", () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		const status = backend.status();
		expect(status.slot).toBe("builtin");
		expect(status.available).toBe(true);
	});

	test("get returns empty for non-existent file", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		const doc = await backend.get("nonexistent.txt");
		expect(doc.text).toBe("");
	});

	test("get returns content for existing file", async () => {
		const filePath = path.join(testWorkspace, "test.txt");
		await fs.writeFile(filePath, "Hello World");
		const backend = new BuiltinMemoryBackend(testWorkspace);
		const doc = await backend.get("test.txt");
		expect(doc.text).toBe("Hello World");
	});

	test("get resolves relative paths", async () => {
		const subdir = path.join(testWorkspace, "sub");
		await fs.mkdir(subdir);
		const filePath = path.join(subdir, "test.txt");
		await fs.writeFile(filePath, "content");
		const backend = new BuiltinMemoryBackend(testWorkspace);
		const doc = await backend.get("sub/test.txt");
		expect(doc.text).toBe("content");
	});

	test("appendDaily creates daily memory file", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		const result = await backend.appendDaily("Test entry");
		expect(result.ok).toBe(true);
		expect(result.path).toContain(".memory/daily");
	});

	test("appendDaily rejects empty entry", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		const result = await backend.appendDaily("");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("empty entry");
	});

	test("appendDaily appends to existing daily file", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		await backend.appendDaily("First entry");
		const result = await backend.appendDaily("Second entry");
		expect(result.ok).toBe(true);
	});

	test("upsertLongTerm creates memory file", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		const result = await backend.upsertLongTerm("Long term memory");
		expect(result.ok).toBe(true);
		expect(result.path).toContain("MEMORY.md");
	});

	test("upsertLongTerm rejects empty entry", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		const result = await backend.upsertLongTerm("");
		expect(result.ok).toBe(false);
	});

	test("upsertLongTerm avoids duplicates", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		await backend.upsertLongTerm("Unique entry");
		const result = await backend.upsertLongTerm("Unique entry");
		expect(result.ok).toBe(true);
	});

	test("search returns empty for empty query", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		const hits = await backend.search("");
		expect(hits).toEqual([]);
	});

	test("search returns empty for whitespace query", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		const hits = await backend.search("   ");
		expect(hits).toEqual([]);
	});

	test("search finds matches in long-term memory", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		await backend.upsertLongTerm("Important: Remember this");
		const hits = await backend.search("remember");
		expect(hits.length).toBeGreaterThan(0);
	});

	test("search limits results", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		await backend.upsertLongTerm("Item 1 with keyword");
		await backend.upsertLongTerm("Item 2 with keyword");
		await backend.appendDaily("Item 3 with keyword");
		const hits = await backend.search("keyword", { limit: 2 });
		expect(hits.length).toBeLessThanOrEqual(2);
	});

	test("search is case-insensitive", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		await backend.upsertLongTerm("HELLO world");
		const hits = await backend.search("hello");
		expect(hits.length).toBeGreaterThan(0);
	});

	test("reindex returns noop", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		const result = await backend.reindex();
		expect(result.ok).toBe(true);
		expect(result.reason).toBe("noop");
	});

	test("truncates long snippets in search results", async () => {
		const backend = new BuiltinMemoryBackend(testWorkspace);
		const longContent = "A".repeat(300);
		await backend.upsertLongTerm(longContent);
		const hits = await backend.search("A");
		expect(hits[0].snippet.length).toBeLessThan(250);
	});
});
