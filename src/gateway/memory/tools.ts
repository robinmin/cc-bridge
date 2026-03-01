import type { MemoryBackend } from "@/gateway/memory/contracts";

export async function memoryGet(backend: MemoryBackend, pathOrRef: string): Promise<{ path: string; text: string }> {
	return backend.get(pathOrRef);
}

export async function memorySearch(
	backend: MemoryBackend,
	query: string,
	limit = 5,
): Promise<Array<{ path: string; snippet: string; score?: number }>> {
	return backend.search(query, { limit });
}
