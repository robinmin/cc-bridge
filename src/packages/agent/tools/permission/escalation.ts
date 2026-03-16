/**
 * Permission Escalation (JIT)
 *
 * Just-in-Time permission elevation system.
 * Allows temporary elevation of permissions for specific operations.
 */

import { logger } from "@/packages/logger";
import { getTierName, hasTierPermission, PermissionTier } from "./tiers";

/**
 * Request for JIT permission elevation
 */
export interface EscalationRequest {
	sessionId: string;
	toolName: string;
	operation?: string;
	reason: string;
	requestedTier: PermissionTier;
	durationMs?: number;
}

/**
 * Result of an escalation request
 */
export interface EscalationResult {
	success: boolean;
	sessionId: string;
	toolName: string;
	requestedTier: PermissionTier;
	grantedTier?: PermissionTier;
	expiresAt?: number;
	reason?: string;
}

/**
 * Active escalation record
 */
interface ActiveEscalation {
	sessionId: string;
	toolName: string;
	grantedTier: PermissionTier;
	expiresAt: number;
	createdAt: number;
}

/**
 * Configuration for escalation system
 */
export interface EscalationConfig {
	/** Maximum duration for elevation in ms (default: 5 minutes) */
	maxDurationMs?: number;
	/** Default elevation duration in ms */
	defaultDurationMs?: number;
	/** Maximum number of active escalations per session */
	maxEscalationsPerSession?: number;
	/** Require user confirmation for elevation (for future use) */
	requireConfirmation?: boolean;
}

/**
 * Permission escalation manager
 *
 * Handles JIT (Just-in-Time) permission elevation:
 * - Request elevation for specific tools/operations
 * - Time-bounded access with auto-expiry
 * - Revocation of elevated permissions
 */
export class PermissionEscalation {
	private escalations: Map<string, ActiveEscalation> = new Map();
	private sessionEscalations: Map<string, Set<string>> = new Map();
	private config: EscalationConfig;

	constructor(config?: EscalationConfig) {
		this.config = {
			maxDurationMs: config?.maxDurationMs ?? 300_000, // 5 minutes
			defaultDurationMs: config?.defaultDurationMs ?? 60_000, // 1 minute
			maxEscalationsPerSession: config?.maxEscalationsPerSession ?? 10,
			requireConfirmation: config?.requireConfirmation ?? false,
		};
	}

	/**
	 * Request JIT elevation for a tool
	 */
	async requestEscalation(request: EscalationRequest): Promise<EscalationResult> {
		const { sessionId, toolName, requestedTier, reason } = request;
		const durationMs = request.durationMs ?? this.config.defaultDurationMs;

		// Validate requested tier
		if (requestedTier < PermissionTier.READ || requestedTier > PermissionTier.ADMIN) {
			return {
				success: false,
				sessionId,
				toolName,
				requestedTier,
				reason: "Invalid tier requested",
			};
		}

		// Check session escalation limit
		const sessionEscalations = this.sessionEscalations.get(sessionId) ?? new Set();
		const maxEscalations = this.config.maxEscalationsPerSession ?? 10;
		if (sessionEscalations.size >= maxEscalations) {
			logger.warn({ sessionId, currentCount: sessionEscalations.size }, "Session has too many active escalations");
			return {
				success: false,
				sessionId,
				toolName,
				requestedTier,
				reason: "Maximum escalations per session exceeded",
			};
		}

		// Cap duration at max
		const maxDuration = this.config.maxDurationMs ?? 300000;
		const actualDuration = Math.min(durationMs, maxDuration);
		const expiresAt = Date.now() + actualDuration;

		// Create escalation record
		const escalation: ActiveEscalation = {
			sessionId,
			toolName,
			grantedTier: requestedTier,
			expiresAt,
			createdAt: Date.now(),
		};

		// Store escalation
		const escalationKey = this.getEscalationKey(sessionId, toolName);
		this.escalations.set(escalationKey, escalation);

		if (!this.sessionEscalations.has(sessionId)) {
			this.sessionEscalations.set(sessionId, new Set());
		}
		this.sessionEscalations.get(sessionId)?.add(toolName);

		// Schedule auto-cleanup
		setTimeout(() => {
			this.clearExpiredEscalation(sessionId, toolName);
		}, actualDuration);

		logger.info(
			{
				sessionId,
				toolName,
				requestedTier: getTierName(requestedTier),
				durationMs: actualDuration,
				reason,
			},
			"Permission escalation granted",
		);

		return {
			success: true,
			sessionId,
			toolName,
			requestedTier,
			grantedTier: requestedTier,
			expiresAt,
			reason: `Escalation granted for ${actualDuration}ms`,
		};
	}

