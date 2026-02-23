export class UpdateTracker {
	private processed: Map<string | number, number>;
	private maxEntries: number;
	private ttlMs: number;

	constructor() {
		this.processed = new Map();
		this.maxEntries = 1000;
		this.ttlMs = 10 * 60 * 1000; // 10 minutes
	}

	isProcessed(updateId: string | number): Promise<boolean> {
		const now = Date.now();

		// Periodic cleanup
		if (this.processed.size > this.maxEntries) {
			for (const [id, timestamp] of this.processed) {
				if (now - timestamp > this.ttlMs) {
					this.processed.delete(id);
				}
			}
		}

		if (this.processed.has(updateId)) {
			return Promise.resolve(true);
		}

		this.processed.set(updateId, now);
		return Promise.resolve(false);
	}
}

export const updateTracker = new UpdateTracker();
