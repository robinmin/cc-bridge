import type {
	MemoryBackend,
	MemoryDocument,
	MemorySearchHit,
	MemorySearchOptions,
	MemoryStatus,
	MemoryWriteResult,
	ReindexResult,
} from "@/packages/agent/memory/contracts";
import { searchBank } from "./bank";
import { appendDailyLog, ensureMemoryDirs, getMemoryPaths, readMemory, searchDailyLogs, upsertMemory } from "./storage";

/**
 * Enhanced Builtin Memory Backend
 *
 * Implements Openclaw-style memory layout:
 * - .memory/memory.md - Core durable facts
 * - .memory/daily/YYYY-MM-DD.md - Daily logs
 * - .memory/bank/ - Typed memory pages
 *   - world.md - Objective facts
 *   - experience.md - What agent did
 *   - opinions.md - Subjective preferences
 *   - entities/*.md - Entity-specific facts
 */
export class BuiltinMemoryBackend implements MemoryBackend {
	private initialized = false;

	constructor(private readonly workspaceRoot: string) {}

	private getPaths() {
		return getMemoryPaths(this.workspaceRoot);
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialized) return;
		const paths = this.getPaths();
		await ensureMemoryDirs(paths);
		this.initialized = true;
	}

	async initialize(): Promise<void> {
		await this.ensureInitialized();
	}

	status(): MemoryStatus {
		return {
			slot: "builtin",
			available: true,
		};
	}

	async get(pathOrRef: string): Promise<MemoryDocument> {
		const _paths = this.getPaths();

		// Handle special references
		if (pathOrRef === "memory" || pathOrRef === "memory.md") {
			return readMemory(this.workspaceRoot);
		}

		if (pathOrRef === "daily") {
			// Return today's daily log
			const { appendDailyLog } = await import("./daily-log");
			return appendDailyLog(this.workspaceRoot, "");
		}

		// Check for bank references
		if (pathOrRef.startsWith("bank:")) {
			const type = pathOrRef.replace("bank:", "").replace(".md", "") as "world" | "experience" | "opinions";
			if (["world", "experience", "opinions"].includes(type)) {
				const { readBank } = await import("./bank");
				return readBank(this.workspaceRoot, type);
			}
		}

		// Check for entity references
		if (pathOrRef.startsWith("entity:")) {
			const entity = pathOrRef.replace("entity:", "").replace(".md", "");
			const { readEntity } = await import("./bank");
			return readEntity(this.workspaceRoot, entity);
		}

		// Default: treat as file path
		const { resolve } = await import("node:path");
		const resolved = resolve(this.workspaceRoot, pathOrRef);
		const { readMemoryFile } = await import("./storage");

		try {
			return await readMemoryFile(resolved, { type: "memory" });
		} catch {
			return { path: resolved, text: "" };
		}
	}

	async appendDaily(entry: string): Promise<MemoryWriteResult> {
		await this.ensureInitialized();
		return appendDailyLog(this.workspaceRoot, entry);
	}

	async upsertLongTerm(entry: string): Promise<MemoryWriteResult> {
		await this.ensureInitialized();
		return upsertMemory(this.workspaceRoot, entry);
	}

	async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchHit[]> {
		const normalized = query.trim().toLowerCase();
		if (!normalized) {
			return [];
		}
		const limit = Math.max(1, options?.limit ?? 5);
		const hits: MemorySearchHit[] = [];

		// Search memory.md
		const memoryResults = await this.searchMemory(normalized, limit - hits.length);
		hits.push(...memoryResults);

		// Search daily logs
		const dailyResults = await searchDailyLogs(this.workspaceRoot, normalized, limit - hits.length);
		for (const r of dailyResults) {
			if (hits.length >= limit) break;
			hits.push({
				path: r.path,
				snippet: r.text,
			});
		}

		// Search bank pages
		if (hits.length < limit) {
			const bankResults = await searchBank(this.workspaceRoot, normalized, limit - hits.length);
			for (const r of bankResults) {
				if (hits.length >= limit) break;
				hits.push({
					path: r.path,
					snippet: r.text,
				});
			}
		}

		return hits;
	}

	private async searchMemory(query: string, limit: number): Promise<MemorySearchHit[]> {
		const hits: MemorySearchHit[] = [];
		const doc = await readMemory(this.workspaceRoot);

		if (!doc.text) return hits;

		const lines = doc.text.split(/\r?\n/);
		for (const line of lines) {
			if (hits.length >= limit) break;

			const trimmed = line.trim();
			if (!trimmed) continue;
			if (trimmed.toLowerCase().includes(query)) {
				hits.push({
					path: doc.path,
					snippet: trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed,
				});
			}
		}

		return hits;
	}

	/**
	 * @deprecated BuiltinMemoryBackend searches directly without index.
	 * Use FTS5Indexer for indexed search operations.
	 */
	async reindex(): Promise<ReindexResult> {
		// BuiltinMemoryBackend searches directly without index
		return { ok: true, reason: "noop - builtin backend searches directly" };
	}
}
