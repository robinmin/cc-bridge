/**
 * Durable Memory Operations
 *
 * Handles the core memory.md file for durable facts and preferences.
 */

import {
	appendMemoryFile,
	entryExists,
	type MemoryPaths,
	readMemoryFile,
	resolveMemoryPaths,
	writeMemoryFile,
} from "./storage";
import type { MemoryDoc, MemoryWriteResult } from "./types";

/**
 * Get the memory file paths
 */
export function getMemoryPaths(workspaceRoot: string): MemoryPaths {
	return resolveMemoryPaths(workspaceRoot);
}

/**
 * Read the main memory file
 */
export async function readMemory(workspaceRoot: string): Promise<MemoryDoc> {
	const paths = getMemoryPaths(workspaceRoot);
	return readMemoryFile(paths.memory, { type: "memory" });
}

/**
 * Write the entire memory file (for migrations)
 */
export async function writeMemory(workspaceRoot: string, content: string): Promise<void> {
	const paths = getMemoryPaths(workspaceRoot);
	await writeMemoryFile(paths.memory, content);
}

/**
 * Upsert to memory (append if not duplicate)
 */
export async function upsertMemory(workspaceRoot: string, entry: string): Promise<MemoryWriteResult> {
	// Reject empty or whitespace-only entries
	if (!entry.trim()) {
		return { ok: false, reason: "empty entry" };
	}

	const paths = getMemoryPaths(workspaceRoot);
	const existing = await readMemory(workspaceRoot);

	// Check for duplicate
	if (entryExists(existing.text, entry)) {
		return { ok: true, path: paths.memory };
	}

	// Append new entry
	await appendMemoryFile(paths.memory, entry);
	return { ok: true, path: paths.memory };
}

/**
 * Add multiple entries to memory
 */
export async function upsertMemoryBatch(workspaceRoot: string, entries: string[]): Promise<MemoryWriteResult> {
	const paths = getMemoryPaths(workspaceRoot);
	const existing = await readMemory(workspaceRoot);

	// Filter out duplicates
	const newEntries = entries.filter((e) => !entryExists(existing.text, e));

	if (newEntries.length === 0) {
		return { ok: true, path: paths.memory };
	}

	// Append all new entries
	for (const entry of newEntries) {
		await appendMemoryFile(paths.memory, entry);
	}

	return { ok: true, path: paths.memory };
}

/**
 * Search memory for text
 */
export async function searchMemory(
	workspaceRoot: string,
	query: string,
): Promise<Array<{ text: string; path: string }>> {
	const doc = await readMemory(workspaceRoot);
	const normalized = query.toLowerCase();
	const results: Array<{ text: string; path: string }> = [];

	const lines = doc.text.split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.toLowerCase().includes(normalized)) {
			results.push({
				text: trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed,
				path: doc.path,
			});
		}
	}

	return results;
}
