/**
 * Context Management Strategy
 *
 * Provides configurable strategies for managing tmux session context
 * to prevent unbounded growth and stale conversations.
 *
 * Strategies:
 * - manual: No auto-reset (default)
 * - turnLimit: Reset after N turns
 * - idleTimeout: Reset after X minutes of inactivity
 * - sizeLimit: Reset when context exceeds size
 * - hybrid: Combine multiple triggers
 */

import { logger } from "@/packages/logger";

// =============================================================================
// Types and Interfaces
// =============================================================================

/**
 * Session metadata for context management decisions
 */
export interface SessionMetadata {
	/** Number of conversation turns since last reset */
	turnCount: number;
	/** Timestamp of last activity (ISO string) */
	lastActivityAt: string;
	/** Timestamp of last context reset (ISO string) */
	lastResetAt: string;
	/** Session creation time (ISO string) */
	createdAt: string;
	/** Approximate context size in tokens */
	estimatedContextSize: number;
	/** Session identifier */
	sessionName: string;
	/** Container ID (for container sessions) or "host" (for host sessions) */
	containerId: string;
}

/**
 * Reset action types
 */
export type ResetAction = "soft" | "hard" | "notify";

/**
 * Trigger configuration
 */
export interface ContextTrigger {
	type: "turnLimit" | "idleTimeout" | "sizeLimit";
	value: number;
	action: ResetAction;
}

/**
 * Context management strategy interface
 */
export interface IContextStrategy {
	readonly name: string;
	shouldReset(metadata: SessionMetadata): boolean;
	getReason(): string;
}

/**
 * Configuration for context management
 */
export interface ContextManagementConfig {
	/** Global strategy: 'manual' | 'turnLimit' | 'idleTimeout' | 'sizeLimit' | 'hybrid' */
	strategy: string;

	/** For hybrid strategy: list of triggers */
	triggers?: ContextTrigger[];

	/** Per-workspace overrides */
	workspaces?: Record<string, Partial<ContextManagementConfig>>;
}

// =============================================================================
// Session Metadata Tracker
// =============================================================================

/**
 * Tracks session metadata for context management decisions
 */
export class SessionMetadataTracker {
	private metadata: Map<string, SessionMetadata> = new Map();

	/**
	 * Get or create metadata for a session
	 */
	getOrCreate(sessionName: string, containerId: string): SessionMetadata {
		const existing = this.metadata.get(sessionName);
		if (existing) {
			return existing;
		}

		const now = new Date().toISOString();
		const newMetadata: SessionMetadata = {
			turnCount: 0,
			lastActivityAt: now,
			lastResetAt: now,
			createdAt: now,
			estimatedContextSize: 0,
			sessionName,
			containerId,
		};

		this.metadata.set(sessionName, newMetadata);
		return newMetadata;
	}

	/**
	 * Get metadata for a session (returns undefined if not exists)
	 */
	get(sessionName: string): SessionMetadata | undefined {
		return this.metadata.get(sessionName);
	}

	/**
	 * Increment turn count for a session
	 */
	incrementTurnCount(sessionName: string, containerId: string, promptLength: number): SessionMetadata {
		const meta = this.getOrCreate(sessionName, containerId);
		meta.turnCount++;
		meta.lastActivityAt = new Date().toISOString();
		// Rough estimate: 1 token ≈ 4 characters
		meta.estimatedContextSize += Math.ceil(promptLength / 4);
		return meta;
	}

	/**
	 * Mark session as reset
	 */
	markReset(sessionName: string): void {
		const meta = this.metadata.get(sessionName);
		if (meta) {
			meta.turnCount = 0;
			meta.estimatedContextSize = 0;
			meta.lastResetAt = new Date().toISOString();
			meta.lastActivityAt = meta.lastResetAt;
		}
	}

	/**
	 * Remove metadata for a session
	 */
	remove(sessionName: string): boolean {
		return this.metadata.delete(sessionName);
	}

	/**
	 * Get all sessions with metadata
	 */
	getAll(): SessionMetadata[] {
		return Array.from(this.metadata.values());
	}

	/**
	 * Get session count
	 */
	get size(): number {
		return this.metadata.size;
	}
}

// =============================================================================
// Built-in Strategies
// =============================================================================

/**
 * Manual strategy - never auto-reset (default)
 */
export class ManualStrategy implements IContextStrategy {
	readonly name = "manual";

	shouldReset(_metadata: SessionMetadata): boolean {
		return false;
	}

