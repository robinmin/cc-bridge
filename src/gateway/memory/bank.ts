/**
 * Bank Memory Operations
 *
 * Handles typed memory pages: world, experience, opinions, entities.
 * Follows Openclaw's bank/ directory structure.
 */

import {
	appendMemoryFile,
	entryExists,
	readMemoryFile,
	resolveEntityPath,
	resolveMemoryPaths,
	writeMemoryFile,
} from "./storage";
import type { BankType, MemoryDoc, MemoryWriteResult } from "./types";

/**
 * Read a bank page
 */
export async function readBank(workspaceRoot: string, type: BankType): Promise<MemoryDoc> {
	const paths = resolveMemoryPaths(workspaceRoot);

	let filePath: string;
	switch (type) {
		case "world":
			filePath = paths.world;
			break;
		case "experience":
			filePath = paths.experience;
			break;
		case "opinions":
			filePath = paths.opinions;
			break;
		case "entities":
			// Entities is a directory, not a single file
			throw new Error("Use readEntity for entity files");
		default:
			throw new Error(`Unknown bank type: ${type}`);
	}

	return readMemoryFile(filePath, { type: "bank", bankType: type });
}

/**
 * Write entire bank page (for migrations)
 */
export async function writeBank(workspaceRoot: string, type: BankType, content: string): Promise<void> {
	const paths = resolveMemoryPaths(workspaceRoot);

	let filePath: string;
	switch (type) {
		case "world":
			filePath = paths.world;
			break;
		case "experience":
			filePath = paths.experience;
			break;
		case "opinions":
			filePath = paths.opinions;
			break;
		case "entities":
			throw new Error("Use writeEntity for entity files");
		default:
			throw new Error(`Unknown bank type: ${type}`);
	}

	await writeMemoryFile(filePath, content);
}

/**
 * Upsert to a bank page
 */
export async function upsertBank(workspaceRoot: string, type: BankType, entry: string): Promise<MemoryWriteResult> {
	const paths = resolveMemoryPaths(workspaceRoot);

	let filePath: string;
	switch (type) {
		case "world":
			filePath = paths.world;
			break;
		case "experience":
			filePath = paths.experience;
			break;
		case "opinions":
			filePath = paths.opinions;
			break;
		case "entities":
			throw new Error("Use upsertEntity for entity files");
		default:
			throw new Error(`Unknown bank type: ${type}`);
	}

	try {
		const existing = await readBank(workspaceRoot, type);

		// Check for duplicate
		if (entryExists(existing.text, entry)) {
			return { ok: true, path: filePath };
		}

		await appendMemoryFile(filePath, entry);
		return { ok: true, path: filePath };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : "write failed",
		};
	}
}

// ============================================================================
// Entity Operations
// ============================================================================

/**
 * Read an entity file
 */
export async function readEntity(workspaceRoot: string, entity: string): Promise<MemoryDoc> {
	const paths = resolveMemoryPaths(workspaceRoot);
	const entityPath = resolveEntityPath(paths, entity);
	return readMemoryFile(entityPath, {
		type: "bank",
		bankType: "entities",
		entity,
	});
}

/**
 * Write entire entity file
 */
export async function writeEntity(workspaceRoot: string, entity: string, content: string): Promise<void> {
	const paths = resolveMemoryPaths(workspaceRoot);
	const entityPath = resolveEntityPath(paths, entity);
	await writeMemoryFile(entityPath, content);
}

/**
 * Upsert to an entity file
 */
export async function upsertEntity(workspaceRoot: string, entity: string, entry: string): Promise<MemoryWriteResult> {
	const paths = resolveMemoryPaths(workspaceRoot);
	const entityPath = resolveEntityPath(paths, entity);

	try {
		const existing = await readEntity(workspaceRoot, entity);

		// Check for duplicate
		if (entryExists(existing.text, entry)) {
			return { ok: true, path: entityPath };
		}

		await appendMemoryFile(entityPath, entry);
		return { ok: true, path: entityPath };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : "write failed",
		};
	}
}

/**
 * List all entities
 */
export async function listEntities(workspaceRoot: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	const paths = resolveMemoryPaths(workspaceRoot);

	try {
		const entries = await readdir(paths.entities, { withFileTypes: true });
		return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name.replace(/\.md$/, ""));
	} catch {
		return [];
	}
}

/**
 * Search across all bank pages
 */
export async function searchBank(
	workspaceRoot: string,
	query: string,
	limit = 5,
): Promise<Array<{ text: string; path: string; bankType: BankType; entity?: string }>> {
	const normalized = query.toLowerCase();
	const results: Array<{
		text: string;
		path: string;
		bankType: BankType;
		entity?: string;
	}> = [];

	// Search world, experience, opinions
	const bankTypes: BankType[] = ["world", "experience", "opinions"];
	for (const type of bankTypes) {
		if (results.length >= limit) break;

		try {
			const doc = await readBank(workspaceRoot, type);
			if (!doc.text) continue;

			const lines = doc.text.split(/\r?\n/);
			for (const line of lines) {
				if (results.length >= limit) break;

				const trimmed = line.trim();
				if (!trimmed) continue;
				if (trimmed.toLowerCase().includes(normalized)) {
					results.push({
						text: trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed,
						path: doc.path,
						bankType: type,
					});
				}
			}
		} catch {
			// File doesn't exist yet
		}
	}

	// Search entities
	if (results.length < limit) {
		const entities = await listEntities(workspaceRoot);
		for (const entity of entities) {
			if (results.length >= limit) break;

			try {
				const doc = await readEntity(workspaceRoot, entity);
				if (!doc.text) continue;

				const lines = doc.text.split(/\r?\n/);
				for (const line of lines) {
					if (results.length >= limit) break;

					const trimmed = line.trim();
					if (!trimmed) continue;
					if (trimmed.toLowerCase().includes(normalized)) {
						results.push({
							text: trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed,
							path: doc.path,
							bankType: "entities",
							entity,
						});
					}
				}
			} catch {
				// File doesn't exist yet
			}
		}
	}

	return results;
}
