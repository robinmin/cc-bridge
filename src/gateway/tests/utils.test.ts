import { beforeEach, describe, expect, test } from "bun:test";
import { RateLimiter } from "@/gateway/rate-limiter";
import { UpdateTracker } from "@/gateway/tracker";

describe("UpdateTracker", () => {
	let tracker: UpdateTracker;

	beforeEach(() => {
		tracker = new UpdateTracker();
	});

	test("should track processed updates", async () => {
		expect(await tracker.isProcessed(123)).toBe(false);
		expect(await tracker.isProcessed(123)).toBe(true);
		expect(await tracker.isProcessed(456)).toBe(false);
	});

	test("should cleanup expired entries when map exceeds maxEntries", async () => {
		const t = tracker as unknown as {
			processed: Map<string | number, number>;
			maxEntries: number;
			ttlMs: number;
		};
		t.maxEntries = 1;
		t.ttlMs = 1;
		t.processed.set("old", Date.now() - 1000);
		t.processed.set("keep", Date.now());

		await tracker.isProcessed("new");
		expect(t.processed.has("old")).toBe(false);
	});
});

describe("RateLimiter", () => {
	let limiter: RateLimiter;

	beforeEach(() => {
		limiter = new RateLimiter(2, 60); // 2 requests per minute
	});

	test("should allow within limit", async () => {
		expect(await limiter.isAllowed("user1")).toBe(true);
		expect(await limiter.isAllowed("user1")).toBe(true);
		expect(await limiter.isAllowed("user1")).toBe(false);
	});

	test("should track users independently", async () => {
		expect(await limiter.isAllowed("user1")).toBe(true);
		expect(await limiter.isAllowed("user2")).toBe(true);
		expect(await limiter.isAllowed("user1")).toBe(true);
		expect(await limiter.isAllowed("user1")).toBe(false);
		expect(await limiter.isAllowed("user2")).toBe(true);
	});
});
