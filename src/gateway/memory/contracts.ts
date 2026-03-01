export type MemorySlot = "builtin" | "none" | "external";

export type MemoryCitationMode = "auto" | "on" | "off";

export interface MemoryConfig {
	slot: MemorySlot;
	citations: MemoryCitationMode;
	loadPolicy: {
		groupLoadLongTerm: boolean;
	};
	flush: {
		enabled: boolean;
		softThresholdTokens: number;
	};
	builtin: {
		index: {
			enabled: boolean;
		};
	};
	external?: {
		provider?: string;
	};
}

export interface MemoryStatus {
	slot: MemorySlot;
	available: boolean;
	reason?: string;
}

export interface MemoryDocument {
	path: string;
	text: string;
}

export interface MemoryWriteResult {
	ok: boolean;
	path?: string;
	reason?: string;
}

export interface MemorySearchHit {
	path: string;
	snippet: string;
	score?: number;
}

export interface MemorySearchOptions {
	limit?: number;
}

export interface ReindexResult {
	ok: boolean;
	reason?: string;
}

export interface MemoryBackend {
	status(): MemoryStatus;
	get(pathOrRef: string): Promise<MemoryDocument>;
	appendDaily(entry: string): Promise<MemoryWriteResult>;
	upsertLongTerm(entry: string): Promise<MemoryWriteResult>;
	search(query: string, options?: MemorySearchOptions): Promise<MemorySearchHit[]>;
	reindex(): Promise<ReindexResult>;
}