	getReason(): string {
		return "manual strategy - no auto-reset";
	}
}

/**
 * Turn limit strategy - reset after N turns
 */
export class TurnLimitStrategy implements IContextStrategy {
	readonly name = "turnLimit";
	private readonly limit: number;
	private resetNeeded = false;

	constructor(limit: number = 50) {
		this.limit = limit;
	}

	shouldReset(metadata: SessionMetadata): boolean {
		this.resetNeeded = metadata.turnCount >= this.limit;
		return this.resetNeeded;
	}

	getReason(): string {
		return this.resetNeeded ? `turn count (${this.limit} reached)` : "";
	}
}

/**
 * Idle timeout strategy - reset after X seconds of inactivity
 */
export class IdleTimeoutStrategy implements IContextStrategy {
	readonly name = "idleTimeout";
	private readonly timeoutSeconds: number;
	private resetNeeded = false;

	constructor(timeoutSeconds: number = 1800) {
		this.timeoutSeconds = timeoutSeconds;
	}

	shouldReset(metadata: SessionMetadata): boolean {
		const lastActivity = new Date(metadata.lastActivityAt).getTime();
		const now = Date.now();
		const idleSeconds = (now - lastActivity) / 1000;
		this.resetNeeded = idleSeconds >= this.timeoutSeconds;
		return this.resetNeeded;
	}

	getReason(): string {
		return this.resetNeeded ? `idle timeout (${this.timeoutSeconds}s exceeded)` : "";
	}
}

/**
 * Size limit strategy - reset when context exceeds size
 */
export class SizeLimitStrategy implements IContextStrategy {
	readonly name = "sizeLimit";
	private readonly maxTokens: number;
	private resetNeeded = false;

	constructor(maxTokens: number = 100000) {
		this.maxTokens = maxTokens;
	}

	shouldReset(metadata: SessionMetadata): boolean {
		this.resetNeeded = metadata.estimatedContextSize >= this.maxTokens;
		return this.resetNeeded;
	}

	getReason(): string {
		return this.resetNeeded ? `size limit (${this.maxTokens} tokens exceeded)` : "";
	}
}

/**
 * Hybrid strategy - combine multiple triggers
 */
export class HybridStrategy implements IContextStrategy {
	readonly name = "hybrid";
	private readonly triggers: Array<{ strategy: IContextStrategy; action: ResetAction }>;
	private lastTriggerReason = "";

	constructor(triggers: ContextTrigger[]) {
		this.triggers = triggers.map((t) => ({
			strategy: this.createStrategy(t.type, t.value),
			action: t.action,
		}));
	}

	private createStrategy(type: string, value: number): IContextStrategy {
		switch (type) {
			case "turnLimit":
				return new TurnLimitStrategy(value);
			case "idleTimeout":
				return new IdleTimeoutStrategy(value);
			case "sizeLimit":
				return new SizeLimitStrategy(value);
			default:
				logger.warn({ type }, "Unknown strategy type, using manual");
				return new ManualStrategy();
		}
	}

	shouldReset(metadata: SessionMetadata): boolean {
		for (const { strategy } of this.triggers) {
			if (strategy.shouldReset(metadata)) {
				this.lastTriggerReason = strategy.getReason();
				return true;
			}
		}
		return false;
	}

	getReason(): string {
		return this.lastTriggerReason;
	}
}

// =============================================================================
// Strategy Factory
// =============================================================================

/**
 * Create a context strategy from configuration
 */
export function createContextStrategy(config: ContextManagementConfig): IContextStrategy {
	switch (config.strategy) {
		case "manual":
			return new ManualStrategy();
		case "turnLimit":
			return new TurnLimitStrategy(config.triggers?.[0]?.value ?? 50);
		case "idleTimeout":
			return new IdleTimeoutStrategy(config.triggers?.[0]?.value ?? 1800);
		case "sizeLimit":
			return new SizeLimitStrategy(config.triggers?.[0]?.value ?? 100000);
		case "hybrid":
			return new HybridStrategy(config.triggers ?? []);
		default:
			logger.warn({ strategy: config.strategy }, "Unknown strategy, using manual");
			return new ManualStrategy();
	}
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_CONTEXT_MANAGEMENT_CONFIG: ContextManagementConfig = {
	strategy: "manual", // Default: no auto-reset (backward compatible)
};

// Global metadata tracker instance
export const sessionMetadataTracker = new SessionMetadataTracker();
