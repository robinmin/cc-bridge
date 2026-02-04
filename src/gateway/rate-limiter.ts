export class RateLimiter {
    private requests: Map<string | number, number[]> = new Map();
    private limit: number;
    private windowMs: number;

    constructor(limit = 10, windowSeconds = 60) {
        this.limit = limit;
        this.windowMs = windowSeconds * 1000;
    }

    async isAllowed(id: string | number): Promise<boolean> {
        const now = Date.now();
        const timestamps = this.requests.get(id) || [];

        // Filter out old timestamps
        const recent = timestamps.filter(ts => now - ts < this.windowMs);

        if (recent.length >= this.limit) {
            return false;
        }

        recent.push(now);
        this.requests.set(id, recent);
        return true;
    }

    async getRetryAfter(id: string | number): Promise<number> {
        const now = Date.now();
        const timestamps = this.requests.get(id) || [];
        if (timestamps.length === 0) return 0;

        const oldest = timestamps[0];
        return Math.ceil((this.windowMs - (now - oldest)) / 1000);
    }
}

export const rateLimiter = new RateLimiter();
