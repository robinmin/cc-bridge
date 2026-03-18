/**
 * SQLite FTS5 Indexer
 *
 * Full-text search using SQLite FTS5.
 * Index is rebuildable from markdown source.
 */

import path from "node:path";
import Database from "node:sqlite";
import { readAllMemoryFiles } from "./storage";
import type { IndexEntry, IndexStatus, MemoryPaths } from "./types";

const FTS_TABLE = "memory_fts";
const DOCS_TABLE = "memory_docs";

/**
 * FTS5 Index Manager
 */
export class Fts5Indexer {
	private db: Database.Database | null = null;
	private paths: MemoryPaths;
	private indexPath: string;

	constructor(_workspaceRoot: string, paths: MemoryPaths) {
		this.paths = paths;
		this.indexPath = path.join(paths.root, "memory.db");
	}

	/**
	 * Initialize the database
	 */
	async initialize(): Promise<void> {
		this.db = new Database.Database(this.indexPath);

		// Create documents table
		this.db.run(`
			CREATE TABLE IF NOT EXISTS ${DOCS_TABLE} (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				path TEXT NOT NULL UNIQUE,
				source_type TEXT NOT NULL,
				bank_type TEXT,
				entity TEXT,
				content TEXT NOT NULL,
				last_modified INTEGER
			)
		`);

		// Create FTS5 virtual table
		this.db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
				content,
				content=${DOCS_TABLE},
				content_rowid=id
			)
		`);

		// Create triggers to keep FTS in sync
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS ${DOCS_TABLE}_ai AFTER INSERT ON ${DOCS_TABLE} BEGIN
				INSERT INTO ${FTS_TABLE}(rowid, content) VALUES (new.id, new.content);
			END
		`);

		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS ${DOCS_TABLE}_ad AFTER DELETE ON ${DOCS_TABLE} BEGIN
				INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, content) VALUES('delete', old.id, old.content);
			END
		`);

		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS ${DOCS_TABLE}_au AFTER UPDATE ON ${DOCS_TABLE} BEGIN
				INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, content) VALUES('delete', old.id, old.content);
				INSERT INTO ${FTS_TABLE}(rowid, content) VALUES (new.id, new.content);
			END
		`);
	}

	/**
	 * Close the database
	 */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	/**
	 * Check if FTS5 is available
	 */
	isAvailable(): boolean {
		return this.db !== null;
	}

	/**
	 * Get index status
	 */
	async getStatus(): Promise<IndexStatus> {
		if (!this.db) {
			return {
				initialized: false,
				fts5: false,
				vector: false,
				documentCount: 0,
			};
		}

		try {
			const result = this.db.prepare(`SELECT COUNT(*) as count FROM ${DOCS_TABLE}`).get() as {
				count: number;
			};
			const lastIndexed = this.db.prepare(`SELECT MAX(last_modified) as last FROM ${DOCS_TABLE}`).get() as {
				last: number | null;
			};

			return {
				initialized: true,
				fts5: true,
				vector: false, // Vector is separate
				documentCount: result.count,
				lastIndexed: lastIndexed.last ? new Date(lastIndexed.last) : undefined,
			};
		} catch {
			return {
				initialized: false,
				fts5: false,
				vector: false,
				documentCount: 0,
			};
		}
	}

	/**
	 * Rebuild index from markdown files
	 */
	async rebuild(): Promise<{ ok: boolean; reason?: string }> {
		if (!this.db) {
			return { ok: false, reason: "not initialized" };
		}

		try {
			// Clear existing data
			this.db.run(`DELETE FROM ${FTS_TABLE}`);
			this.db.run(`DELETE FROM ${DOCS_TABLE}`);

			// Read all memory files
			const docs = await readAllMemoryFiles(this.paths);

			// Insert each document
			const insert = this.db.prepare(`
				INSERT INTO ${DOCS_TABLE} (path, source_type, bank_type, entity, content, last_modified)
				VALUES (?, ?, ?, ?, ?, ?)
			`);

			for (const doc of docs) {
				if (!doc.text) continue;

				insert.run(
					doc.path,
					doc.source.type,
					doc.source.bankType ?? null,
					doc.source.entity ?? null,
					doc.text,
					doc.lastModified?.getTime() ?? Date.now(),
				);
			}

			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : "rebuild failed",
			};
		}
	}

	/**
	 * Search using FTS5
	 */
	async search(query: string, limit = 5): Promise<IndexEntry[]> {
		if (!this.db || !query.trim()) {
			return [];
		}

		try {
			// Escape special FTS5 characters
			const escapedQuery = query.replace(/['"]/g, "").trim();

			const results = this.db
				.prepare(
					`
				SELECT d.id, d.path, d.source_type as sourceType, d.bank_type as bankType,
					   d.entity, snippet(${FTS_TABLE}, 0, '<mark>', '</mark>', '...', 32) as snippet
				FROM ${FTS_TABLE} f
				JOIN ${DOCS_TABLE} d ON f.rowid = d.id
				WHERE ${FTS_TABLE} MATCH ?
				ORDER BY rank
				LIMIT ?
			`,
				)
				.all(escapedQuery, limit) as Array<{
				id: number;
				path: string;
				sourceType: string;
				bankType: string | null;
				entity: string | null;
				snippet: string;
			}>;

			return results.map((r) => ({
				id: r.id,
				path: r.path,
				source: {
					type: r.sourceType as "memory" | "daily" | "bank",
					bankType: r.bankType as "world" | "experience" | "opinions" | "entities" | undefined,
					entity: r.entity ?? undefined,
				},
				content: r.snippet,
			}));
		} catch {
			// FTS5 search failed, return empty
			return [];
		}
	}

	/**
	 * Update a single document in the index
	 */
	async updateDocument(docPath: string, content: string): Promise<void> {
		if (!this.db) return;

		try {
			// Check if document exists
			const existing = this.db.prepare(`SELECT id FROM ${DOCS_TABLE} WHERE path = ?`).get(docPath);

			if (existing) {
				this.db
					.prepare(`UPDATE ${DOCS_TABLE} SET content = ?, last_modified = ? WHERE path = ?`)
					.run(content, Date.now(), docPath);
			} else {
				// Insert new document - need to determine source type
				const sourceType = docPath.includes("/daily/") ? "daily" : docPath.includes("/bank/") ? "bank" : "memory";

				this.db
					.prepare(`INSERT INTO ${DOCS_TABLE} (path, source_type, content, last_modified) VALUES (?, ?, ?, ?)`)
					.run(docPath, sourceType, content, Date.now());
			}
		} catch {
			// Update failed, ignore
		}
	}
}

/**
 * Create FTS5 indexer
 */
export function createFts5Indexer(workspaceRoot: string, paths: MemoryPaths): Fts5Indexer {
	return new Fts5Indexer(workspaceRoot, paths);
}
