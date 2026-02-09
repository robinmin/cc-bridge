export class UpdateTracker {
	private processed: Map<string | number, number> = new Map();
	private maxEntries = 1000;
	private ttlMs = 10 * 60 * 1000; // 10 minutes

	async isProcessed(updateId: string | number): Promise<boolean> {
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
			return true;
		}

		this.processed.set(updateId, now);
		return false;
	}
}

export const updateTracker = new UpdateTracker();
