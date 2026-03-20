/**
 * SQLite FTS5 Indexer
 *
 * Full-text search using SQLite FTS5.
 * Index is rebuildable from markdown source.
 */

import path from "node:path";
import Database from "node:sqlite";
import type { EmbeddingProviderInterface } from "./embeddings";
import { readAllMemoryFiles } from "./storage";
import type { IndexEntry, IndexStatus, MemoryPaths } from "./types";

const FTS_TABLE = "memory_fts";
const DOCS_TABLE = "memory_docs";
const VECTORS_TABLE = "memory_vectors";

/**
 * FTS5 Index Manager with Vector Support
 */
export class Fts5Indexer {
	private db: Database.Database | null = null;
	private paths: MemoryPaths;
	private indexPath: string;
	private embeddingProvider: EmbeddingProviderInterface | null = null;

	constructor(_workspaceRoot: string, paths: MemoryPaths) {
		this.paths = paths;
		this.indexPath = path.join(paths.root, "memory.db");
	}

	/**
	 * Set embedding provider for vector operations
	 */
	setEmbeddingProvider(provider: EmbeddingProviderInterface): void {
		this.embeddingProvider = provider;
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

		// Create vectors table for embeddings
		this.db.run(`
			CREATE TABLE IF NOT EXISTS ${VECTORS_TABLE} (
				doc_id INTEGER PRIMARY KEY,
				embedding BLOB NOT NULL,
				FOREIGN KEY (doc_id) REFERENCES ${DOCS_TABLE}(id) ON DELETE CASCADE
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
				DELETE FROM ${VECTORS_TABLE} WHERE doc_id = old.id;
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
	 * Check if vector support is enabled
	 */
	isVectorEnabled(): boolean {
		return this.db !== null && this.embeddingProvider !== null;
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

			// Check if vectors exist
			const vectorsExist = this.db.prepare(`SELECT COUNT(*) as count FROM ${VECTORS_TABLE}`).get() as {
				count: number;
			};

			return {
				initialized: true,
				fts5: true,
				vector: vectorsExist.count > 0,
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
			this.db.run(`DELETE FROM ${VECTORS_TABLE}`);

			// Read all memory files
			const docs = await readAllMemoryFiles(this.paths);

			// Insert each document
			const insert = this.db.prepare(`
				INSERT INTO ${DOCS_TABLE} (path, source_type, bank_type, entity, content, last_modified)
				VALUES (?, ?, ?, ?, ?, ?)
			`);

			const docIds: Array<{ id: number; text: string }> = [];

			for (const doc of docs) {
				if (!doc.text) continue;

				const result = insert.run(
					doc.path,
					doc.source.type,
					doc.source.bankType ?? null,
					doc.source.entity ?? null,
					doc.text,
					doc.lastModified?.getTime() ?? Date.now(),
				);
				docIds.push({ id: result.lastInsertRowid as number, text: doc.text });
			}

			// Generate and store embeddings if provider is available
			if (this.embeddingProvider && docIds.length > 0) {
				await this.generateEmbeddings(docIds);
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
	 * Generate embeddings for documents
	 */
	private async generateEmbeddings(docIds: Array<{ id: number; text: string }>): Promise<void> {
		if (!this.embeddingProvider || !this.db) return;

		try {
			// Batch process to avoid API limits
			const batchSize = 100;
			for (let i = 0; i < docIds.length; i += batchSize) {
				const batch = docIds.slice(i, i + batchSize);
				const texts = batch.map((d) => d.text.slice(0, 8000)); // Truncate long texts

				try {
					const results = await this.embeddingProvider.embedBatch(texts);

					const insert = this.db.prepare(`
						INSERT INTO ${VECTORS_TABLE} (doc_id, embedding) VALUES (?, ?)
					`);

					for (let j = 0; j < batch.length; j++) {
						const embedding = results[j]?.embedding;
						if (embedding) {
							// Store embedding as blob (JSON serialized array)
							const blob = Buffer.from(JSON.stringify(embedding));
							insert.run(batch[j].id, blob);
						}
					}
				} catch (error) {
					// Continue with next batch on error
					console.error("Error generating embeddings for batch:", error);
				}
			}
		} catch (error) {
			console.error("Error generating embeddings:", error);
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
	 * Search using vector similarity (cosine similarity)
	 */
	async searchVectors(query: string, limit = 5): Promise<IndexEntry[]> {
		if (!this.db || !this.embeddingProvider || !query.trim()) {
			return [];
		}

		try {
			// Generate embedding for query
			const queryEmbedding = await this.embeddingProvider.embed(query.slice(0, 8000));
			const queryVec = queryEmbedding.embedding;

			// Get all vectors and compute cosine similarity
			const vectors = this.db
				.prepare(
					`
				SELECT v.doc_id, v.embedding, d.path, d.source_type as sourceType, d.bank_type as bankType, d.entity, d.content
				FROM ${VECTORS_TABLE} v
				JOIN ${DOCS_TABLE} d ON v.doc_id = d.id
			`,
				)
				.all() as Array<{
				doc_id: number;
				embedding: Buffer;
				path: string;
				sourceType: string;
				bankType: string | null;
				entity: string | null;
				content: string;
			}>;

			// Compute similarities
			const scored = vectors.map((v) => {
				const embedding = JSON.parse(v.embedding.toString()) as number[];
				const similarity = cosineSimilarity(queryVec, embedding);
				return {
					id: v.doc_id,
					path: v.path,
					source: {
						type: v.sourceType as "memory" | "daily" | "bank",
						bankType: v.bankType as "world" | "experience" | "opinions" | "entities" | undefined,
						entity: v.entity ?? undefined,
					},
					content: v.content.slice(0, 240) + (v.content.length > 240 ? "..." : ""),
					similarity,
				};
			});

			// Sort by similarity and limit
			scored.sort((a, b) => b.similarity - a.similarity);
			const top = scored.slice(0, limit);

			return top.map((s) => ({
				id: s.id,
				path: s.path,
				source: s.source,
				content: s.content,
			}));
		} catch (error) {
			console.error("Vector search error:", error);
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
 * Compute cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	if (normA === 0 || normB === 0) return 0;
	return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Create FTS5 indexer
 */
export function createFts5Indexer(workspaceRoot: string, paths: MemoryPaths): Fts5Indexer {
	return new Fts5Indexer(workspaceRoot, paths);
}
