import { expect, test, describe, beforeEach } from "bun:test";
import { UpdateTracker } from "@/gateway/tracker";
import { RateLimiter } from "@/gateway/rate-limiter";

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
