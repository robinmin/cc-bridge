/**
 * Memory Storage Layer
 *
 * File I/O operations for the memory system.
 * Follows Openclaw's markdown-first approach.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryDoc, MemoryPaths, MemorySource } from "./types";

// Re-export from daily-log.ts
export { appendDailyLog, searchDailyLogs } from "./daily-log";
// Re-export from memory.ts for backward compatibility
export { getMemoryPaths, readMemory, upsertMemory } from "./memory";

/**
 * Resolve paths for memory files
 */
export function resolveMemoryPaths(workspaceRoot: string): MemoryPaths {
	const memoryRoot = path.join(workspaceRoot, ".memory");
	return {
		root: memoryRoot,
		memory: path.join(memoryRoot, "MEMORY.md"),
		daily: path.join(memoryRoot, "daily"),
		bank: path.join(memoryRoot, "bank"),
		world: path.join(memoryRoot, "bank", "world.md"),
		experience: path.join(memoryRoot, "bank", "experience.md"),
		opinions: path.join(memoryRoot, "bank", "opinions.md"),
		entities: path.join(memoryRoot, "bank", "entities"),
	};
}

/**
 * Ensure directory exists
 */
export async function ensureDir(dirPath: string): Promise<void> {
	await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Ensure all memory directories exist
 */
export async function ensureMemoryDirs(paths: MemoryPaths): Promise<void> {
	await ensureDir(paths.root);
	await ensureDir(paths.daily);
	await ensureDir(paths.bank);
	await ensureDir(paths.entities);
}

/**
 * Read a memory file
 */
export async function readMemoryFile(filePath: string, source: MemorySource): Promise<MemoryDoc> {
	try {
		const text = await fs.readFile(filePath, "utf-8");
		const stats = await fs.stat(filePath);
		return {
			path: filePath,
			text,
			source,
			lastModified: stats.mtime,
		};
	} catch (error) {
		// Missing memory files are valid state
		if (isFileMissingError(error)) {
			return {
				path: filePath,
				text: "",
				source,
			};
		}
		throw error;
	}
}

/**
 * Write to a memory file
 */
export async function writeMemoryFile(filePath: string, text: string): Promise<void> {
	await ensureDir(path.dirname(filePath));
	await fs.writeFile(filePath, text, "utf-8");
}

/**
 * Append to a memory file with spacing
 */
export async function appendMemoryFile(filePath: string, entry: string): Promise<void> {
	const trimmedEntry = entry.trim();
	if (!trimmedEntry) {
		return;
	}

	await ensureDir(path.dirname(filePath));

	let existing = "";
	try {
		existing = await fs.readFile(filePath, "utf-8");
	} catch (error) {
		if (!isFileMissingError(error)) {
			throw error;
		}
	}

	const updated = appendWithSpacing(existing, trimmedEntry);
	await fs.writeFile(filePath, updated, "utf-8");
}

/**
 * Append text with proper spacing
 */
function appendWithSpacing(existing: string, entry: string): string {
	const trimmedEntry = entry.trim();
	if (!trimmedEntry) {
		return existing;
	}
	if (!existing.trim()) {
		return `${trimmedEntry}\n`;
	}
	return `${existing.trimEnd()}\n\n${trimmedEntry}\n`;
}

/**
 * Check if entry already exists (for deduplication)
 */
export function entryExists(existing: string, newEntry: string): boolean {
	const trimmed = newEntry.trim();
	return existing.includes(trimmed);
}

/**
 * List daily log files
 */
export async function listDailyLogs(dailyDir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dailyDir, { withFileTypes: true });
		return entries
			.filter((e) => e.isFile() && e.name.endsWith(".md"))
			.map((e) => path.join(dailyDir, e.name))
			.sort()
			.reverse(); // Most recent first
	} catch {
		return [];
	}
}

/**
 * List entity files
 */
export async function listEntities(entitiesDir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(entitiesDir, { withFileTypes: true });
		return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => path.join(entitiesDir, e.name));
	} catch {
		return [];
	}
}

/**
 * Get date string for daily log
 */
export function getDailyLogDate(date?: Date): string {
	const d = date ?? new Date();
	const yyyy = String(d.getFullYear());
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

/**
 * Resolve daily log path
 */
export function resolveDailyLogPath(paths: MemoryPaths, date?: string): string {
	const dateStr = date ?? getDailyLogDate();
	return path.join(paths.daily, `${dateStr}.md`);
}

/**
 * Resolve entity path
 */
export function resolveEntityPath(paths: MemoryPaths, entity: string): string {
	const slug = slugify(entity);
	return path.join(paths.entities, `${slug}.md`);
}

/**
 * Convert entity name to slug
 */
function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Check if error is file missing
 */
function isFileMissingError(error: unknown): boolean {
	if (error instanceof Error && "code" in error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
	return false;
}

/**
 * Read all memory files for indexing
 */
export async function readAllMemoryFiles(paths: MemoryPaths): Promise<MemoryDoc[]> {
	const docs: MemoryDoc[] = [];

	// Read memory.md
	docs.push(await readMemoryFile(paths.memory, { type: "memory" }));

	// Read daily logs
	const dailyFiles = await listDailyLogs(paths.daily);
	for (const file of dailyFiles) {
		const _dateMatch = file.match(/(\d{4}-\d{2}-\d{2})\.md$/);
		docs.push(
			await readMemoryFile(file, {
				type: "daily",
			}),
		);
	}

	// Read bank pages
	docs.push(await readMemoryFile(paths.world, { type: "bank", bankType: "world" }));
	docs.push(
		await readMemoryFile(paths.experience, {
			type: "bank",
			bankType: "experience",
		}),
	);
	docs.push(await readMemoryFile(paths.opinions, { type: "bank", bankType: "opinions" }));

	// Read entities
	const entityFiles = await listEntities(paths.entities);
	for (const file of entityFiles) {
		const entityMatch = file.match(/([^/]+)\.md$/);
		const entity = entityMatch ? entityMatch[1] : "unknown";
		docs.push(
			await readMemoryFile(file, {
				type: "bank",
				bankType: "entities",
				entity,
			}),
		);
	}

	return docs;
}
