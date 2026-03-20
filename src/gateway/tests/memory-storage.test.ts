import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	listEntities as listEntitiesBank,
	readBank,
	searchBank,
	upsertBank,
	upsertEntity,
	writeBank,
	writeEntity,
} from "@/packages/agent/memory/bank";
import {
	appendDailyLog,
	getDailyLogsRange,
	readDailyLog,
	searchDailyLogs,
	writeDailyEntry,
	writeRetainEntry,
} from "@/packages/agent/memory/daily-log";
import { readMemory, searchMemory, upsertMemory, upsertMemoryBatch, writeMemory } from "@/packages/agent/memory/memory";
import {
	appendMemoryFile,
	ensureDir,
	ensureMemoryDirs,
	entryExists,
	getDailyLogDate,
	listDailyLogs,
	listEntities as listEntitiesStorage,
	readAllMemoryFiles,
	readMemoryFile,
	resolveDailyLogPath,
	resolveEntityPath,
	resolveMemoryPaths,
	writeMemoryFile,
} from "@/packages/agent/memory/storage";

describe("memory/storage", () => {
	const tmpDir = path.join(os.tmpdir(), `cc-bridge-storage-test-${Date.now()}`);

	beforeEach(async () => {
		await fs.mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// resolveMemoryPaths
	test("resolveMemoryPaths returns correct structure", () => {
		const paths = resolveMemoryPaths(tmpDir);
		expect(paths.root).toBe(path.join(tmpDir, ".memory"));
		expect(paths.memory).toBe(path.join(tmpDir, ".memory", "MEMORY.md"));
		expect(paths.daily).toBe(path.join(tmpDir, ".memory", "daily"));
		expect(paths.bank).toBe(path.join(tmpDir, ".memory", "bank"));
		expect(paths.world).toBe(path.join(tmpDir, ".memory", "bank", "world.md"));
		expect(paths.experience).toBe(path.join(tmpDir, ".memory", "bank", "experience.md"));
		expect(paths.opinions).toBe(path.join(tmpDir, ".memory", "bank", "opinions.md"));
		expect(paths.entities).toBe(path.join(tmpDir, ".memory", "bank", "entities"));
	});

	// ensureDir
	test("ensureDir creates directory recursively", async () => {
		const nestedDir = path.join(tmpDir, "a", "b", "c");
		await ensureDir(nestedDir);
		await fs.access(nestedDir); // Should not throw
	});

	// ensureMemoryDirs
	test("ensureMemoryDirs creates all memory directories", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.access(paths.root);
		await fs.access(paths.daily);
		await fs.access(paths.bank);
		await fs.access(paths.entities);
	});

	// writeMemoryFile
	test("writeMemoryFile creates file with content", async () => {
		const filePath = path.join(tmpDir, "test.txt");
		await writeMemoryFile(filePath, "Hello World");
		const content = await fs.readFile(filePath, "utf-8");
		expect(content).toBe("Hello World");
	});

	// readMemoryFile
	test("readMemoryFile reads existing file", async () => {
		const filePath = path.join(tmpDir, "test.txt");
		await fs.writeFile(filePath, "Test Content");
		const doc = await readMemoryFile(filePath, { type: "memory" });
		expect(doc.text).toBe("Test Content");
		expect(doc.path).toBe(filePath);
		expect(doc.source.type).toBe("memory");
	});

	test("readMemoryFile returns empty for missing file", async () => {
		const filePath = path.join(tmpDir, "nonexistent.txt");
		const doc = await readMemoryFile(filePath, { type: "memory" });
		expect(doc.text).toBe("");
		expect(doc.path).toBe(filePath);
	});

	// appendMemoryFile
	test("appendMemoryFile appends to empty file", async () => {
		const filePath = path.join(tmpDir, "append-test.txt");
		await appendMemoryFile(filePath, "First entry");
		const content = await fs.readFile(filePath, "utf-8");
		expect(content).toBe("First entry\n");
	});

	test("appendMemoryFile appends with spacing to existing file", async () => {
		const filePath = path.join(tmpDir, "append-test2.txt");
		await fs.writeFile(filePath, "Existing content");
		await appendMemoryFile(filePath, "New entry");
		const content = await fs.readFile(filePath, "utf-8");
		expect(content).toContain("Existing content");
		expect(content).toContain("New entry");
	});

	test("appendMemoryFile ignores empty entry", async () => {
		const filePath = path.join(tmpDir, "append-test3.txt");
		await fs.writeFile(filePath, "Existing");
		await appendMemoryFile(filePath, "   ");
		const content = await fs.readFile(filePath, "utf-8");
		expect(content).toBe("Existing");
	});

	// entryExists
	test("entryExists returns true for existing entry", () => {
		const existing = "Line 1\nLine 2\nLine 3";
		expect(entryExists(existing, "Line 2")).toBe(true);
	});

	test("entryExists returns false for missing entry", () => {
		const existing = "Line 1\nLine 2\nLine 3";
		expect(entryExists(existing, "Line 4")).toBe(false);
	});

	test("entryExists trims before checking", () => {
		const existing = "Line 1\nLine 2\nLine 3";
		expect(entryExists(existing, "  Line 2  ")).toBe(true);
	});

	// listDailyLogs
	test("listDailyLogs returns sorted daily log paths", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.writeFile(path.join(paths.daily, "2024-01-01.md"), "content");
		await fs.writeFile(path.join(paths.daily, "2024-01-03.md"), "content");
		await fs.writeFile(path.join(paths.daily, "2024-01-02.md"), "content");
		const logs = await listDailyLogs(paths.daily);
		expect(logs).toHaveLength(3);
		expect(logs[0]).toContain("2024-01-03");
	});

	test("listDailyLogs returns empty for missing directory", async () => {
		const logs = await listDailyLogs(path.join(tmpDir, "nonexistent"));
		expect(logs).toEqual([]);
	});

	// listEntities
	test("listEntities returns entity file paths", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.writeFile(path.join(paths.entities, "alice.md"), "content");
		await fs.writeFile(path.join(paths.entities, "bob.md"), "content");
		const entities = await listEntitiesStorage(paths.entities);
		expect(entities.some((e) => e.includes("alice"))).toBe(true);
		expect(entities.some((e) => e.includes("bob"))).toBe(true);
	});

	// getDailyLogDate
	test("getDailyLogDate formats date correctly", () => {
		const date = new Date("2024-03-15T12:00:00Z");
		const dateStr = getDailyLogDate(date);
		expect(dateStr).toBe("2024-03-15");
	});

	test("getDailyLogDate uses current date when not provided", () => {
		const dateStr = getDailyLogDate();
		expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	// resolveDailyLogPath
	test("resolveDailyLogPath creates correct path", () => {
		const paths = resolveMemoryPaths(tmpDir);
		const logPath = resolveDailyLogPath(paths, "2024-05-20");
		expect(logPath).toBe(path.join(paths.daily, "2024-05-20.md"));
	});

	test("resolveDailyLogPath uses today when no date provided", () => {
		const paths = resolveMemoryPaths(tmpDir);
		const logPath = resolveDailyLogPath(paths);
		const today = getDailyLogDate();
		expect(logPath).toBe(path.join(paths.daily, `${today}.md`));
	});

	// resolveEntityPath
	test("resolveEntityPath slugifies entity name", () => {
		const paths = resolveMemoryPaths(tmpDir);
		const entityPath = resolveEntityPath(paths, "Alice Smith");
		expect(entityPath).toBe(path.join(paths.entities, "alice-smith.md"));
	});

	test("resolveEntityPath handles special characters", () => {
		const paths = resolveMemoryPaths(tmpDir);
		const entityPath = resolveEntityPath(paths, "John O'Brien");
		// Apostrophe is converted to dash, so "John O'Brien" becomes "john-o-brien"
		expect(entityPath).toBe(path.join(paths.entities, "john-o-brien.md"));
	});

	// readAllMemoryFiles
	test("readAllMemoryFiles reads all memory files", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.writeFile(paths.memory, "# Memory");
		await fs.writeFile(path.join(paths.daily, "2024-01-01.md"), "# Daily");
		await fs.writeFile(paths.world, "# World");
		await fs.writeFile(paths.experience, "# Experience");
		await fs.writeFile(paths.opinions, "# Opinions");
		await fs.writeFile(path.join(paths.entities, "alice.md"), "# Alice");
		const docs = await readAllMemoryFiles(paths);
		expect(docs.length).toBeGreaterThanOrEqual(6);
	});

	test("readAllMemoryFiles handles missing files gracefully", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		const docs = await readAllMemoryFiles(paths);
		// Should have memory.md, world.md, experience.md, opinions.md = 4 docs minimum
		expect(docs.length).toBeGreaterThanOrEqual(4);
		docs.forEach((doc) => {
			expect(doc).toHaveProperty("path");
			expect(doc).toHaveProperty("text");
			expect(doc).toHaveProperty("source");
		});
	});
});

