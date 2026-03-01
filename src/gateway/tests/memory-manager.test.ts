import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BuiltinMemoryBackend } from "@/gateway/memory/backend-builtin";
import {
	ExternalMemoryBackend,
	StubExternalProvider,
	type ExternalMemoryProvider,
} from "@/gateway/memory/backend-external";
import { NoneMemoryBackend } from "@/gateway/memory/backend-none";
import {
	buildMemoryBootstrapContext,
	createMemoryBackend,
	estimateTokenCountFromHistory,
	persistConversationMemory,
	resolveMemoryConfig,
	shouldCaptureLongTermMemory,
	shouldTriggerMemoryFlush,
} from "@/gateway/memory/manager";
import { getMemoryLoadDecision, inferGroupContext } from "@/gateway/memory/policy";
import { memoryGet, memorySearch } from "@/gateway/memory/tools";

describe("memory manager scaffolding", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-bridge-memory-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("resolveMemoryConfig falls back to defaults and validates slot", () => {
		const defaults = resolveMemoryConfig(undefined);
		expect(defaults.slot).toBe("none");
		expect(defaults.citations).toBe("auto");
		expect(defaults.loadPolicy.groupLoadLongTerm).toBe(false);

		const invalidSlot = resolveMemoryConfig({ slot: "invalid" });
		expect(invalidSlot.slot).toBe("none");

		const validSlot = resolveMemoryConfig({ slot: "builtin", citations: "on" });
		expect(validSlot.slot).toBe("builtin");
		expect(validSlot.citations).toBe("on");

		const partialNested = resolveMemoryConfig({
			loadPolicy: {},
			flush: { enabled: false },
			builtin: { index: {} },
			external: { provider: "remote-x" },
		});
		expect(partialNested.loadPolicy.groupLoadLongTerm).toBe(false);
		expect(partialNested.flush.enabled).toBe(false);
		expect(partialNested.flush.softThresholdTokens).toBe(4000);
		expect(partialNested.builtin.index.enabled).toBe(true);
		expect(partialNested.external?.provider).toBe("remote-x");

		const malformed = resolveMemoryConfig({
			citations: "invalid",
			flush: { softThresholdTokens: Number.NaN },
			external: { provider: "  " },
		});
		expect(malformed.citations).toBe("auto");
		expect(malformed.flush.softThresholdTokens).toBe(4000);
		expect(malformed.external).toBeUndefined();
	});

	test("resolveMemoryConfig handles non-object and null inputs", () => {
		expect(resolveMemoryConfig(null).slot).toBe("none");
		expect(resolveMemoryConfig(42).slot).toBe("none");
		expect(resolveMemoryConfig("string").slot).toBe("none");
		expect(resolveMemoryConfig(false).slot).toBe("none");
	});

	test("resolveMemoryConfig citation mode off", () => {
		const cfg = resolveMemoryConfig({ citations: "off" });
		expect(cfg.citations).toBe("off");
	});

	test("resolveMemoryConfig groupLoadLongTerm true override", () => {
		const cfg = resolveMemoryConfig({ loadPolicy: { groupLoadLongTerm: true } });
		expect(cfg.loadPolicy.groupLoadLongTerm).toBe(true);
	});

	test("resolveMemoryConfig builtin index disabled", () => {
		const cfg = resolveMemoryConfig({ builtin: { index: { enabled: false } } });
		expect(cfg.builtin.index.enabled).toBe(false);
	});

	test("createMemoryBackend returns slot-specific implementation", () => {
		const none = createMemoryBackend(resolveMemoryConfig({ slot: "none" }), tmpDir);
		expect(none).toBeInstanceOf(NoneMemoryBackend);

		const builtin = createMemoryBackend(resolveMemoryConfig({ slot: "builtin" }), tmpDir);
		expect(builtin).toBeInstanceOf(BuiltinMemoryBackend);

		const external = createMemoryBackend(resolveMemoryConfig({ slot: "external" }), tmpDir);
		expect(external).toBeInstanceOf(ExternalMemoryBackend);
	});

	test("builtin backend reads existing files and degrades on missing files", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		const memoryDir = path.join(tmpDir, ".memory");
		await fs.mkdir(memoryDir, { recursive: true });
		const memoryPath = path.join(memoryDir, "MEMORY.md");
		await fs.writeFile(memoryPath, "hello memory", "utf-8");

		expect(backend.status()).toEqual({ slot: "builtin", available: true });

		const existing = await backend.get(".memory/MEMORY.md");
		expect(existing.text).toBe("hello memory");

		const existingAbs = await backend.get(memoryPath);
		expect(existingAbs.text).toBe("hello memory");

		const missing = await backend.get("missing.md");
		expect(missing.text).toBe("");
		expect(await backend.search("x")).toEqual([]);
		expect(await backend.reindex()).toEqual({ ok: true, reason: "noop" });
	});

	test("builtin backend appends daily memory and creates directories", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);

		const first = await backend.appendDaily("daily fact");
		expect(first.ok).toBe(true);
		expect(first.path).toBeDefined();

		const firstDoc = await backend.get(first.path as string);
		expect(firstDoc.text).toContain("daily fact");

		const second = await backend.appendDaily("another fact");
		expect(second.ok).toBe(true);

		const secondDoc = await backend.get(first.path as string);
		expect(secondDoc.text).toContain("daily fact");
		expect(secondDoc.text).toContain("another fact");
	});

	test("builtin backend appendDaily rejects empty entry", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		const empty = await backend.appendDaily("   ");
		expect(empty.ok).toBe(false);
		expect(empty.reason).toBe("empty entry");
	});

	test("builtin backend appendDaily to empty file", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		await fs.mkdir(path.join(tmpDir, ".memory", "daily"), { recursive: true });
		const now = new Date();
		const yyyy = String(now.getFullYear());
		const mm = String(now.getMonth() + 1).padStart(2, "0");
		const dd = String(now.getDate()).padStart(2, "0");
		const dailyPath = path.join(tmpDir, ".memory", "daily", `${yyyy}-${mm}-${dd}.md`);
		await fs.writeFile(dailyPath, "", "utf-8");

		const result = await backend.appendDaily("first entry");
		expect(result.ok).toBe(true);

		const doc = await backend.get(dailyPath);
		expect(doc.text.trim()).toBe("first entry");
	});

	test("builtin backend upserts long-term memory with dedupe and empty-entry guard", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		const first = await backend.upsertLongTerm("stable preference");
		expect(first.ok).toBe(true);
		expect(first.path).toBe(path.join(tmpDir, ".memory", "MEMORY.md"));

		const dup = await backend.upsertLongTerm("stable preference");
		expect(dup.ok).toBe(true);

		const doc = await backend.get(".memory/MEMORY.md");
		const occurrences = doc.text.split("stable preference").length - 1;
		expect(occurrences).toBe(1);

		const empty = await backend.upsertLongTerm("   ");
		expect(empty.ok).toBe(false);
		expect(empty.reason).toBe("empty entry");
	});

	test("builtin backend search scans MEMORY.md and daily files with limits", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		await fs.mkdir(path.join(tmpDir, ".memory", "daily"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, ".memory", "MEMORY.md"), "Project uses Rust\\nNo match", "utf-8");
		await fs.writeFile(path.join(tmpDir, ".memory", "daily", "2026-03-01.md"), "Rust toolchain update\\nAnother line", "utf-8");
		await fs.writeFile(path.join(tmpDir, ".memory", "daily", "note.txt"), "rust but ignored extension", "utf-8");

		const hits = await backend.search("rust", { limit: 1 });
		expect(hits).toHaveLength(1);
		expect(hits[0].snippet.toLowerCase()).toContain("rust");

		expect(await backend.search("   ")).toEqual([]);
	});

	test("builtin backend search returns multiple results across files", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		await fs.mkdir(path.join(tmpDir, ".memory", "daily"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, ".memory", "MEMORY.md"), "TypeScript is great\nTypeScript 5.0 released", "utf-8");
		await fs.writeFile(path.join(tmpDir, ".memory", "daily", "2026-01-01.md"), "TypeScript migration done", "utf-8");

		const hits = await backend.search("typescript", { limit: 10 });
		expect(hits.length).toBeGreaterThanOrEqual(2);
	});

	test("builtin backend search truncates long snippets", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		const longLine = `keyword ${"x".repeat(300)}`;
		await fs.mkdir(path.join(tmpDir, ".memory"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, ".memory", "MEMORY.md"), longLine, "utf-8");

		const hits = await backend.search("keyword");
		expect(hits).toHaveLength(1);
		expect(hits[0].snippet.length).toBeLessThanOrEqual(244);
		expect(hits[0].snippet).toContain("...");
	});

	test("builtin backend search with no memory directory", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		await fs.mkdir(path.join(tmpDir, ".memory"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, ".memory", "MEMORY.md"), "some data", "utf-8");
		const hits = await backend.search("data");
		expect(hits).toHaveLength(1);
	});

	test("none backend always returns disabled/noop responses", async () => {
		const backend = new NoneMemoryBackend();
		expect(backend.status().available).toBe(false);
		expect(await backend.get("MEMORY.md")).toEqual({ path: "MEMORY.md", text: "" });
		expect((await backend.appendDaily("x")).ok).toBe(false);
		expect((await backend.upsertLongTerm("x")).ok).toBe(false);
		expect(await backend.search("x")).toEqual([]);
		expect((await backend.reindex()).ok).toBe(true);
	});

	test("memory tools delegate to backend", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		await fs.mkdir(path.join(tmpDir, ".memory"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, ".memory", "SOUL.md"), "soul", "utf-8");

		const got = await memoryGet(backend, ".memory/SOUL.md");
		expect(got.text).toBe("soul");

		const hits = await memorySearch(backend, "anything", 3);
		expect(hits).toEqual([]);
	});

	test("memory tools delegate search to backend with results", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		await fs.mkdir(path.join(tmpDir, ".memory"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, ".memory", "MEMORY.md"), "findable content", "utf-8");
		const hits = await memorySearch(backend, "findable");
		expect(hits).toHaveLength(1);
		expect(hits[0].snippet).toContain("findable content");
	});

	test("policy excludes long-term memory in group mode by default", () => {
		const config = resolveMemoryConfig({});
		const group = getMemoryLoadDecision(true, config);
		expect(group.includeLongTermMemory).toBe(false);
		expect(group.includeSoul).toBe(true);

		const direct = getMemoryLoadDecision(false, config);
		expect(direct.includeLongTermMemory).toBe(true);
		expect(direct.includeDailyMemory).toBe(true);
	});

	test("policy includes long-term memory in group mode when configured", () => {
		const config = resolveMemoryConfig({ loadPolicy: { groupLoadLongTerm: true } });
		const group = getMemoryLoadDecision(true, config);
		expect(group.includeLongTermMemory).toBe(true);
		expect(group.includeDailyMemory).toBe(false);
	});

	test("inferGroupContext detects telegram and conservatively defaults feishu", () => {
		expect(inferGroupContext("telegram", -100123)).toBe(true);
		expect(inferGroupContext("telegram", "-100123")).toBe(true);
		expect(inferGroupContext("telegram", 12345)).toBe(false);
		expect(inferGroupContext("feishu", "oc_xxx")).toBe(true);
		expect(inferGroupContext("unknown", "x")).toBe(false);
	});

	test("inferGroupContext handles positive telegram string ids", () => {
		expect(inferGroupContext("telegram", "12345")).toBe(false);
	});

	test("buildMemoryBootstrapContext respects load policy", async () => {
		const workspace = path.join(tmpDir, "ws-a");
		await fs.mkdir(path.join(workspace, ".memory", "daily"), { recursive: true });
		await fs.writeFile(path.join(workspace, ".memory", "SOUL.md"), "Soul text", "utf-8");
		await fs.writeFile(path.join(workspace, ".memory", "USER.md"), "User text", "utf-8");
		await fs.writeFile(path.join(workspace, ".memory", "MEMORY.md"), "Long-term fact", "utf-8");
		const now = new Date();
		const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		await fs.writeFile(path.join(workspace, ".memory", "daily", `${day}.md`), "Daily fact", "utf-8");

		const privateCtx = await buildMemoryBootstrapContext({
			config: resolveMemoryConfig({ slot: "builtin" }),
			workspaceRoot: workspace,
			isGroupContext: false,
		});
		expect(privateCtx).toContain("[SOUL]");
		expect(privateCtx).toContain("[USER]");
		expect(privateCtx).toContain("[MEMORY]");
		expect(privateCtx).toContain("[MEMORY_TODAY]");

		const groupCtx = await buildMemoryBootstrapContext({
			config: resolveMemoryConfig({ slot: "builtin" }),
			workspaceRoot: workspace,
			isGroupContext: true,
		});
		expect(groupCtx).toContain("[SOUL]");
		expect(groupCtx).toContain("[USER]");
		expect(groupCtx).not.toContain("[MEMORY]");
		expect(groupCtx).not.toContain("[MEMORY_TODAY]");
	});

	test("buildMemoryBootstrapContext returns empty when backend slot is disabled", async () => {
		const workspace = path.join(tmpDir, "ws-b");
		await fs.mkdir(path.join(workspace, ".memory"), { recursive: true });
		await fs.writeFile(path.join(workspace, ".memory", "SOUL.md"), "Soul text", "utf-8");

		const ctx = await buildMemoryBootstrapContext({
			config: resolveMemoryConfig({ slot: "none" }),
			workspaceRoot: workspace,
			isGroupContext: false,
		});
		expect(ctx).toBe("");
	});

	test("buildMemoryBootstrapContext returns empty when no files exist", async () => {
		const workspace = path.join(tmpDir, "ws-empty");
		await fs.mkdir(workspace, { recursive: true });

		const ctx = await buildMemoryBootstrapContext({
			config: resolveMemoryConfig({ slot: "builtin" }),
			workspaceRoot: workspace,
			isGroupContext: false,
		});
		expect(ctx).toBe("");
	});

	test("buildMemoryBootstrapContext truncates long sections", async () => {
		const workspace = path.join(tmpDir, "ws-trunc");
		await fs.mkdir(path.join(workspace, ".memory"), { recursive: true });
		const longContent = "A".repeat(2000);
		await fs.writeFile(path.join(workspace, ".memory", "SOUL.md"), longContent, "utf-8");

		const ctx = await buildMemoryBootstrapContext({
			config: resolveMemoryConfig({ slot: "builtin" }),
			workspaceRoot: workspace,
			isGroupContext: false,
			maxSectionChars: 100,
		});
		expect(ctx).toContain("[SOUL]");
		expect(ctx).toContain("...[truncated]");
		expect(ctx.length).toBeLessThan(2000);
	});

	test("write trigger helpers detect durable memory signals", () => {
		expect(shouldCaptureLongTermMemory("remember this preference")).toBe(true);
		expect(shouldCaptureLongTermMemory("I prefer dark text background")).toBe(true);
		expect(shouldCaptureLongTermMemory("decision: use sqlite")).toBe(true);
		expect(shouldCaptureLongTermMemory("what is the weather today")).toBe(false);
		expect(shouldCaptureLongTermMemory("please remember my name")).toBe(true);
		expect(shouldCaptureLongTermMemory("my preference is dark mode")).toBe(true);
		expect(shouldCaptureLongTermMemory("always use typescript")).toBe(true);
		expect(shouldCaptureLongTermMemory("never use var")).toBe(true);
		expect(shouldCaptureLongTermMemory("remember everything")).toBe(true);
	});

	test("flush helper uses history token estimate threshold", () => {
		const history = [{ sender: "user", text: "x".repeat(200), timestamp: "2026-03-01T00:00:00.000Z" }];
		expect(estimateTokenCountFromHistory(history)).toBeGreaterThan(0);
		const cfg = resolveMemoryConfig({ slot: "builtin", flush: { enabled: true, softThresholdTokens: 10 } });
		expect(shouldTriggerMemoryFlush(history, cfg)).toBe(true);
	});

	test("flush disabled returns false regardless of history size", () => {
		const history = [{ sender: "user", text: "x".repeat(10000), timestamp: "t" }];
		const cfg = resolveMemoryConfig({ flush: { enabled: false, softThresholdTokens: 1 } });
		expect(shouldTriggerMemoryFlush(history, cfg)).toBe(false);
	});

	test("flush below threshold returns false", () => {
		const history = [{ sender: "user", text: "short", timestamp: "t" }];
		const cfg = resolveMemoryConfig({ flush: { enabled: true, softThresholdTokens: 999999 } });
		expect(shouldTriggerMemoryFlush(history, cfg)).toBe(false);
	});

	test("estimateTokenCountFromHistory handles empty history", () => {
		expect(estimateTokenCountFromHistory([])).toBe(0);
	});

	test("persistConversationMemory writes daily and optional long-term/flush hints", async () => {
		const workspace = path.join(tmpDir, "ws-c");
		await fs.mkdir(workspace, { recursive: true });
		const cfg = resolveMemoryConfig({ slot: "builtin", flush: { enabled: true, softThresholdTokens: 1 } });

		const stats = await persistConversationMemory({
			config: cfg,
			workspaceRoot: workspace,
			userText: "remember this: always use workspace aliases",
			assistantText: "ack",
			historyForFlush: [{ sender: "user", text: "some history", timestamp: "2026-03-01T00:00:00.000Z" }],
		});
		expect(stats.dailyWritten).toBe(true);
		expect(stats.longTermWritten).toBe(true);
		expect(stats.flushHintWritten).toBe(true);

		const memoryDoc = await fs.readFile(path.join(workspace, ".memory", "MEMORY.md"), "utf-8");
		expect(memoryDoc).toContain("always use workspace aliases");

		const memoryDir = path.join(workspace, ".memory", "daily");
		const files = await fs.readdir(memoryDir);
		expect(files.some((f) => f.endsWith(".md"))).toBe(true);
	});

	test("persistConversationMemory with disabled backend returns all false", async () => {
		const workspace = path.join(tmpDir, "ws-disabled");
		await fs.mkdir(workspace, { recursive: true });
		const cfg = resolveMemoryConfig({ slot: "none" });

		const stats = await persistConversationMemory({
			config: cfg,
			workspaceRoot: workspace,
			userText: "remember this",
		});
		expect(stats.dailyWritten).toBe(false);
		expect(stats.longTermWritten).toBe(false);
		expect(stats.flushHintWritten).toBe(false);
	});

	test("persistConversationMemory without assistant text", async () => {
		const workspace = path.join(tmpDir, "ws-noassist");
		await fs.mkdir(workspace, { recursive: true });
		const cfg = resolveMemoryConfig({ slot: "builtin" });

		const stats = await persistConversationMemory({
			config: cfg,
			workspaceRoot: workspace,
			userText: "hello world",
		});
		expect(stats.dailyWritten).toBe(true);
		expect(stats.longTermWritten).toBe(false);
		expect(stats.flushHintWritten).toBe(false);
	});

	test("persistConversationMemory without flush history", async () => {
		const workspace = path.join(tmpDir, "ws-noflush");
		await fs.mkdir(workspace, { recursive: true });
		const cfg = resolveMemoryConfig({ slot: "builtin", flush: { enabled: true, softThresholdTokens: 1 } });

		const stats = await persistConversationMemory({
			config: cfg,
			workspaceRoot: workspace,
			userText: "just a message",
		});
		expect(stats.dailyWritten).toBe(true);
		expect(stats.flushHintWritten).toBe(false);
	});
});

