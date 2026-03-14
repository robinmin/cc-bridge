import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	ExternalMemoryBackend,
	type ExternalMemoryProvider,
	StubExternalProvider,
} from "@/gateway/memory/backend-external";

describe("memory/backend-external", () => {
	const testWorkspace = path.join(os.tmpdir(), `cc-bridge-ext-memory-test-${Date.now()}`);

	beforeEach(async () => {
		await fs.mkdir(testWorkspace, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(testWorkspace, { recursive: true, force: true });
	});

	describe("ExternalMemoryBackend", () => {
		test("constructor with fallback", () => {
			const provider = new StubExternalProvider();
			const backend = new ExternalMemoryBackend(provider, testWorkspace);
			expect(backend).toBeDefined();
		});

		test("status returns available when healthy", () => {
			const provider = new StubExternalProvider();
			const backend = new ExternalMemoryBackend(provider, testWorkspace);
			const status = backend.status();
			expect(status.available).toBe(true);
			expect(status.slot).toBe("external");
		});

		test("status returns unavailable when unhealthy", async () => {
			const failingProvider = {
				name: "failing",
				status: async () => ({ slot: "external", available: true }),
				get: async () => {
					throw new Error("fail");
				},
				appendDaily: async () => {
					throw new Error("fail");
				},
				upsertLongTerm: async () => {
					throw new Error("fail");
				},
				search: async () => {
					throw new Error("fail");
				},
				reindex: async () => {
					throw new Error("fail");
				},
			} as ExternalMemoryProvider;

			const backend = new ExternalMemoryBackend(failingProvider, testWorkspace);
			await backend.get("test"); // This should mark it unhealthy

			const status = backend.status();
			expect(status.available).toBe(false);
		});

		test("get delegates to provider", async () => {
			const provider = new StubExternalProvider();
			const backend = new ExternalMemoryBackend(provider, testWorkspace);
			const doc = await backend.get("test/path");
			expect(doc).toBeDefined();
		});

		test("get falls back when provider fails", async () => {
			const failingProvider = {
				name: "failing",
				status: async () => ({ slot: "external", available: true }),
				get: async () => {
					throw new Error("fail");
				},
				appendDaily: async () => {
					throw new Error("fail");
				},
				upsertLongTerm: async () => {
					throw new Error("fail");
				},
				search: async () => {
					throw new Error("fail");
				},
				reindex: async () => {
					throw new Error("fail");
				},
			} as ExternalMemoryProvider;

			const backend = new ExternalMemoryBackend(failingProvider, testWorkspace);
			const doc = await backend.get("test/path");
			// Should fall back to builtin
			expect(doc).toBeDefined();
		});

		test("appendDaily delegates to provider", async () => {
			const provider = new StubExternalProvider();
			const backend = new ExternalMemoryBackend(provider, testWorkspace);
			const result = await backend.appendDaily("test entry");
			expect(result.ok).toBe(true);
		});

		test("upsertLongTerm delegates to provider", async () => {
			const provider = new StubExternalProvider();
			const backend = new ExternalMemoryBackend(provider, testWorkspace);
			const result = await backend.upsertLongTerm("test entry");
			expect(result.ok).toBe(true);
		});

		test("search delegates to provider", async () => {
			const provider = new StubExternalProvider();
			const backend = new ExternalMemoryBackend(provider, testWorkspace);
			const hits = await backend.search("test");
			expect(hits).toEqual([]);
		});

		test("reindex delegates to provider", async () => {
			const provider = new StubExternalProvider();
			const backend = new ExternalMemoryBackend(provider, testWorkspace);
			const result = await backend.reindex();
			expect(result.ok).toBe(true);
		});

		test("uses builtin fallback when no fallback workspace provided", () => {
			const failingProvider = {
				name: "failing",
				status: async () => ({ slot: "external", available: true }),
				get: async () => {
					throw new Error("fail");
				},
				appendDaily: async () => {
					throw new Error("fail");
				},
				upsertLongTerm: async () => {
					throw new Error("fail");
				},
				search: async () => {
					throw new Error("fail");
				},
				reindex: async () => {
					throw new Error("fail");
				},
			} as ExternalMemoryProvider;

			const backend = new ExternalMemoryBackend(failingProvider); // No fallback
			expect(backend).toBeDefined();
		});
	});

	describe("StubExternalProvider", () => {
		test("has stub name", () => {
			const provider = new StubExternalProvider();
			expect(provider.name).toBe("stub");
		});

		test("status returns available", async () => {
			const provider = new StubExternalProvider();
			const status = await provider.status();
			expect(status.available).toBe(true);
		});

		test("get returns empty document", async () => {
			const provider = new StubExternalProvider();
			const doc = await provider.get("any/path");
			expect(doc.text).toBe("");
		});

		test("appendDaily returns ok", async () => {
			const provider = new StubExternalProvider();
			const result = await provider.appendDaily("entry");
			expect(result.ok).toBe(true);
		});

		test("upsertLongTerm returns ok", async () => {
			const provider = new StubExternalProvider();
			const result = await provider.upsertLongTerm("entry");
			expect(result.ok).toBe(true);
		});

		test("search returns empty", async () => {
			const provider = new StubExternalProvider();
			const hits = await provider.search("query");
			expect(hits).toEqual([]);
		});

		test("reindex returns ok", async () => {
			const provider = new StubExternalProvider();
			const result = await provider.reindex();
			expect(result.ok).toBe(true);
		});
	});
});