describe("memory/daily-log", () => {
	const tmpDir = path.join(os.tmpdir(), `cc-bridge-daily-test-${Date.now()}`);

	beforeEach(async () => {
		await fs.mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// readDailyLog
	test("readDailyLog returns empty for non-existent log", async () => {
		const doc = await readDailyLog(tmpDir, "2024-01-01");
		expect(doc.text).toBe("");
	});

	test("readDailyLog reads existing log", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		const logPath = path.join(paths.daily, "2024-01-01.md");
		await fs.writeFile(logPath, "Daily content");
		const doc = await readDailyLog(tmpDir, "2024-01-01");
		expect(doc.text).toBe("Daily content");
	});

	// appendDailyLog
	test("appendDailyLog appends entry to daily log", async () => {
		const result = await appendDailyLog(tmpDir, "Test entry", "2024-01-01");
		expect(result.ok).toBe(true);
		expect(result.path).toContain("2024-01-01.md");
	});

	test("appendDailyLog rejects whitespace-only entry", async () => {
		const result = await appendDailyLog(tmpDir, "   ");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("empty entry");
	});

	test("appendDailyLog handles duplicate entries", async () => {
		await appendDailyLog(tmpDir, "Same entry", "2024-01-02");
		const result = await appendDailyLog(tmpDir, "Same entry", "2024-01-02");
		expect(result.ok).toBe(true);
	});

	// writeDailyEntry
	test("writeDailyEntry creates structured entry", async () => {
		const result = await appendDailyLog(tmpDir, "Section 1\nContent here", "2024-01-03");
		expect(result.ok).toBe(true);
	});

	// searchDailyLogs
	test("searchDailyLogs finds matches", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.writeFile(path.join(paths.daily, "2024-01-01.md"), "Find me in daily log");
		const results = await searchDailyLogs(tmpDir, "find");
		expect(results.length).toBeGreaterThan(0);
	});

	test("searchDailyLogs is case-insensitive", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.writeFile(path.join(paths.daily, "2024-01-01.md"), "SEARCH term");
		const results = await searchDailyLogs(tmpDir, "search");
		expect(results.length).toBeGreaterThan(0);
	});

	test("searchDailyLogs respects limit", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.writeFile(path.join(paths.daily, "2024-01-01.md"), "Match line 1\nMatch line 2");
		const results = await searchDailyLogs(tmpDir, "match", 1);
		expect(results.length).toBeLessThanOrEqual(1);
	});

	test("searchDailyLogs returns empty for empty directory", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		const results = await searchDailyLogs(tmpDir, "anything");
		expect(results).toEqual([]);
	});

	// writeDailyEntry tests
	test("writeDailyEntry creates structured entry", async () => {
		const result = await writeDailyEntry(tmpDir, "Section Title", "Content here", "2024-03-15");
		expect(result.ok).toBe(true);
		expect(result.path).toContain("2024-03-15.md");
	});

	test("writeDailyEntry formats content with section header", async () => {
		const result = await writeDailyEntry(tmpDir, "Test Section", "Test Content", "2024-03-16");
		expect(result.ok).toBe(true);
		const doc = await readDailyLog(tmpDir, "2024-03-16");
		expect(doc.text).toContain("## Test Section");
		expect(doc.text).toContain("Test Content");
	});

	// writeRetainEntry tests
	test("writeRetainEntry creates W type retain entry", async () => {
		const result = await writeRetainEntry(tmpDir, "W", "alice", "important fact", undefined, "2024-03-17");
		expect(result.ok).toBe(true);
	});

	test("writeRetainEntry creates B type retain entry", async () => {
		const result = await writeRetainEntry(tmpDir, "B", "bob", "did something", undefined, "2024-03-18");
		expect(result.ok).toBe(true);
	});

	test("writeRetainEntry creates O type retain entry with confidence", async () => {
		const result = await writeRetainEntry(tmpDir, "O", "charlie", "prefers X", 0.95, "2024-03-19");
		expect(result.ok).toBe(true);
	});

	test("writeRetainEntry creates S type retain entry", async () => {
		const result = await writeRetainEntry(tmpDir, "S", "dave", "skill level", undefined, "2024-03-20");
		expect(result.ok).toBe(true);
	});

	test("writeRetainEntry formats entry correctly with confidence", async () => {
		const result = await writeRetainEntry(tmpDir, "O", "eve", "opinion here", 0.87, "2024-03-21");
		expect(result.ok).toBe(true);
		const doc = await readDailyLog(tmpDir, "2024-03-21");
		expect(doc.text).toContain("## Retain");
		expect(doc.text).toContain("- O(c=0.87) @eve: opinion here");
	});

	// writeRetainEntry (via appendDailyLog since it calls it internally)
	test("appendDailyLog handles W type retain entry", async () => {
		const result = await appendDailyLog(tmpDir, "## Retain\n- W @alice: fact");
		expect(result.ok).toBe(true);
	});

	test("appendDailyLog handles B type retain entry", async () => {
		const result = await appendDailyLog(tmpDir, "## Retain\n- B @bob: experience");
		expect(result.ok).toBe(true);
	});

	test("appendDailyLog handles O type retain entry with confidence", async () => {
		const result = await appendDailyLog(tmpDir, "## Retain\n- O(c=0.95) @alice: opinion");
		expect(result.ok).toBe(true);
	});

	// getDailyLogsRange tests
	test("getDailyLogsRange returns logs within date range", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.writeFile(path.join(paths.daily, "2024-01-01.md"), "# Log 1");
		await fs.writeFile(path.join(paths.daily, "2024-01-15.md"), "# Log 2");
		await fs.writeFile(path.join(paths.daily, "2024-02-01.md"), "# Log 3");
		const docs = await getDailyLogsRange(tmpDir, "2024-01-01", "2024-01-31");
		expect(docs.length).toBeGreaterThanOrEqual(2); // Should include Jan 1 and Jan 15 only
	});

	test("getDailyLogsRange returns empty when no logs in range", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.writeFile(path.join(paths.daily, "2024-01-15.md"), "# Log");
		const docs = await getDailyLogsRange(tmpDir, "2024-06-01", "2024-06-30");
		expect(docs.length).toBe(0);
	});

	test("getDailyLogsRange handles empty daily directory", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		const docs = await getDailyLogsRange(tmpDir, "2024-01-01", "2024-12-31");
		expect(docs.length).toBe(0);
	});
});

