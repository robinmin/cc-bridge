export async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const limit = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 1;
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const idx = nextIndex;
			nextIndex += 1;
			if (idx >= items.length) return;
			results[idx] = await worker(items[idx], idx);
		}
	});

	await Promise.all(runners);
	return results;
}

