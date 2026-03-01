import type {
	MemoryBackend,
	MemoryDocument,
	MemorySearchHit,
	MemorySearchOptions,
	MemoryStatus,
	MemoryWriteResult,
	ReindexResult,
} from "@/gateway/memory/contracts";

const DISABLED_REASON = "memory backend disabled";

export class NoneMemoryBackend implements MemoryBackend {
	status(): MemoryStatus {
		return {
			slot: "none",
			available: false,
			reason: DISABLED_REASON,
		};
	}

	async get(pathOrRef: string): Promise<MemoryDocument> {
		return { path: pathOrRef, text: "" };
	}

	async appendDaily(_entry: string): Promise<MemoryWriteResult> {
		return { ok: false, reason: DISABLED_REASON };
	}

	async upsertLongTerm(_entry: string): Promise<MemoryWriteResult> {
		return { ok: false, reason: DISABLED_REASON };
	}

	async search(_query: string, _options?: MemorySearchOptions): Promise<MemorySearchHit[]> {
		return [];
	}

	async reindex(): Promise<ReindexResult> {
		return { ok: true, reason: DISABLED_REASON };
	}
}