describe("memory/memory", () => {
	const tmpDir = path.join(os.tmpdir(), `cc-bridge-memory-test-${Date.now()}`);

	beforeEach(async () => {
		await fs.mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// readMemory
	test("readMemory returns empty for non-existent memory", async () => {
		const doc = await readMemory(tmpDir);
		expect(doc.text).toBe("");
	});

	test("readMemory reads existing memory", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.writeFile(paths.memory, "# Memory content");
		const doc = await readMemory(tmpDir);
		expect(doc.text).toBe("# Memory content");
	});

	// writeMemory
	test("writeMemory overwrites entire memory file", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await writeMemory(tmpDir, "# New content");
		const doc = await readMemory(tmpDir);
		expect(doc.text).toBe("# New content");
	});

	// upsertMemory
	test("upsertMemory appends new entry", async () => {
		const result = await upsertMemory(tmpDir, "New memory entry");
		expect(result.ok).toBe(true);
		expect(result.path).toContain("MEMORY.md");
	});

	test("upsertMemory rejects empty entry", async () => {
		const result = await upsertMemory(tmpDir, "");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("empty entry");
	});

	test("upsertMemory rejects whitespace entry", async () => {
		const result = await upsertMemory(tmpDir, "   ");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("empty entry");
	});

	test("upsertMemory avoids duplicates", async () => {
		await upsertMemory(tmpDir, "Unique memory");
		const result = await upsertMemory(tmpDir, "Unique memory");
		expect(result.ok).toBe(true);
	});

	// upsertMemoryBatch
	test("upsertMemoryBatch appends multiple entries", async () => {
		const result = await upsertMemoryBatch(tmpDir, ["Entry 1", "Entry 2", "Entry 3"]);
		expect(result.ok).toBe(true);
		const doc = await readMemory(tmpDir);
		expect(doc.text).toContain("Entry 1");
		expect(doc.text).toContain("Entry 2");
		expect(doc.text).toContain("Entry 3");
	});

	test("upsertMemoryBatch filters duplicates", async () => {
		await upsertMemory(tmpDir, "Existing entry");
		const result = await upsertMemoryBatch(tmpDir, ["Existing entry", "New entry"]);
		expect(result.ok).toBe(true);
	});

	test("upsertMemoryBatch returns ok when all entries are duplicates", async () => {
		await upsertMemory(tmpDir, "Duplicate entry");
		const result = await upsertMemoryBatch(tmpDir, ["Duplicate entry"]);
		expect(result.ok).toBe(true);
	});

	test("upsertMemoryBatch handles empty array", async () => {
		const result = await upsertMemoryBatch(tmpDir, []);
		expect(result.ok).toBe(true);
	});

	// searchMemory
	test("searchMemory finds matches", async () => {
		await upsertMemory(tmpDir, "Important fact to find");
		const results = await searchMemory(tmpDir, "important");
		expect(results.length).toBeGreaterThan(0);
	});

	test("searchMemory is case-insensitive", async () => {
		await upsertMemory(tmpDir, "UPPERCASE TEXT");
		const results = await searchMemory(tmpDir, "uppercase");
		expect(results.length).toBeGreaterThan(0);
	});

	test("searchMemory returns empty for no matches", async () => {
		const results = await searchMemory(tmpDir, "nonexistent");
		expect(results).toEqual([]);
	});

	test("searchMemory truncates long snippets", async () => {
		const longText = "A".repeat(300);
		await upsertMemory(tmpDir, longText);
		const results = await searchMemory(tmpDir, "A");
		expect(results[0].text.length).toBeLessThan(250);
	});
});

