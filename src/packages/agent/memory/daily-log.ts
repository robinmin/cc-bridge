/**
 * Daily Log Operations
 *
 * Handles memory/YYYY-MM-DD.md daily log files.
 */

import { appendMemoryFile, entryExists, readMemoryFile, resolveDailyLogPath, resolveMemoryPaths } from "./storage";
import type { MemoryDoc, MemoryWriteResult } from "./types";

/**
 * Read a daily log
 */
export async function readDailyLog(workspaceRoot: string, date?: string): Promise<MemoryDoc> {
	const paths = resolveMemoryPaths(workspaceRoot);
	const logPath = resolveDailyLogPath(paths, date);
	return readMemoryFile(logPath, { type: "daily" });
}

/**
 * Append to daily log
 */
export async function appendDailyLog(workspaceRoot: string, entry: string, date?: string): Promise<MemoryWriteResult> {
	// Reject empty or whitespace-only entries
	if (!entry.trim()) {
		return { ok: false, reason: "empty entry" };
	}

	const paths = resolveMemoryPaths(workspaceRoot);
	const logPath = resolveDailyLogPath(paths, date);

	try {
		const existing = await readDailyLog(workspaceRoot, date);

		// Check for duplicate
		if (entryExists(existing.text, entry)) {
			return { ok: true, path: logPath };
		}

		await appendMemoryFile(logPath, entry);
		return { ok: true, path: logPath };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : "write failed",
		};
	}
}

/**
 * Write structured daily entry
 */
export async function writeDailyEntry(
	workspaceRoot: string,
	section: string,
	content: string,
	date?: string,
): Promise<MemoryWriteResult> {
	const entry = `## ${section}\n${content}`;
	return appendDailyLog(workspaceRoot, entry, date);
}

/**
 * Add a Retain section entry (Openclaw-style)
 *
 * Format: W @entity: fact (world)
 *         B @entity: experience
 *         O(c=0.95) @entity: opinion with confidence
 */
export async function writeRetainEntry(
	workspaceRoot: string,
	type: "W" | "B" | "O" | "S",
	entity: string,
	content: string,
	confidence?: number,
	date?: string,
): Promise<MemoryWriteResult> {
	const confStr = confidence !== undefined ? `(c=${confidence.toFixed(2)})` : "";
	const entry = `## Retain\n- ${type}${confStr} @${entity}: ${content}`;
	return appendDailyLog(workspaceRoot, entry, date);
}

/**
 * Search daily logs
 */
export async function searchDailyLogs(
	workspaceRoot: string,
	query: string,
	limit = 5,
): Promise<Array<{ text: string; path: string; date: string }>> {
	const paths = resolveMemoryPaths(workspaceRoot);
	const normalized = query.toLowerCase();
	const results: Array<{ text: string; path: string; date: string }> = [];

	// List all daily files
	const { readdir } = await import("node:fs/promises");
	let dailyFiles: string[] = [];
	try {
		const entries = await readdir(paths.daily, { withFileTypes: true });
		dailyFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => `${paths.daily}/${e.name}`);
	} catch {
		// Daily directory doesn't exist yet
		return [];
	}

	// Search each file
	for (const file of dailyFiles) {
		if (results.length >= limit) break;

		const doc = await readMemoryFile(file, { type: "daily" });
		if (!doc.text) continue;

		const lines = doc.text.split(/\r?\n/);
		for (const line of lines) {
			if (results.length >= limit) break;

			const trimmed = line.trim();
			if (!trimmed) continue;
			if (trimmed.toLowerCase().includes(normalized)) {
				const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})\.md$/);
				results.push({
					text: trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed,
					path: doc.path,
					date: dateMatch ? dateMatch[1] : "unknown",
				});
			}
		}
	}

	return results;
}

/**
 * Get all daily logs for a date range
 */
export async function getDailyLogsRange(
	workspaceRoot: string,
	startDate: string,
	endDate: string,
): Promise<MemoryDoc[]> {
	const paths = resolveMemoryPaths(workspaceRoot);
	const docs: MemoryDoc[] = [];

	const { readdir } = await import("node:fs/promises");
	let dailyFiles: string[] = [];
	try {
		const entries = await readdir(paths.daily, { withFileTypes: true });
		dailyFiles = entries
			.filter((e) => e.isFile() && e.name.endsWith(".md"))
			.map((e) => `${paths.daily}/${e.name}`)
			.sort();
	} catch {
		return [];
	}

	for (const file of dailyFiles) {
		const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})\.md$/);
		if (!dateMatch) continue;

		const fileDate = dateMatch[1];
		if (fileDate >= startDate && fileDate <= endDate) {
			const doc = await readMemoryFile(file, { type: "daily" });
			docs.push(doc);
		}
	}

	return docs;
}
