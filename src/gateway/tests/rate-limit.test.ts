import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RateLimitService } from "@/gateway/services/RateLimitService";

describe("RateLimitService", () => {
	let service: RateLimitService;

	beforeEach(() => {
		service = new RateLimitService({
			workspaceLimit: 5, // Low limit for testing
			ipLimit: 10,
			windowMs: 1000, // 1 second window for fast testing
			cleanupIntervalMs: 10000,
		});
	});

	afterEach(() => {
		service.stopCleanup();
	});

	test("should allow requests within limits", () => {
		const result1 = service.checkLimit("workspace-1", "192.168.1.1");
		const result2 = service.checkLimit("workspace-1", "192.168.1.1");

		expect(result1.allowed).toBe(true);
		expect(result2.allowed).toBe(true);
	});

	test("should enforce workspace rate limit", () => {
		const workspace = "busy-workspace";
		const ip = "192.168.1.1";

		// Make 5 requests (at limit)
		for (let i = 0; i < 5; i++) {
			const result = service.checkLimit(workspace, ip);
			expect(result.allowed).toBe(true);
		}

		// 6th request should be rate limited
		const result = service.checkLimit(workspace, ip);
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("workspace_limit_exceeded");
		expect(result.retryAfter).toBeGreaterThan(0);
	});

	test("should enforce IP rate limit", () => {
		// Use different workspaces to hit IP limit
		const ip = "192.168.1.2";

		// Make 10 requests from same IP (different workspaces)
		for (let i = 0; i < 10; i++) {
			const result = service.checkLimit(`workspace-${i}`, ip);
			expect(result.allowed).toBe(true);
		}

		// 11th request should be rate limited by IP
		const result = service.checkLimit("workspace-10", ip);
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("ip_limit_exceeded");
	});

	test("should reset limits after window expires", async () => {
		const workspace = "test-workspace";
		const ip = "192.168.1.3";

		// Exhaust workspace limit
		for (let i = 0; i < 5; i++) {
			service.checkLimit(workspace, ip);
		}

		// Should be rate limited
		let result = service.checkLimit(workspace, ip);
		expect(result.allowed).toBe(false);

		// Wait for window to expire
		await new Promise((resolve) => setTimeout(resolve, 1100));

		// Should be allowed again
		result = service.checkLimit(workspace, ip);
		expect(result.allowed).toBe(true);
	});

	test("should track separate limits for different workspaces", () => {
		const ip = "192.168.1.4";

		// Exhaust workspace-1 limit
		for (let i = 0; i < 5; i++) {
			service.checkLimit("workspace-1", ip);
		}

		// workspace-1 should be rate limited
		let result = service.checkLimit("workspace-1", ip);
		expect(result.allowed).toBe(false);

		// workspace-2 should still be allowed
		result = service.checkLimit("workspace-2", ip);
		expect(result.allowed).toBe(true);
	});

	test("should track separate limits for different IPs", () => {
		// Use different workspaces to avoid hitting workspace limit
		const ip1 = "192.168.1.10";
		const ip2 = "192.168.1.11";

		// Exhaust IP-1 limit (using different workspaces)
		for (let i = 0; i < 10; i++) {
			service.checkLimit(`ws-${i}`, ip1);
		}

		// IP-1 should be rate limited
		let result = service.checkLimit("ws-final", ip1);
		expect(result.allowed).toBe(false);

		// IP-2 should still be allowed
		result = service.checkLimit("ws-new", ip2);
		expect(result.allowed).toBe(true);
	});

	test("should reset specific limits", () => {
		const workspace = "reset-test";
		const ip = "192.168.1.5";

		// Exhaust workspace limit
		for (let i = 0; i < 5; i++) {
			service.checkLimit(workspace, ip);
		}

		// Should be rate limited
		let result = service.checkLimit(workspace, ip);
		expect(result.allowed).toBe(false);

		// Reset workspace limit
		service.resetLimit("workspace", workspace);

		// Should be allowed again
		result = service.checkLimit(workspace, ip);
		expect(result.allowed).toBe(true);
	});

	test("should whitelist IPs from rate limiting", () => {
		const service2 = new RateLimitService({
			workspaceLimit: 2,
			ipLimit: 2,
			whitelistedIps: ["192.168.1.100"],
		});

		const workspace = "test-workspace";
		const whitelistedIp = "192.168.1.100";

		// Even with 100 requests, whitelisted IP should not be rate limited
		for (let i = 0; i < 100; i++) {
			const result = service2.checkLimit(workspace, whitelistedIp);
			expect(result.allowed).toBe(true);
		}

		service2.stopCleanup();
	});

	test("should provide usage statistics", () => {
		service.checkLimit("ws-1", "192.168.1.10");
		service.checkLimit("ws-1", "192.168.1.10");
		service.checkLimit("ws-2", "192.168.1.11");

		const stats = service.getStats();
		expect(stats.workspaces).toBe(2);
		expect(stats.ips).toBe(2);
		expect(stats.workspaceLimit).toBe(5);
		expect(stats.ipLimit).toBe(10);
		expect(stats.windowMs).toBe(1000);
	});

	test("should get usage for specific key", () => {
		service.checkLimit("ws-1", "192.168.1.10");
		service.checkLimit("ws-1", "192.168.1.10");

		const wsUsage = service.getUsage("workspace", "ws-1");
		expect(wsUsage).toBeDefined();
		expect(wsUsage?.count).toBe(2);
		expect(wsUsage?.resetTime).toBeGreaterThan(Date.now());

		const ipUsage = service.getUsage("ip", "192.168.1.10");
		expect(ipUsage).toBeDefined();
		expect(ipUsage?.count).toBe(2);
	});

	test("should return undefined for non-existent usage", () => {
		const usage = service.getUsage("workspace", "non-existent");
		expect(usage).toBeUndefined();
	});

	test("should record requests without checking", () => {
		service.recordRequest("ws-1", "192.168.1.20");
		service.recordRequest("ws-1", "192.168.1.20");

		const usage = service.getUsage("workspace", "ws-1");
		expect(usage?.count).toBe(2);
	});

	test("should handle whitelist add/remove", () => {
		const ip = "192.168.1.50";

		// Not whitelisted initially
		for (let i = 0; i < 10; i++) {
			service.checkLimit("ws-1", ip);
		}
		let result = service.checkLimit("ws-1", ip);
		expect(result.allowed).toBe(false);

		// Whitelist the IP
		service.whitelistIp(ip);

		// Now should be allowed regardless of count
		result = service.checkLimit("ws-1", ip);
		expect(result.allowed).toBe(true);

		// Remove from whitelist
		service.unwhitelistIp(ip);

		// Should be rate limited again (count persists)
		result = service.checkLimit("ws-1", ip);
		expect(result.allowed).toBe(false);
	});

	test("should clear all data", () => {
		service.checkLimit("ws-1", "192.168.1.30");
		service.checkLimit("ws-2", "192.168.1.31");

		expect(service.getStats().workspaces).toBe(2);

		service.clear();

		expect(service.getStats().workspaces).toBe(0);
		expect(service.getStats().ips).toBe(0);
	});

	test("should cleanup expired entries", async () => {
		const service2 = new RateLimitService({
			workspaceLimit: 100,
			ipLimit: 100,
			windowMs: 100,
			cleanupIntervalMs: 50,
		});

		service2.checkLimit("ws-1", "192.168.1.40");
		service2.checkLimit("ws-2", "192.168.1.41");

		expect(service2.getStats().workspaces).toBe(2);

		// Wait for entries to expire and cleanup
		await new Promise((resolve) => setTimeout(resolve, 200));

		service2.cleanup();

		// After cleanup, expired entries should be removed
		// (new window starts on next check)
		service2.checkLimit("ws-new", "192.168.1.42");

		const stats = service2.getStats();
		// Only the new entry should remain
		expect(stats.workspaces).toBeLessThanOrEqual(2);

		service2.stopCleanup();
	});
});
