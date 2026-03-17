/**
 * Tool Sandbox Quota Tests
 *
 * Tests for resource quota enforcement, usage tracking, and preset quotas.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_QUOTA,
	QuotaEnforcer,
	type ResourceQuota,
	STRICT_QUOTA,
	UNLIMITED_QUOTA,
} from "../agent/tools/sandbox/quota";

// =============================================================================
// QuotaEnforcer Tests
// =============================================================================

describe("QuotaEnforcer", () => {
	const testQuota: ResourceQuota = {
		maxMemoryBytes: 1024 * 1024, // 1 MB
		maxCpuPercent: 100,
		maxExecutionMs: 5000,
		maxConcurrentExecs: 2,
	};

	describe("checkQuota", () => {
		it("should report within limits when no usage", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			const status = enforcer.checkQuota();
			expect(status.withinLimits).toBe(true);
			expect(status.violations).toHaveLength(0);
		});

		it("should detect concurrent execution limit violation", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.acquireExecSlot();
			enforcer.acquireExecSlot();

			const status = enforcer.checkQuota();
			expect(status.withinLimits).toBe(false);
			expect(status.violations).toHaveLength(1);
			expect(status.violations[0]).toContain("Concurrent executions");
			expect(status.violations[0]).toContain("2/2");
		});

		it("should detect peak memory violation", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.recordExecution({
				durationMs: 100,
				memoryUsedBytes: 2 * 1024 * 1024, // 2 MB > 1 MB limit
			});

			const status = enforcer.checkQuota();
			expect(status.withinLimits).toBe(false);
			expect(status.violations).toHaveLength(1);
			expect(status.violations[0]).toContain("Peak memory exceeded");
		});

		it("should detect multiple violations simultaneously", () => {
			const enforcer = new QuotaEnforcer(testQuota);

			// Fill concurrent slots
			enforcer.acquireExecSlot();
			enforcer.acquireExecSlot();

			// Exceed memory
			enforcer.recordExecution({
				durationMs: 100,
				memoryUsedBytes: 2 * 1024 * 1024,
			});

			const status = enforcer.checkQuota();
			expect(status.withinLimits).toBe(false);
			expect(status.violations).toHaveLength(2);
		});

		it("should return within limits after releasing slots", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.acquireExecSlot();
			enforcer.acquireExecSlot();

			expect(enforcer.checkQuota().withinLimits).toBe(false);

			enforcer.releaseExecSlot();
			expect(enforcer.checkQuota().withinLimits).toBe(true);
		});
	});

	describe("acquireExecSlot", () => {
		it("should succeed when slots available", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			expect(enforcer.acquireExecSlot()).toBe(true);
		});

		it("should succeed up to the limit", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			expect(enforcer.acquireExecSlot()).toBe(true);
			expect(enforcer.acquireExecSlot()).toBe(true);
		});

		it("should fail when all slots are taken", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.acquireExecSlot();
			enforcer.acquireExecSlot();
			expect(enforcer.acquireExecSlot()).toBe(false);
		});

		it("should succeed again after releasing a slot", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.acquireExecSlot();
			enforcer.acquireExecSlot();
			expect(enforcer.acquireExecSlot()).toBe(false);

			enforcer.releaseExecSlot();
			expect(enforcer.acquireExecSlot()).toBe(true);
		});

		it("should handle single-slot quota", () => {
			const singleSlot: ResourceQuota = { ...testQuota, maxConcurrentExecs: 1 };
			const enforcer = new QuotaEnforcer(singleSlot);

			expect(enforcer.acquireExecSlot()).toBe(true);
			expect(enforcer.acquireExecSlot()).toBe(false);
		});
	});

	describe("releaseExecSlot", () => {
		it("should decrement concurrent count", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.acquireExecSlot();

			const before = enforcer.getUsageSummary().currentConcurrent;
			enforcer.releaseExecSlot();
			const after = enforcer.getUsageSummary().currentConcurrent;

			expect(before).toBe(1);
			expect(after).toBe(0);
		});

		it("should not go below zero", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.releaseExecSlot();
			enforcer.releaseExecSlot();

			expect(enforcer.getUsageSummary().currentConcurrent).toBe(0);
		});
	});

	describe("recordExecution", () => {
		it("should track total executions", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.recordExecution({ durationMs: 100 });
			enforcer.recordExecution({ durationMs: 200 });
			enforcer.recordExecution({ durationMs: 300 });

			expect(enforcer.getUsageSummary().totalExecutions).toBe(3);
		});

		it("should accumulate total duration", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.recordExecution({ durationMs: 100 });
			enforcer.recordExecution({ durationMs: 250 });

			expect(enforcer.getUsageSummary().totalDurationMs).toBe(350);
		});

		it("should track peak memory", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.recordExecution({ durationMs: 50, memoryUsedBytes: 1000 });
			enforcer.recordExecution({ durationMs: 50, memoryUsedBytes: 5000 });
			enforcer.recordExecution({ durationMs: 50, memoryUsedBytes: 2000 });

			expect(enforcer.getUsageSummary().peakMemoryBytes).toBe(5000);
		});

		it("should ignore undefined memory", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.recordExecution({ durationMs: 50, memoryUsedBytes: 1000 });
			enforcer.recordExecution({ durationMs: 50 }); // no memory info

			expect(enforcer.getUsageSummary().peakMemoryBytes).toBe(1000);
		});

		it("should handle zero-duration executions", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.recordExecution({ durationMs: 0 });

			expect(enforcer.getUsageSummary().totalExecutions).toBe(1);
			expect(enforcer.getUsageSummary().totalDurationMs).toBe(0);
		});
	});

	describe("getUsageSummary", () => {
		it("should return initial state for fresh enforcer", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			const summary = enforcer.getUsageSummary();

			expect(summary.totalExecutions).toBe(0);
			expect(summary.totalDurationMs).toBe(0);
			expect(summary.peakMemoryBytes).toBe(0);
			expect(summary.currentConcurrent).toBe(0);
			expect(summary.quota).toBe(testQuota);
		});

		it("should reflect all tracked state", () => {
			const enforcer = new QuotaEnforcer(testQuota);
			enforcer.acquireExecSlot();
			enforcer.recordExecution({ durationMs: 100, memoryUsedBytes: 4096 });
			enforcer.recordExecution({ durationMs: 200, memoryUsedBytes: 8192 });

			const summary = enforcer.getUsageSummary();
			expect(summary.totalExecutions).toBe(2);
			expect(summary.totalDurationMs).toBe(300);
			expect(summary.peakMemoryBytes).toBe(8192);
			expect(summary.currentConcurrent).toBe(1);
			expect(summary.quota).toBe(testQuota);
		});

		it("should return the configured quota reference", () => {
			const enforcer = new QuotaEnforcer(DEFAULT_QUOTA);
			expect(enforcer.getUsageSummary().quota).toBe(DEFAULT_QUOTA);
		});
	});
});

// =============================================================================
// Preset Quota Tests
// =============================================================================

describe("Preset Quotas", () => {
	describe("DEFAULT_QUOTA", () => {
		it("should have 512 MB memory limit", () => {
			expect(DEFAULT_QUOTA.maxMemoryBytes).toBe(512 * 1024 * 1024);
		});

		it("should have 100% CPU limit (1 core)", () => {
			expect(DEFAULT_QUOTA.maxCpuPercent).toBe(100);
		});

		it("should have 60 second execution limit", () => {
			expect(DEFAULT_QUOTA.maxExecutionMs).toBe(60000);
		});

		it("should allow 4 concurrent executions", () => {
			expect(DEFAULT_QUOTA.maxConcurrentExecs).toBe(4);
		});

		it("should have optional disk and network limits set", () => {
			expect(DEFAULT_QUOTA.maxDiskBytes).toBeDefined();
			expect(DEFAULT_QUOTA.maxNetworkBytesOut).toBeDefined();
		});
	});

	describe("STRICT_QUOTA", () => {
		it("should be more restrictive than DEFAULT_QUOTA", () => {
			expect(STRICT_QUOTA.maxMemoryBytes).toBeLessThan(DEFAULT_QUOTA.maxMemoryBytes);
			expect(STRICT_QUOTA.maxCpuPercent).toBeLessThan(DEFAULT_QUOTA.maxCpuPercent);
			expect(STRICT_QUOTA.maxExecutionMs).toBeLessThan(DEFAULT_QUOTA.maxExecutionMs);
			expect(STRICT_QUOTA.maxConcurrentExecs).toBeLessThan(DEFAULT_QUOTA.maxConcurrentExecs);
		});

		it("should have 256 MB memory limit", () => {
			expect(STRICT_QUOTA.maxMemoryBytes).toBe(256 * 1024 * 1024);
		});

		it("should allow 2 concurrent executions", () => {
			expect(STRICT_QUOTA.maxConcurrentExecs).toBe(2);
		});
	});

	describe("UNLIMITED_QUOTA", () => {
		it("should have maximum safe integer for all required limits", () => {
			expect(UNLIMITED_QUOTA.maxMemoryBytes).toBe(Number.MAX_SAFE_INTEGER);
			expect(UNLIMITED_QUOTA.maxCpuPercent).toBe(Number.MAX_SAFE_INTEGER);
			expect(UNLIMITED_QUOTA.maxExecutionMs).toBe(Number.MAX_SAFE_INTEGER);
			expect(UNLIMITED_QUOTA.maxConcurrentExecs).toBe(Number.MAX_SAFE_INTEGER);
		});

		it("should not have optional limits set", () => {
			expect(UNLIMITED_QUOTA.maxDiskBytes).toBeUndefined();
			expect(UNLIMITED_QUOTA.maxNetworkBytesOut).toBeUndefined();
		});

		it("should never block slot acquisition in practice", () => {
			const enforcer = new QuotaEnforcer(UNLIMITED_QUOTA);
			for (let i = 0; i < 1000; i++) {
				expect(enforcer.acquireExecSlot()).toBe(true);
			}
		});
	});
});

// =============================================================================
// Integration-Style Tests
// =============================================================================

describe("QuotaEnforcer integration", () => {
	it("should handle a full acquire-execute-release cycle", () => {
		const enforcer = new QuotaEnforcer(DEFAULT_QUOTA);

		// Acquire
		expect(enforcer.acquireExecSlot()).toBe(true);
		expect(enforcer.getUsageSummary().currentConcurrent).toBe(1);

		// Execute
		enforcer.recordExecution({ durationMs: 150, memoryUsedBytes: 1024 });
		expect(enforcer.getUsageSummary().totalExecutions).toBe(1);

		// Release
		enforcer.releaseExecSlot();
		expect(enforcer.getUsageSummary().currentConcurrent).toBe(0);

		// Quota should be clear
		expect(enforcer.checkQuota().withinLimits).toBe(true);
	});

	it("should handle multiple sequential executions", () => {
		const enforcer = new QuotaEnforcer(DEFAULT_QUOTA);

		for (let i = 0; i < 10; i++) {
			expect(enforcer.acquireExecSlot()).toBe(true);
			enforcer.recordExecution({ durationMs: 100, memoryUsedBytes: 512 });
			enforcer.releaseExecSlot();
		}

		const summary = enforcer.getUsageSummary();
		expect(summary.totalExecutions).toBe(10);
		expect(summary.totalDurationMs).toBe(1000);
		expect(summary.peakMemoryBytes).toBe(512);
		expect(summary.currentConcurrent).toBe(0);
	});

	it("should correctly enforce quota under concurrent pressure", () => {
		const quota: ResourceQuota = {
			maxMemoryBytes: Number.MAX_SAFE_INTEGER,
			maxCpuPercent: 100,
			maxExecutionMs: 60000,
			maxConcurrentExecs: 3,
		};
		const enforcer = new QuotaEnforcer(quota);

		// Fill all slots
		expect(enforcer.acquireExecSlot()).toBe(true);
		expect(enforcer.acquireExecSlot()).toBe(true);
		expect(enforcer.acquireExecSlot()).toBe(true);

		// Should be at limit
		expect(enforcer.checkQuota().withinLimits).toBe(false);
		expect(enforcer.acquireExecSlot()).toBe(false);

		// Release one, should allow one more
		enforcer.releaseExecSlot();
		expect(enforcer.checkQuota().withinLimits).toBe(true);
		expect(enforcer.acquireExecSlot()).toBe(true);

		// At limit again
		expect(enforcer.acquireExecSlot()).toBe(false);
	});
});
