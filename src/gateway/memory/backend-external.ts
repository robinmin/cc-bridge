import type {
	MemoryBackend,
	MemoryDocument,
	MemorySearchHit,
	MemorySearchOptions,
	MemoryStatus,
	MemoryWriteResult,
	ReindexResult,
} from "@/gateway/memory/contracts";
import { BuiltinMemoryBackend } from "@/gateway/memory/backend-builtin";
import { NoneMemoryBackend } from "@/gateway/memory/backend-none";

export interface ExternalMemoryProvider {
	name: string;
	status(): Promise<MemoryStatus>;
	get(pathOrRef: string): Promise<MemoryDocument>;
	appendDaily(entry: string): Promise<MemoryWriteResult>;
	upsertLongTerm(entry: string): Promise<MemoryWriteResult>;
	search(query: string, options?: MemorySearchOptions): Promise<MemorySearchHit[]>;
	reindex(): Promise<ReindexResult>;
}

export class ExternalMemoryBackend implements MemoryBackend {
	private fallback: MemoryBackend;
	private healthy = true;

	constructor(
		private readonly provider: ExternalMemoryProvider,
		fallbackWorkspaceRoot?: string,
	) {
		this.fallback = fallbackWorkspaceRoot
			? new BuiltinMemoryBackend(fallbackWorkspaceRoot)
			: new NoneMemoryBackend();
	}

	status(): MemoryStatus {
		if (!this.healthy) {
			return {
				slot: "external",
				available: false,
				reason: "external provider unhealthy, using fallback",
			};
		}
		return {
			slot: "external",
			available: true,
		};
	}

	private markUnhealthy(): void {
		this.healthy = false;
	}

	async get(pathOrRef: string): Promise<MemoryDocument> {
		if (!this.healthy) {
			return this.fallback.get(pathOrRef);
		}
		try {
			return await this.provider.get(pathOrRef);
		} catch {
			this.markUnhealthy();
			return this.fallback.get(pathOrRef);
		}
	}

	async appendDaily(entry: string): Promise<MemoryWriteResult> {
		if (!this.healthy) {
			return this.fallback.appendDaily(entry);
		}
		try {
			return await this.provider.appendDaily(entry);
		} catch {
			this.markUnhealthy();
			return this.fallback.appendDaily(entry);
		}
	}

	async upsertLongTerm(entry: string): Promise<MemoryWriteResult> {
		if (!this.healthy) {
			return this.fallback.upsertLongTerm(entry);
		}
		try {
			return await this.provider.upsertLongTerm(entry);
		} catch {
			this.markUnhealthy();
			return this.fallback.upsertLongTerm(entry);
		}
	}

	async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchHit[]> {
		if (!this.healthy) {
			return this.fallback.search(query, options);
		}
		try {
			return await this.provider.search(query, options);
		} catch {
			this.markUnhealthy();
			return this.fallback.search(query, options);
		}
	}

	async reindex(): Promise<ReindexResult> {
		if (!this.healthy) {
			return this.fallback.reindex();
		}
		try {
			return await this.provider.reindex();
		} catch {
			this.markUnhealthy();
			return this.fallback.reindex();
		}
	}
}

export class StubExternalProvider implements ExternalMemoryProvider {
	name = "stub";

	async status(): Promise<MemoryStatus> {
		return { slot: "external", available: true };
	}

	async get(pathOrRef: string): Promise<MemoryDocument> {
		return { path: pathOrRef, text: "" };
	}

	async appendDaily(_entry: string): Promise<MemoryWriteResult> {
		return { ok: true, reason: "stub" };
	}

	async upsertLongTerm(_entry: string): Promise<MemoryWriteResult> {
		return { ok: true, reason: "stub" };
	}

	async search(_query: string, _options?: MemorySearchOptions): Promise<MemorySearchHit[]> {
		return [];
	}

	async reindex(): Promise<ReindexResult> {
		return { ok: true, reason: "stub" };
	}
}