	/**
	 * Check if current session has required tier
	 */
	hasTier(sessionId: string, requiredTier: PermissionTier): boolean {
		// Get the highest tier this session has (base + any escalations)
		const effectiveTier = this.getEffectiveTier(sessionId);
		return hasTierPermission(effectiveTier, requiredTier);
	}

	/**
	 * Revoke elevated permissions for session
	 */
	revokeEscalation(sessionId: string, toolName?: string): void {
		if (toolName) {
			const key = this.getEscalationKey(sessionId, toolName);
			this.escalations.delete(key);
			this.sessionEscalations.get(sessionId)?.delete(toolName);
			logger.info({ sessionId, toolName }, "Escalation revoked for tool");
		} else {
			// Revoke all escalations for session
			const keysToDelete: string[] = [];
			for (const [key, esc] of this.escalations) {
				if (esc.sessionId === sessionId) {
					keysToDelete.push(key);
				}
			}
			for (const key of keysToDelete) {
				this.escalations.delete(key);
			}
			this.sessionEscalations.delete(sessionId);
			logger.info({ sessionId }, "All escalations revoked for session");
		}
	}

	/**
	 * Get active escalations for session
	 */
	getActiveEscalations(sessionId: string): EscalationResult[] {
		const results: EscalationResult[] = [];
		const now = Date.now();

		for (const [_key, esc] of this.escalations) {
			if (esc.sessionId === sessionId && esc.expiresAt > now) {
				results.push({
					success: true,
					sessionId: esc.sessionId,
					toolName: esc.toolName,
					requestedTier: esc.grantedTier,
					grantedTier: esc.grantedTier,
					expiresAt: esc.expiresAt,
				});
			}
		}

		return results;
	}

	/**
	 * Get current tier with escalations applied
	 */
	private getEffectiveTier(sessionId: string): PermissionTier {
		let highestTier = PermissionTier.READ;

		for (const [_key, esc] of this.escalations) {
			if (esc.sessionId === sessionId && esc.expiresAt > Date.now()) {
				if (esc.grantedTier > highestTier) {
					highestTier = esc.grantedTier;
				}
			}
		}

		return highestTier;
	}

	/**
	 * Get escalation key for storage
	 */
	private getEscalationKey(sessionId: string, toolName: string): string {
		return `${sessionId}:${toolName}`;
	}

	/**
	 * Clear expired escalation
	 */
	private clearExpiredEscalation(sessionId: string, toolName: string): void {
		const key = this.getEscalationKey(sessionId, toolName);
		const esc = this.escalations.get(key);

		if (esc && esc.expiresAt <= Date.now()) {
			this.escalations.delete(key);
			this.sessionEscalations.get(sessionId)?.delete(toolName);
			logger.debug({ sessionId, toolName }, "Expired escalation cleaned up");
		}
	}

	/**
	 * Get all active escalations (for debugging/monitoring)
	 */
	getAllActiveEscalations(): ActiveEscalation[] {
		const now = Date.now();
		const active: ActiveEscalation[] = [];

		for (const esc of this.escalations.values()) {
			if (esc.expiresAt > now) {
				active.push(esc);
			}
		}

		return active;
	}
}