describe("Phase 5: external memory backend", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-bridge-ext-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("stub provider returns valid stub responses", async () => {
		const stub = new StubExternalProvider();
		expect(stub.name).toBe("stub");
		expect((await stub.status()).available).toBe(true);
		expect((await stub.get("any")).text).toBe("");
		expect((await stub.appendDaily("x")).ok).toBe(true);
		expect((await stub.upsertLongTerm("x")).ok).toBe(true);
		expect(await stub.search("x")).toEqual([]);
		expect((await stub.reindex()).ok).toBe(true);
	});

	test("external backend delegates to provider when healthy", async () => {
		const stub = new StubExternalProvider();
		const backend = new ExternalMemoryBackend(stub);

		expect(backend.status().slot).toBe("external");
		expect(backend.status().available).toBe(true);
		expect((await backend.get("test.md")).text).toBe("");
		expect((await backend.appendDaily("entry")).ok).toBe(true);
		expect((await backend.upsertLongTerm("entry")).ok).toBe(true);
		expect(await backend.search("query")).toEqual([]);
		expect((await backend.reindex()).ok).toBe(true);
	});

	test("external backend falls back on provider get error", async () => {
		const failProvider: ExternalMemoryProvider = {
			name: "fail",
			status: async () => ({ slot: "external", available: true }),
			get: async () => {
				throw new Error("network error");
			},
			appendDaily: async () => {
				throw new Error("network error");
			},
			upsertLongTerm: async () => {
				throw new Error("network error");
			},
			search: async () => {
				throw new Error("network error");
			},
			reindex: async () => {
				throw new Error("network error");
			},
		};

		await fs.mkdir(path.join(tmpDir, ".memory"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, ".memory", "MEMORY.md"), "fallback data", "utf-8");
		const backend = new ExternalMemoryBackend(failProvider, tmpDir);

		expect(backend.status().available).toBe(true);

		const doc = await backend.get(".memory/MEMORY.md");
		expect(doc.text).toBe("fallback data");

		expect(backend.status().available).toBe(false);
		expect(backend.status().reason).toContain("fallback");
	});

	test("external backend falls back on appendDaily error", async () => {
		const failOnce: ExternalMemoryProvider = {
			name: "fail-append",
			status: async () => ({ slot: "external", available: true }),
			get: async (p) => ({ path: p, text: "" }),
			appendDaily: async () => {
				throw new Error("write error");
			},
			upsertLongTerm: async (e) => ({ ok: true, reason: e }),
			search: async () => [],
			reindex: async () => ({ ok: true }),
		};

		const backend = new ExternalMemoryBackend(failOnce, tmpDir);
		const result = await backend.appendDaily("test entry");
		expect(result.ok).toBe(true);

		expect(backend.status().available).toBe(false);
	});

	test("external backend falls back on upsertLongTerm error", async () => {
		const failProvider: ExternalMemoryProvider = {
			name: "fail-upsert",
			status: async () => ({ slot: "external", available: true }),
			get: async (p) => ({ path: p, text: "" }),
			appendDaily: async () => ({ ok: true }),
			upsertLongTerm: async () => {
				throw new Error("upsert error");
			},
			search: async () => [],
			reindex: async () => ({ ok: true }),
		};

		const backend = new ExternalMemoryBackend(failProvider, tmpDir);
		const result = await backend.upsertLongTerm("test entry");
		// Falls back to builtin backend which succeeds
		expect(result.ok).toBe(true);
		expect(backend.status().available).toBe(false);
	});

	test("external backend falls back on search error", async () => {
		const failProvider: ExternalMemoryProvider = {
			name: "fail-search",
			status: async () => ({ slot: "external", available: true }),
			get: async (p) => ({ path: p, text: "" }),
			appendDaily: async () => ({ ok: true }),
			upsertLongTerm: async () => ({ ok: true }),
			search: async () => {
				throw new Error("search error");
			},
			reindex: async () => ({ ok: true }),
		};

		const backend = new ExternalMemoryBackend(failProvider, tmpDir);
		const results = await backend.search("anything");
		expect(results).toEqual([]);
		expect(backend.status().available).toBe(false);
	});

	test("external backend falls back on reindex error", async () => {
		const failProvider: ExternalMemoryProvider = {
			name: "fail-reindex",
			status: async () => ({ slot: "external", available: true }),
			get: async (p) => ({ path: p, text: "" }),
			appendDaily: async () => ({ ok: true }),
			upsertLongTerm: async () => ({ ok: true }),
			search: async () => [],
			reindex: async () => {
				throw new Error("reindex error");
			},
		};

		const backend = new ExternalMemoryBackend(failProvider, tmpDir);
		const result = await backend.reindex();
		expect(result.ok).toBe(true);
		expect(backend.status().available).toBe(false);
	});

	test("external backend without fallback workspace uses NoneMemoryBackend", async () => {
		const failProvider: ExternalMemoryProvider = {
			name: "fail-no-fallback",
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
		};

		const backend = new ExternalMemoryBackend(failProvider);

		const doc = await backend.get("MEMORY.md");
		expect(doc.text).toBe("");
		expect(backend.status().available).toBe(false);
	});

	test("external backend stays on fallback after failure (sticky unhealthy)", async () => {
		let callCount = 0;
		const failOnce: ExternalMemoryProvider = {
			name: "fail-once",
			status: async () => ({ slot: "external", available: true }),
			get: async () => {
				callCount++;
				throw new Error("network error");
			},
			appendDaily: async () => ({ ok: true }),
			upsertLongTerm: async () => ({ ok: true }),
			search: async () => [],
			reindex: async () => ({ ok: true }),
		};

		const backend = new ExternalMemoryBackend(failOnce, tmpDir);
		await backend.get("file.md");
		expect(callCount).toBe(1);

		await backend.get("file.md");
		expect(callCount).toBe(1);
	});

	test("createMemoryBackend with external slot returns ExternalMemoryBackend", () => {
		const config = resolveMemoryConfig({ slot: "external" });
		const backend = createMemoryBackend(config, tmpDir);
		expect(backend).toBeInstanceOf(ExternalMemoryBackend);
		expect(backend.status().slot).toBe("external");
	});

	test("external backend does not break message processing on hard failure", async () => {
		const failAll: ExternalMemoryProvider = {
			name: "catastrophic-fail",
			status: async () => ({ slot: "external", available: true }),
			get: async () => {
				throw new Error("catastrophic failure");
			},
			appendDaily: async () => {
				throw new Error("catastrophic failure");
			},
			upsertLongTerm: async () => {
				throw new Error("catastrophic failure");
			},
			search: async () => {
				throw new Error("catastrophic failure");
			},
			reindex: async () => {
				throw new Error("catastrophic failure");
			},
		};

		const backend = new ExternalMemoryBackend(failAll, tmpDir);

		const doc = await backend.get("SOUL.md");
		expect(doc).toBeDefined();
		expect(doc.text).toBe("");

		const appendResult = await backend.appendDaily("entry");
		expect(appendResult).toBeDefined();

		const searchResult = await backend.search("query");
		expect(Array.isArray(searchResult)).toBe(true);

		expect(backend.status().available).toBe(false);
	});

	test("buildMemoryBootstrapContext works with external slot", async () => {
		const workspace = path.join(tmpDir, "ws-ext");
		await fs.mkdir(path.join(workspace, ".memory", "daily"), { recursive: true });
		await fs.writeFile(path.join(workspace, ".memory", "SOUL.md"), "External soul", "utf-8");

		const ctx = await buildMemoryBootstrapContext({
			config: resolveMemoryConfig({ slot: "external" }),
			workspaceRoot: workspace,
			isGroupContext: false,
		});
		expect(ctx).toBe("");
	});

	test("persistConversationMemory works with external slot", async () => {
		const workspace = path.join(tmpDir, "ws-ext-persist");
		await fs.mkdir(workspace, { recursive: true });
		const cfg = resolveMemoryConfig({ slot: "external" });

		const stats = await persistConversationMemory({
			config: cfg,
			workspaceRoot: workspace,
			userText: "remember this: external test",
		});
		// Stub provider returns ok:true for appendDaily and upsertLongTerm
		expect(stats.dailyWritten).toBe(true);
		expect(stats.longTermWritten).toBe(true);
	});
});

