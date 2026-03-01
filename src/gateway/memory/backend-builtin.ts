import fs from "node:fs/promises";
import path from "node:path";
import type {
	MemoryBackend,
	MemoryDocument,
	MemorySearchHit,
	MemorySearchOptions,
	MemoryStatus,
	MemoryWriteResult,
	ReindexResult,
} from "@/gateway/memory/contracts";

export class BuiltinMemoryBackend implements MemoryBackend {
	constructor(private readonly workspaceRoot: string) {}

	private resolvePath(pathOrRef: string): string {
		return path.isAbsolute(pathOrRef) ? pathOrRef : path.join(this.workspaceRoot, pathOrRef);
	}

	private getDailyPath(date = new Date()): string {
		const yyyy = String(date.getFullYear());
		const mm = String(date.getMonth() + 1).padStart(2, "0");
		const dd = String(date.getDate()).padStart(2, "0");
		return path.join(this.workspaceRoot, ".memory", "daily", `${yyyy}-${mm}-${dd}.md`);
	}

	private async ensureParentDir(filePath: string): Promise<void> {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
	}

	private appendWithSpacing(existing: string, entry: string): string {
		const trimmedEntry = entry.trim();
		if (!trimmedEntry) {
			return existing;
		}
		if (!existing.trim()) {
			return `${trimmedEntry}\n`;
		}
		return `${existing.trimEnd()}\n\n${trimmedEntry}\n`;
	}

	status(): MemoryStatus {
		return {
			slot: "builtin",
			available: true,
		};
	}

	async get(pathOrRef: string): Promise<MemoryDocument> {
		const resolved = this.resolvePath(pathOrRef);
		try {
			const text = await fs.readFile(resolved, "utf-8");
			return { path: resolved, text };
		} catch {
			// Missing memory files are valid state and should not fail the run.
			return { path: resolved, text: "" };
		}
	}

	async appendDaily(entry: string): Promise<MemoryWriteResult> {
		const filePath = this.getDailyPath();
		try {
			await this.ensureParentDir(filePath);
			const existing = await this.get(filePath);
			const updated = this.appendWithSpacing(existing.text, entry);
			if (updated === existing.text) {
				return { ok: false, reason: "empty entry" };
			}
			await fs.writeFile(filePath, updated, "utf-8");
			return { ok: true, path: filePath };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : "write failed" };
		}
	}

	async upsertLongTerm(entry: string): Promise<MemoryWriteResult> {
		const filePath = path.join(this.workspaceRoot, ".memory", "MEMORY.md");
		try {
			await this.ensureParentDir(filePath);
			const existing = await this.get(filePath);
			const trimmedEntry = entry.trim();
			if (!trimmedEntry) {
				return { ok: false, reason: "empty entry" };
			}
			if (existing.text.includes(trimmedEntry)) {
				return { ok: true, path: filePath };
			}
			const updated = this.appendWithSpacing(existing.text, trimmedEntry);
			await fs.writeFile(filePath, updated, "utf-8");
			return { ok: true, path: filePath };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : "write failed" };
		}
	}

	async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchHit[]> {
		const normalized = query.trim().toLowerCase();
		if (!normalized) {
			return [];
		}
		const limit = Math.max(1, options?.limit ?? 5);
		const hits: MemorySearchHit[] = [];

		const candidatePaths: string[] = [path.join(this.workspaceRoot, ".memory", "MEMORY.md")];
		const memoryDir = path.join(this.workspaceRoot, ".memory", "daily");

		try {
			const entries = await fs.readdir(memoryDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith(".md")) {
					candidatePaths.push(path.join(memoryDir, entry.name));
				}
			}
		} catch {
			// Missing memory directory is a valid state.
		}

		for (const filePath of candidatePaths) {
			if (hits.length >= limit) break;
			const doc = await this.get(filePath);
			if (!doc.text) continue;

			const lines = doc.text.split(/\r?\n/);
			for (const line of lines) {
				if (hits.length >= limit) break;
				const trimmed = line.trim();
				if (!trimmed) continue;
				if (!trimmed.toLowerCase().includes(normalized)) continue;
				hits.push({
					path: filePath,
					snippet: trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed,
				});
			}
		}

		return hits;
	}

	async reindex(): Promise<ReindexResult> {
		return { ok: true, reason: "noop" };
	}
}