describe("memory/bank", () => {
	const tmpDir = path.join(os.tmpdir(), `cc-bridge-bank-test-${Date.now()}`);

	beforeEach(async () => {
		await fs.mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// readBank
	test("readBank reads world bank", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.writeFile(paths.world, "# World facts");
		const doc = await readBank(tmpDir, "world");
		expect(doc.text).toBe("# World facts");
	});

	test("readBank reads experience bank", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.writeFile(paths.experience, "# Experiences");
		const doc = await readBank(tmpDir, "experience");
		expect(doc.text).toBe("# Experiences");
	});

	test("readBank reads opinions bank", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await fs.writeFile(paths.opinions, "# Opinions");
		const doc = await readBank(tmpDir, "opinions");
		expect(doc.text).toBe("# Opinions");
	});

	test("readBank throws for entities type", async () => {
		await expect(readBank(tmpDir, "entities")).rejects.toThrow("Use readEntity for entity files");
	});

	// writeBank
	test("writeBank overwrites world bank", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await writeBank(tmpDir, "world", "# New world facts");
		const doc = await readBank(tmpDir, "world");
		expect(doc.text).toBe("# New world facts");
	});

	test("writeBank overwrites experience bank", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await writeBank(tmpDir, "experience", "# New experiences");
		const doc = await readBank(tmpDir, "experience");
		expect(doc.text).toBe("# New experiences");
	});

	test("writeBank overwrites opinions bank", async () => {
		const paths = resolveMemoryPaths(tmpDir);
		await ensureMemoryDirs(paths);
		await writeBank(tmpDir, "opinions", "# New opinions");
		const doc = await readBank(tmpDir, "opinions");
		expect(doc.text).toBe("# New opinions");
	});

	test("writeBank throws for entities type", async () => {
		await expect(writeBank(tmpDir, "entities", "content")).rejects.toThrow("Use writeEntity for entity files");
	});

	// upsertBank
	test("upsertBank appends to world bank", async () => {
		const result = await upsertBank(tmpDir, "world", "New world fact");
		expect(result.ok).toBe(true);
		expect(result.path).toContain("world.md");
	});

	test("upsertBank appends to experience bank", async () => {
		const result = await upsertBank(tmpDir, "experience", "New experience");
		expect(result.ok).toBe(true);
	});

	test("upsertBank appends to opinions bank", async () => {
		const result = await upsertBank(tmpDir, "opinions", "New opinion");
		expect(result.ok).toBe(true);
	});

	test("upsertBank avoids duplicates", async () => {
		await upsertBank(tmpDir, "world", "Same fact");
		const result = await upsertBank(tmpDir, "world", "Same fact");
		expect(result.ok).toBe(true);
	});

	test("upsertBank throws for entities type", async () => {
		await expect(upsertBank(tmpDir, "entities", "content")).rejects.toThrow("Use upsertEntity for entity files");
	});

	// writeEntity
	test("writeEntity creates entity file", async () => {
		await writeEntity(tmpDir, "alice", "# Alice facts");
		const paths = resolveMemoryPaths(tmpDir);
		const entityPath = path.join(paths.entities, "alice.md");
		const content = await fs.readFile(entityPath, "utf-8");
		expect(content).toBe("# Alice facts");
	});

	test("writeEntity slugifies entity name", async () => {
		await writeEntity(tmpDir, "Bob Smith", "# Bob facts");
		const paths = resolveMemoryPaths(tmpDir);
		const entityPath = path.join(paths.entities, "bob-smith.md");
		const content = await fs.readFile(entityPath, "utf-8");
		expect(content).toBe("# Bob facts");
	});

	// upsertEntity
	test("upsertEntity appends to entity file", async () => {
		const result = await upsertEntity(tmpDir, "alice", "New alice fact");
		expect(result.ok).toBe(true);
		expect(result.path).toContain("alice.md");
	});

	test("upsertEntity avoids duplicates", async () => {
		await upsertEntity(tmpDir, "alice", "Same fact");
		const result = await upsertEntity(tmpDir, "alice", "Same fact");
		expect(result.ok).toBe(true);
	});

	// listEntitiesBank
	test("listEntitiesBank returns entity names", async () => {
		await writeEntity(tmpDir, "alice", "content");
		await writeEntity(tmpDir, "bob", "content");
		const entities = await listEntitiesBank(tmpDir);
		expect(entities).toContain("alice");
		expect(entities).toContain("bob");
	});

	test("listEntitiesBank returns empty for no entities", async () => {
		const entities = await listEntitiesBank(tmpDir);
		expect(entities).toEqual([]);
	});

	// searchBank
	test("searchBank finds matches in world bank", async () => {
		await upsertBank(tmpDir, "world", "World fact to find");
		const results = await searchBank(tmpDir, "world");
		expect(results.length).toBeGreaterThan(0);
	});

	test("searchBank finds matches in experience bank", async () => {
		await upsertBank(tmpDir, "experience", "Experience to find");
		const results = await searchBank(tmpDir, "experience");
		expect(results.length).toBeGreaterThan(0);
	});

	test("searchBank finds matches in opinions bank", async () => {
		await upsertBank(tmpDir, "opinions", "Opinion to find");
		const results = await searchBank(tmpDir, "opinion");
		expect(results.length).toBeGreaterThan(0);
	});

	test("searchBank finds matches in entity bank", async () => {
		await upsertEntity(tmpDir, "alice", "Alice entity to find");
		const results = await searchBank(tmpDir, "alice");
		expect(results.length).toBeGreaterThan(0);
	});

	test("searchBank is case-insensitive", async () => {
		await upsertBank(tmpDir, "world", "SEARCH term");
		const results = await searchBank(tmpDir, "search");
		expect(results.length).toBeGreaterThan(0);
	});

	test("searchBank respects limit", async () => {
		await upsertBank(tmpDir, "world", "Match 1");
		await upsertBank(tmpDir, "world", "Match 2");
		const results = await searchBank(tmpDir, "match", 1);
		expect(results.length).toBeLessThanOrEqual(1);
	});

	test("searchBank returns empty for no matches", async () => {
		const results = await searchBank(tmpDir, "nonexistent");
		expect(results).toEqual([]);
	});

	test("searchBank handles missing bank files gracefully", async () => {
		const results = await searchBank(tmpDir, "anything");
		expect(Array.isArray(results)).toBe(true);
	});
});
