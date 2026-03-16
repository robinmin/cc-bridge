/**
 * Permission Evaluator
 *
 * Runtime permission evaluation logic for the enhanced tool system.
 * Evaluates permissions at call time considering session state, tier requirements,
 * and context-aware rules.
 */

import { logger } from "@/packages/logger";
import { getDefaultTier, hasTierPermission, PermissionTier } from "./tiers";

/**
 * Context for permission evaluation
 */
export interface PermissionContext {
	sessionId: string;
	userId?: string;
	sessionTier: PermissionTier;
	activeEscalations?: Map<string, PermissionTier>;
	metadata?: Record<string, unknown>;
}

/**
 * Result of permission evaluation
 */
export interface PermissionEvaluationResult {
	allowed: boolean;
	reason?: string;
	requiredTier?: PermissionTier;
	currentTier?: PermissionTier;
	escalationRequired?: boolean;
}

/**
 * Configuration for permission evaluator
 */
export interface EvaluatorConfig {
	/** Default session tier if not specified */
	defaultTier?: PermissionTier;
	/** Allow JIT elevation for tools that support it */
	allowJitElevation?: boolean;
	/** Default escalation timeout in ms */
	defaultEscalationTimeoutMs?: number;
}

/**
 * Session state store (interface for external implementation)
 */
export interface SessionStateStore {
	getSessionTier(sessionId: string): PermissionTier;
	getActiveEscalations(sessionId: string): Map<string, PermissionTier>;
}

/**
 * In-memory session state store (default implementation)
 */
export class InMemorySessionStateStore implements SessionStateStore {
	private sessionTiers: Map<string, PermissionTier> = new Map();
	private escalations: Map<string, Map<string, PermissionTier>> = new Map();

	setSessionTier(sessionId: string, tier: PermissionTier): void {
		this.sessionTiers.set(sessionId, tier);
	}

	getSessionTier(sessionId: string): PermissionTier {
		return this.sessionTiers.get(sessionId) ?? PermissionTier.READ;
	}

	setEscalation(sessionId: string, toolName: string, tier: PermissionTier, expiresAt: number): void {
		if (!this.escalations.has(sessionId)) {
			this.escalations.set(sessionId, new Map());
		}
		this.escalations.get(sessionId)?.set(toolName, tier);

		// Schedule cleanup
		setTimeout(
			() => {
				this.clearEscalation(sessionId, toolName);
			},
			Math.max(0, expiresAt - Date.now()),
		);
	}

	getActiveEscalations(sessionId: string): Map<string, PermissionTier> {
		return this.escalations.get(sessionId) ?? new Map();
	}

	clearEscalation(sessionId: string, toolName?: string): void {
		if (!this.escalations.has(sessionId)) return;

		if (toolName) {
			this.escalations.get(sessionId)?.delete(toolName);
		} else {
			this.escalations.delete(sessionId);
		}
	}
}

/**
 * Tool permission evaluator
 *
 * Evaluates permissions at tool call time considering:
 * - Session base tier
 * - Active escalations
 * - Tool's required tier
 * - Operation-specific requirements
 */
export class ToolPermissionEvaluator {
	private sessionStore: SessionStateStore;
	private config: EvaluatorConfig;
	private toolTierRequirements: Map<string, { minTier: PermissionTier; allowJit?: boolean }> = new Map();

	constructor(sessionStore: SessionStateStore, config?: EvaluatorConfig) {
		this.sessionStore = sessionStore;
		this.config = {
			defaultTier: config?.defaultTier ?? PermissionTier.READ,
			allowJitElevation: config?.allowJitElevation ?? true,
			defaultEscalationTimeoutMs: config?.defaultEscalationTimeoutMs ?? 300_000, // 5 minutes
		};
	}

	/**
	 * Register a tool's tier requirement
	 */
	registerToolTier(toolName: string, minTier: PermissionTier, allowJit?: boolean): void {
		this.toolTierRequirements.set(toolName, { minTier, allowJit });
	}

	/**
	 * Evaluate if a session can use a tool
	 */
	evaluate(sessionId: string, toolName: string, operation?: string): PermissionEvaluationResult {
		// Get tool's required tier (default or explicit)
		const requiredTier = this.getRequiredTier(toolName, operation);

		// Get session's current tier (base + escalations)
		const currentTier = this.getEffectiveTier(sessionId, toolName);

		// Check if current tier satisfies required tier
		if (hasTierPermission(currentTier, requiredTier)) {
			return {
				allowed: true,
				requiredTier,
				currentTier,
			};
		}

		// Check if JIT elevation is possible
		const toolConfig = this.toolTierRequirements.get(toolName);
		const canEscalate = this.config.allowJitElevation && (toolConfig?.allowJit ?? true);

		logger.debug(
			{
				sessionId,
				toolName,
				requiredTier,
				currentTier,
				canEscalate,
			},
			"Permission denied - escalation may be available",
		);

		return {
			allowed: false,
			reason: `Session tier (${currentTier}) is below required tier (${requiredTier})`,
			requiredTier,
			currentTier,
			escalationRequired: canEscalate,
		};
	}

	/**
	 * Get the required tier for a tool/operation
	 */
	private getRequiredTier(toolName: string, _operation?: string): PermissionTier {
		const toolConfig = this.toolTierRequirements.get(toolName);
		const baseTier = toolConfig?.minTier ?? getDefaultTier(toolName);

		// Could add operation-specific tier checking here
		// For now, just return base tier
		return baseTier;
	}

	/**
	 * Get the effective tier for a session (base + escalations)
	 */
	private getEffectiveTier(sessionId: string, toolName: string): PermissionTier {
		const baseTier = this.sessionStore.getSessionTier(sessionId);
		const escalations = this.sessionStore.getActiveEscalations(sessionId);

		// Check if there's an active escalation for this tool
		const escalationTier = escalations.get(toolName);

		// Return the higher of base tier or escalation tier
		if (escalationTier && escalationTier > baseTier) {
			return escalationTier;
		}

		return baseTier;
	}

	/**
	 * Set session's base tier
	 */
	setSessionTier(sessionId: string, tier: PermissionTier): void {
		if (this.sessionStore instanceof InMemorySessionStateStore) {
			(this.sessionStore as InMemorySessionStateStore).setSessionTier(sessionId, tier);
		}
	}

	/**
	 * Get session's current tier
	 */
	getSessionTier(sessionId: string): PermissionTier {
		return this.sessionStore.getSessionTier(sessionId);
	}
}

/**
 * Create a default evaluator with in-memory state
 */
export function createPermissionEvaluator(config?: EvaluatorConfig): ToolPermissionEvaluator {
	const store = new InMemorySessionStateStore();
	return new ToolPermissionEvaluator(store, config);
}
