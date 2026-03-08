/**
 * Tests for Context Management Strategy
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
	type ContextManagementConfig,
	type ContextTrigger,
	createContextStrategy,
	DEFAULT_CONTEXT_MANAGEMENT_CONFIG,
	HybridStrategy,
	IdleTimeoutStrategy,
	ManualStrategy,
	type SessionMetadata,
	SessionMetadataTracker,
	SizeLimitStrategy,
	TurnLimitStrategy,
} from "@/gateway/engine/context-strategy";

// Helper to create test metadata
function createTestMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
	const now = new Date().toISOString();
	return {
		turnCount: 0,
		lastActivityAt: now,
		lastResetAt: now,
		createdAt: now,
		estimatedContextSize: 0,
		sessionName: "test-session",
		containerId: "test-container",
		...overrides,
	};
}

// =============================================================================
// SessionMetadataTracker Tests
// =============================================================================

describe("SessionMetadataTracker", () => {
	let tracker: SessionMetadataTracker;

	beforeEach(() => {
		tracker = new SessionMetadataTracker();
	});

	test("getOrCreate creates new metadata for new session", () => {
		const meta = tracker.getOrCreate("session-1", "container-1");

		expect(meta.sessionName).toBe("session-1");
		expect(meta.containerId).toBe("container-1");
		expect(meta.turnCount).toBe(0);
		expect(meta.estimatedContextSize).toBe(0);
		expect(meta.createdAt).toBeDefined();
		expect(meta.lastActivityAt).toBeDefined();
		expect(meta.lastResetAt).toBeDefined();
	});

	test("getOrCreate returns existing metadata for known session", () => {
		const meta1 = tracker.getOrCreate("session-1", "container-1");
		meta1.turnCount = 5;

		const meta2 = tracker.getOrCreate("session-1", "container-1");

		expect(meta2.turnCount).toBe(5);
		expect(meta2).toBe(meta1);
	});

	test("get returns undefined for unknown session", () => {
		const meta = tracker.get("unknown-session");
		expect(meta).toBeUndefined();
	});

	test("get returns metadata for known session", () => {
		tracker.getOrCreate("session-1", "container-1");
		const meta = tracker.get("session-1");

		expect(meta).toBeDefined();
		expect(meta?.sessionName).toBe("session-1");
	});

	test("incrementTurnCount increments turn count and updates size", () => {
		const meta = tracker.incrementTurnCount("session-1", "container-1", 100);

		expect(meta.turnCount).toBe(1);
		expect(meta.estimatedContextSize).toBe(25); // 100 / 4 = 25 tokens

		// Increment again
		const meta2 = tracker.incrementTurnCount("session-1", "container-1", 200);
		expect(meta2.turnCount).toBe(2);
		expect(meta2.estimatedContextSize).toBe(75); // 25 + 200/4 = 75
	});

	test("incrementTurnCount updates lastActivityAt", () => {
		const before = Date.now();
		const meta = tracker.incrementTurnCount("session-1", "container-1", 100);
		const after = Date.now();

		const activityTime = new Date(meta.lastActivityAt).getTime();
		expect(activityTime).toBeGreaterThanOrEqual(before - 10);
		expect(activityTime).toBeLessThanOrEqual(after + 10);
	});

	test("markReset resets turn count and size", () => {
		tracker.incrementTurnCount("session-1", "container-1", 100);
		tracker.incrementTurnCount("session-1", "container-1", 200);

		tracker.markReset("session-1");

		const meta = tracker.get("session-1");
		expect(meta?.turnCount).toBe(0);
		expect(meta?.estimatedContextSize).toBe(0);
	});

	test("markReset updates timestamps", () => {
		tracker.incrementTurnCount("session-1", "container-1", 100);

		const before = Date.now();
		tracker.markReset("session-1");
		const after = Date.now();

		const meta = tracker.get("session-1");
		const resetTime = new Date(meta?.lastResetAt || "").getTime();
		expect(resetTime).toBeGreaterThanOrEqual(before - 10);
		expect(resetTime).toBeLessThanOrEqual(after + 10);
	});

	test("markReset does nothing for unknown session", () => {
		// Should not throw
		tracker.markReset("unknown-session");
		expect(tracker.size).toBe(0);
	});

	test("remove deletes session metadata", () => {
		tracker.getOrCreate("session-1", "container-1");

		const result = tracker.remove("session-1");

		expect(result).toBe(true);
		expect(tracker.get("session-1")).toBeUndefined();
	});

	test("remove returns false for unknown session", () => {
		const result = tracker.remove("unknown-session");
		expect(result).toBe(false);
	});

	test("getAll returns all sessions", () => {
		tracker.getOrCreate("session-1", "container-1");
		tracker.getOrCreate("session-2", "container-1");

		const all = tracker.getAll();

		expect(all.length).toBe(2);
		expect(all.map((m) => m.sessionName)).toContain("session-1");
		expect(all.map((m) => m.sessionName)).toContain("session-2");
	});

	test("size returns correct count", () => {
		expect(tracker.size).toBe(0);

		tracker.getOrCreate("session-1", "container-1");
		expect(tracker.size).toBe(1);

		tracker.getOrCreate("session-2", "container-1");
		expect(tracker.size).toBe(2);

		tracker.remove("session-1");
		expect(tracker.size).toBe(1);
	});
});

// =============================================================================
// ManualStrategy Tests
// =============================================================================

describe("ManualStrategy", () => {
	let strategy: ManualStrategy;

	beforeEach(() => {
		strategy = new ManualStrategy();
	});

	test("name is 'manual'", () => {
		expect(strategy.name).toBe("manual");
	});

	test("shouldReset always returns false", () => {
		const meta = createTestMetadata({ turnCount: 1000 });
		expect(strategy.shouldReset(meta)).toBe(false);
	});

	test("getReason returns expected message", () => {
		strategy.shouldReset(createTestMetadata());
		expect(strategy.getReason()).toBe("manual strategy - no auto-reset");
	});
});

// =============================================================================
// TurnLimitStrategy Tests
// =============================================================================

describe("TurnLimitStrategy", () => {
	test("name is 'turnLimit'", () => {
		const strategy = new TurnLimitStrategy(10);
		expect(strategy.name).toBe("turnLimit");
	});

	test("default limit is 50", () => {
		const strategy = new TurnLimitStrategy();
		const meta = createTestMetadata({ turnCount: 49 });
		expect(strategy.shouldReset(meta)).toBe(false);

		const meta2 = createTestMetadata({ turnCount: 50 });
		expect(strategy.shouldReset(meta2)).toBe(true);
	});

	test("shouldReset returns false when turn count below limit", () => {
		const strategy = new TurnLimitStrategy(10);
		const meta = createTestMetadata({ turnCount: 9 });

		expect(strategy.shouldReset(meta)).toBe(false);
		expect(strategy.getReason()).toBe("");
	});

	test("shouldReset returns true when turn count at limit", () => {
		const strategy = new TurnLimitStrategy(10);
		const meta = createTestMetadata({ turnCount: 10 });

		expect(strategy.shouldReset(meta)).toBe(true);
		expect(strategy.getReason()).toBe("turn count (10 reached)");
	});

	test("shouldReset returns true when turn count exceeds limit", () => {
		const strategy = new TurnLimitStrategy(10);
		const meta = createTestMetadata({ turnCount: 15 });

		expect(strategy.shouldReset(meta)).toBe(true);
	});

	test("custom limit value", () => {
		const strategy = new TurnLimitStrategy(100);
		const meta = createTestMetadata({ turnCount: 100 });

		expect(strategy.shouldReset(meta)).toBe(true);
		expect(strategy.getReason()).toBe("turn count (100 reached)");
	});
});

// =============================================================================
// IdleTimeoutStrategy Tests
// =============================================================================

describe("IdleTimeoutStrategy", () => {
	test("name is 'idleTimeout'", () => {
		const strategy = new IdleTimeoutStrategy(60);
		expect(strategy.name).toBe("idleTimeout");
	});

	test("default timeout is 1800 seconds (30 min)", () => {
		const strategy = new IdleTimeoutStrategy();
		const recent = createTestMetadata({
			lastActivityAt: new Date().toISOString(),
		});
		expect(strategy.shouldReset(recent)).toBe(false);
	});

	test("shouldReset returns false for recent activity", () => {
		const strategy = new IdleTimeoutStrategy(60); // 60 seconds
		const meta = createTestMetadata({
			lastActivityAt: new Date().toISOString(),
		});

		expect(strategy.shouldReset(meta)).toBe(false);
		expect(strategy.getReason()).toBe("");
	});

	test("shouldReset returns true for old activity", () => {
		const strategy = new IdleTimeoutStrategy(1); // 1 second
		const oldTime = new Date(Date.now() - 2000).toISOString(); // 2 seconds ago
		const meta = createTestMetadata({
			lastActivityAt: oldTime,
		});

		expect(strategy.shouldReset(meta)).toBe(true);
		expect(strategy.getReason()).toBe("idle timeout (1s exceeded)");
	});

	test("shouldReset returns false when just under timeout", () => {
		const strategy = new IdleTimeoutStrategy(10); // 10 seconds
		const justUnder = new Date(Date.now() - 9000).toISOString(); // 9 seconds ago
		const meta = createTestMetadata({
			lastActivityAt: justUnder,
		});

		expect(strategy.shouldReset(meta)).toBe(false);
	});
});

// =============================================================================
// SizeLimitStrategy Tests
// =============================================================================

describe("SizeLimitStrategy", () => {
	test("name is 'sizeLimit'", () => {
		const strategy = new SizeLimitStrategy(1000);
		expect(strategy.name).toBe("sizeLimit");
	});

	test("default max tokens is 100000", () => {
		const strategy = new SizeLimitStrategy();
		const meta = createTestMetadata({ estimatedContextSize: 99999 });
		expect(strategy.shouldReset(meta)).toBe(false);

		const meta2 = createTestMetadata({ estimatedContextSize: 100000 });
		expect(strategy.shouldReset(meta2)).toBe(true);
	});

	test("shouldReset returns false when size below limit", () => {
		const strategy = new SizeLimitStrategy(1000);
		const meta = createTestMetadata({ estimatedContextSize: 999 });

		expect(strategy.shouldReset(meta)).toBe(false);
		expect(strategy.getReason()).toBe("");
	});

	test("shouldReset returns true when size at limit", () => {
		const strategy = new SizeLimitStrategy(1000);
		const meta = createTestMetadata({ estimatedContextSize: 1000 });

		expect(strategy.shouldReset(meta)).toBe(true);
		expect(strategy.getReason()).toBe("size limit (1000 tokens exceeded)");
	});

	test("shouldReset returns true when size exceeds limit", () => {
		const strategy = new SizeLimitStrategy(1000);
		const meta = createTestMetadata({ estimatedContextSize: 2000 });

		expect(strategy.shouldReset(meta)).toBe(true);
	});
});

// =============================================================================
// HybridStrategy Tests
// =============================================================================

describe("HybridStrategy", () => {
	test("name is 'hybrid'", () => {
		const strategy = new HybridStrategy([]);
		expect(strategy.name).toBe("hybrid");
	});

	test("empty triggers never reset", () => {
		const strategy = new HybridStrategy([]);
		const meta = createTestMetadata({ turnCount: 1000 });

		expect(strategy.shouldReset(meta)).toBe(false);
		expect(strategy.getReason()).toBe("");
	});

	test("single turnLimit trigger works", () => {
		const triggers: ContextTrigger[] = [{ type: "turnLimit", value: 10, action: "soft" }];
		const strategy = new HybridStrategy(triggers);

		const meta1 = createTestMetadata({ turnCount: 9 });
		expect(strategy.shouldReset(meta1)).toBe(false);

		const meta2 = createTestMetadata({ turnCount: 10 });
		expect(strategy.shouldReset(meta2)).toBe(true);
		expect(strategy.getReason()).toBe("turn count (10 reached)");
	});

	test("single idleTimeout trigger works", () => {
		const triggers: ContextTrigger[] = [{ type: "idleTimeout", value: 1, action: "hard" }];
		const strategy = new HybridStrategy(triggers);

		const oldTime = new Date(Date.now() - 2000).toISOString();
		const meta = createTestMetadata({ lastActivityAt: oldTime });

		expect(strategy.shouldReset(meta)).toBe(true);
		expect(strategy.getReason()).toBe("idle timeout (1s exceeded)");
	});

	test("single sizeLimit trigger works", () => {
		const triggers: ContextTrigger[] = [{ type: "sizeLimit", value: 1000, action: "soft" }];
		const strategy = new HybridStrategy(triggers);

		const meta = createTestMetadata({ estimatedContextSize: 1000 });
		expect(strategy.shouldReset(meta)).toBe(true);
		expect(strategy.getReason()).toBe("size limit (1000 tokens exceeded)");
	});

	test("multiple triggers - first triggered wins", () => {
		const triggers: ContextTrigger[] = [
			{ type: "turnLimit", value: 10, action: "soft" },
			{ type: "sizeLimit", value: 1000, action: "soft" },
		];
		const strategy = new HybridStrategy(triggers);

		// Turn limit triggered first
		const meta = createTestMetadata({ turnCount: 10, estimatedContextSize: 500 });
		expect(strategy.shouldReset(meta)).toBe(true);
		expect(strategy.getReason()).toBe("turn count (10 reached)");
	});

	test("multiple triggers - second triggered when first not", () => {
		const triggers: ContextTrigger[] = [
			{ type: "turnLimit", value: 100, action: "soft" },
			{ type: "sizeLimit", value: 1000, action: "hard" },
		];
		const strategy = new HybridStrategy(triggers);

		// Size limit triggered, turn limit not
		const meta = createTestMetadata({ turnCount: 5, estimatedContextSize: 1500 });
		expect(strategy.shouldReset(meta)).toBe(true);
		expect(strategy.getReason()).toBe("size limit (1000 tokens exceeded)");
	});

	test("unknown trigger type uses manual strategy (never resets)", () => {
		const triggers: ContextTrigger[] = [{ type: "unknown" as "turnLimit", value: 1, action: "soft" }];
		const strategy = new HybridStrategy(triggers);

		const meta = createTestMetadata({ turnCount: 1000 });
		expect(strategy.shouldReset(meta)).toBe(false);
	});

	test("mixed known and unknown triggers", () => {
		const triggers: ContextTrigger[] = [
			{ type: "unknown" as "turnLimit", value: 1, action: "soft" },
			{ type: "turnLimit", value: 10, action: "soft" },
		];
		const strategy = new HybridStrategy(triggers);

		const meta = createTestMetadata({ turnCount: 10 });
		expect(strategy.shouldReset(meta)).toBe(true);
	});
});

// =============================================================================
// createContextStrategy Factory Tests
// =============================================================================

describe("createContextStrategy", () => {
	test("creates ManualStrategy for 'manual'", () => {
		const config: ContextManagementConfig = { strategy: "manual" };
		const strategy = createContextStrategy(config);

		expect(strategy.name).toBe("manual");
		expect(strategy).toBeInstanceOf(ManualStrategy);
	});

	test("creates TurnLimitStrategy for 'turnLimit'", () => {
		const config: ContextManagementConfig = {
			strategy: "turnLimit",
			triggers: [{ type: "turnLimit", value: 25, action: "soft" }],
		};
		const strategy = createContextStrategy(config);

		expect(strategy.name).toBe("turnLimit");
		expect(strategy).toBeInstanceOf(TurnLimitStrategy);
	});

	test("creates TurnLimitStrategy with default value when no triggers", () => {
		const config: ContextManagementConfig = { strategy: "turnLimit" };
		const strategy = createContextStrategy(config);

		const meta = createTestMetadata({ turnCount: 50 });
		expect(strategy.shouldReset(meta)).toBe(true);
	});

	test("creates IdleTimeoutStrategy for 'idleTimeout'", () => {
		const config: ContextManagementConfig = {
			strategy: "idleTimeout",
			triggers: [{ type: "idleTimeout", value: 60, action: "hard" }],
		};
		const strategy = createContextStrategy(config);

		expect(strategy.name).toBe("idleTimeout");
		expect(strategy).toBeInstanceOf(IdleTimeoutStrategy);
	});

	test("creates IdleTimeoutStrategy with default value when no triggers", () => {
		const config: ContextManagementConfig = { strategy: "idleTimeout" };
		const strategy = createContextStrategy(config);

		expect(strategy.name).toBe("idleTimeout");
	});

	test("creates SizeLimitStrategy for 'sizeLimit'", () => {
		const config: ContextManagementConfig = {
			strategy: "sizeLimit",
			triggers: [{ type: "sizeLimit", value: 50000, action: "soft" }],
		};
		const strategy = createContextStrategy(config);

		expect(strategy.name).toBe("sizeLimit");
		expect(strategy).toBeInstanceOf(SizeLimitStrategy);
	});

	test("creates SizeLimitStrategy with default value when no triggers", () => {
		const config: ContextManagementConfig = { strategy: "sizeLimit" };
		const strategy = createContextStrategy(config);

		const meta = createTestMetadata({ estimatedContextSize: 100000 });
		expect(strategy.shouldReset(meta)).toBe(true);
	});

	test("creates HybridStrategy for 'hybrid'", () => {
		const config: ContextManagementConfig = {
			strategy: "hybrid",
			triggers: [
				{ type: "turnLimit", value: 50, action: "soft" },
				{ type: "sizeLimit", value: 100000, action: "soft" },
			],
		};
		const strategy = createContextStrategy(config);

		expect(strategy.name).toBe("hybrid");
		expect(strategy).toBeInstanceOf(HybridStrategy);
	});

	test("creates HybridStrategy with empty triggers when not specified", () => {
		const config: ContextManagementConfig = { strategy: "hybrid" };
		const strategy = createContextStrategy(config);

		expect(strategy.name).toBe("hybrid");
		expect(strategy.shouldReset(createTestMetadata())).toBe(false);
	});

	test("creates ManualStrategy for unknown strategy", () => {
		const config: ContextManagementConfig = { strategy: "unknown-strategy" };
		const strategy = createContextStrategy(config);

		expect(strategy.name).toBe("manual");
		expect(strategy).toBeInstanceOf(ManualStrategy);
	});
});

// =============================================================================
// Default Configuration Tests
// =============================================================================

describe("DEFAULT_CONTEXT_MANAGEMENT_CONFIG", () => {
	test("strategy is 'manual'", () => {
		expect(DEFAULT_CONTEXT_MANAGEMENT_CONFIG.strategy).toBe("manual");
	});

	test("triggers is undefined", () => {
		expect(DEFAULT_CONTEXT_MANAGEMENT_CONFIG.triggers).toBeUndefined();
	});

	test("workspaces is undefined", () => {
		expect(DEFAULT_CONTEXT_MANAGEMENT_CONFIG.workspaces).toBeUndefined();
	});
});

// =============================================================================
// Integration Tests
// =============================================================================

describe("Integration: Tracker + Strategy", () => {
	test("tracker with TurnLimitStrategy integration", () => {
		const tracker = new SessionMetadataTracker();
		const strategy = new TurnLimitStrategy(3);

		// Simulate 3 turns
		for (let i = 0; i < 3; i++) {
			const meta = tracker.incrementTurnCount("session-1", "container-1", 100);
			expect(strategy.shouldReset(meta)).toBe(i === 2);
		}

		// After reset, should not trigger
		tracker.markReset("session-1");
		const meta = tracker.get("session-1");
		if (meta) {
			expect(strategy.shouldReset(meta)).toBe(false);
		}
	});

	test("tracker with HybridStrategy integration", () => {
		const tracker = new SessionMetadataTracker();
		const triggers: ContextTrigger[] = [
			{ type: "turnLimit", value: 5, action: "soft" },
			{ type: "sizeLimit", value: 100, action: "hard" },
		];
		const strategy = new HybridStrategy(triggers);

		// Turn limit should trigger first
		for (let i = 0; i < 5; i++) {
			const meta = tracker.incrementTurnCount("session-1", "container-1", 10);
			if (i < 4) {
				expect(strategy.shouldReset(meta)).toBe(false);
			} else {
				expect(strategy.shouldReset(meta)).toBe(true);
				expect(strategy.getReason()).toContain("turn count");
			}
		}
	});
});