describe("Phase 6: stabilization and hardening", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-bridge-p6-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("concurrent daily appends produce correct content", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		const entries = Array.from({ length: 5 }, (_, i) => `concurrent entry ${i}`);

		for (const entry of entries) {
			const result = await backend.appendDaily(entry);
			expect(result.ok).toBe(true);
		}

		const now = new Date();
		const yyyy = String(now.getFullYear());
		const mm = String(now.getMonth() + 1).padStart(2, "0");
		const dd = String(now.getDate()).padStart(2, "0");
		const dailyPath = path.join(tmpDir, ".memory", "daily", `${yyyy}-${mm}-${dd}.md`);
		const content = await fs.readFile(dailyPath, "utf-8");

		for (const entry of entries) {
			expect(content).toContain(entry);
		}
	});

	test("concurrent upsertLongTerm with same entry still deduplicates", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);

		for (let i = 0; i < 5; i++) {
			await backend.upsertLongTerm("same entry");
		}

		const doc = await backend.get(".memory/MEMORY.md");
		const occurrences = doc.text.split("same entry").length - 1;
		expect(occurrences).toBe(1);
	});

	test("search performance with many daily files", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		await fs.mkdir(path.join(tmpDir, ".memory", "daily"), { recursive: true });

		for (let i = 0; i < 30; i++) {
			const day = String(i + 1).padStart(2, "0");
			await fs.writeFile(path.join(tmpDir, ".memory", "daily", `2026-01-${day}.md`), `Log entry ${i}: typescript`, "utf-8");
		}
		await fs.writeFile(path.join(tmpDir, ".memory", "MEMORY.md"), "typescript project", "utf-8");

		const start = performance.now();
		const hits = await backend.search("typescript", { limit: 5 });
		const elapsed = performance.now() - start;

		expect(hits).toHaveLength(5);
		expect(elapsed).toBeLessThan(2000);
	});

	test("get performance with file reads", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		await fs.mkdir(path.join(tmpDir, ".memory"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, ".memory", "MEMORY.md"), "benchmark content", "utf-8");

		const start = performance.now();
		for (let i = 0; i < 50; i++) {
			await backend.get(".memory/MEMORY.md");
		}
		const elapsed = performance.now() - start;

		expect(elapsed).toBeLessThan(2000);
	});

	test("write performance for daily appends", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);

		const start = performance.now();
		for (let i = 0; i < 20; i++) {
			await backend.appendDaily(`performance test entry ${i}`);
		}
		const elapsed = performance.now() - start;

		expect(elapsed).toBeLessThan(2000);
	});

	test("secret-like content is not blocked at memory level (no redaction in builtin)", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		const result = await backend.upsertLongTerm("api_key=sk-abc123");
		expect(result.ok).toBe(true);

		const doc = await backend.get(".memory/MEMORY.md");
		expect(doc.text).toContain("sk-abc123");
	});

	test("special characters in memory entries are preserved", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		const specialEntry = 'Special: <script>alert("xss")</script> & "quotes" \'single\'';
		await backend.upsertLongTerm(specialEntry);
		const doc = await backend.get(".memory/MEMORY.md");
		expect(doc.text).toContain(specialEntry);
	});

	test("unicode content in memory entries is preserved", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		const unicodeEntry = "Unicode test: emoji text here, Chinese characters, Japanese characters";
		await backend.upsertLongTerm(unicodeEntry);
		const doc = await backend.get(".memory/MEMORY.md");
		expect(doc.text).toContain(unicodeEntry);
	});

	test("path traversal in get is handled by path resolution", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		const doc = await backend.get("../../etc/passwd");
		expect(doc.text).toBe("");
	});

	test("very long entries are stored correctly", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);
		const longEntry = "A".repeat(10000);
		const result = await backend.upsertLongTerm(longEntry);
		expect(result.ok).toBe(true);

		const doc = await backend.get(".memory/MEMORY.md");
		expect(doc.text.trim()).toBe(longEntry);
	});

	test("multiple different long-term entries accumulate correctly", async () => {
		const backend = new BuiltinMemoryBackend(tmpDir);

		await backend.upsertLongTerm("first entry");
		await backend.upsertLongTerm("second entry");
		await backend.upsertLongTerm("third entry");

		const doc = await backend.get(".memory/MEMORY.md");
		expect(doc.text).toContain("first entry");
		expect(doc.text).toContain("second entry");
		expect(doc.text).toContain("third entry");
	});

	test("buildMemoryBootstrapContext with all files populated includes yesterday", async () => {
		const workspace = path.join(tmpDir, "ws-full");
		await fs.mkdir(path.join(workspace, ".memory", "daily"), { recursive: true });
		await fs.writeFile(path.join(workspace, ".memory", "SOUL.md"), "Soul content", "utf-8");
		await fs.writeFile(path.join(workspace, ".memory", "USER.md"), "User content", "utf-8");
		await fs.writeFile(path.join(workspace, ".memory", "MEMORY.md"), "Memory content", "utf-8");

		const now = new Date();
		const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		await fs.writeFile(path.join(workspace, ".memory", "daily", `${todayStr}.md`), "Today's notes", "utf-8");

		const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
		const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
		await fs.writeFile(path.join(workspace, ".memory", "daily", `${yesterdayStr}.md`), "Yesterday's notes", "utf-8");

		const ctx = await buildMemoryBootstrapContext({
			config: resolveMemoryConfig({ slot: "builtin" }),
			workspaceRoot: workspace,
			isGroupContext: false,
		});
		expect(ctx).toContain("[SOUL]");
		expect(ctx).toContain("[USER]");
		expect(ctx).toContain("[MEMORY]");
		expect(ctx).toContain("[MEMORY_TODAY]");
		expect(ctx).toContain("[MEMORY_YESTERDAY]");
		expect(ctx).toContain("Yesterday's notes");
	});

	test("external backend with fallback workspace uses builtin on failure", async () => {
		await fs.mkdir(path.join(tmpDir, ".memory", "daily"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, ".memory", "MEMORY.md"), "fallback long-term", "utf-8");

		const failProvider: ExternalMemoryProvider = {
			name: "fail-all",
			status: async () => ({ slot: "external", available: true }),
			get: async () => {
				throw new Error("provider down");
			},
			appendDaily: async () => {
				throw new Error("provider down");
			},
			upsertLongTerm: async () => {
				throw new Error("provider down");
			},
			search: async () => {
				throw new Error("provider down");
			},
			reindex: async () => {
				throw new Error("provider down");
			},
		};

		const backend = new ExternalMemoryBackend(failProvider, tmpDir);

		const doc = await backend.get(".memory/MEMORY.md");
		expect(doc.text).toBe("fallback long-term");

		const appendResult = await backend.appendDaily("fallback append");
		expect(appendResult.ok).toBe(true);

		const searchResults = await backend.search("fallback");
		expect(searchResults.length).toBeGreaterThanOrEqual(1);
	});
});
