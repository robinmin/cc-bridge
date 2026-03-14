import { describe, expect, test } from "bun:test";
import { NoneMemoryBackend } from "@/gateway/memory/backend-none";

describe("memory/backend-none", () => {
	test("constructor works", () => {
		const backend = new NoneMemoryBackend();
		expect(backend).toBeDefined();
	});

	test("status returns unavailable", () => {
		const backend = new NoneMemoryBackend();
		const status = backend.status();
		expect(status.slot).toBe("none");
		expect(status.available).toBe(false);
		expect(status.reason).toBe("memory backend disabled");
	});

	test("get returns empty document", async () => {
		const backend = new NoneMemoryBackend();
		const doc = await backend.get("any/path");
		expect(doc.text).toBe("");
		expect(doc.path).toBe("any/path");
	});

	test("appendDaily returns disabled", async () => {
		const backend = new NoneMemoryBackend();
		const result = await backend.appendDaily("test entry");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("memory backend disabled");
	});

	test("upsertLongTerm returns disabled", async () => {
		const backend = new NoneMemoryBackend();
		const result = await backend.upsertLongTerm("test entry");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("memory backend disabled");
	});

	test("search returns empty array", async () => {
		const backend = new NoneMemoryBackend();
		const hits = await backend.search("query");
		expect(hits).toEqual([]);
	});

	test("search with options returns empty array", async () => {
		const backend = new NoneMemoryBackend();
		const hits = await backend.search("query", { limit: 10 });
		expect(hits).toEqual([]);
	});

	test("reindex returns disabled", async () => {
		const backend = new NoneMemoryBackend();
		const result = await backend.reindex();
		expect(result.ok).toBe(true);
		expect(result.reason).toBe("memory backend disabled");
	});
});
