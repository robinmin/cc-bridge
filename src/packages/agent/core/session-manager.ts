/**
 * SessionManager - Reusable Session Lifecycle Management
 *
 * A generic, infrastructure-agnostic session manager for managing agent instances.
 * Provides:
 * - Lazy creation of agents on first use
 * - TTL-based cleanup of idle sessions
 * - Max concurrent session limit with LRU eviction
 * - Optional pluggable persistence for warm restarts
 * - Context pruning to prevent overflow
 *
 * This is designed to be used by the gateway or other consumers without
 * coupling to any specific backend infrastructure.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { logger } from "@/packages/logger";
import { type CompactionConfig, compactMessagesSync, needsCompaction } from "./context-compaction";

// =============================================================================
// Types
// =============================================================================

/**
 * Session metadata stored by the session manager
 */
export interface SessionMetadata {
	sessionId: string;
	createdAt: number;
	lastActivityAt: number;
	turnCount: number;
	provider?: string;
	model?: string;
	workspaceDir?: string;
}

/**
 * Pluggable persistence interface for session state.
 * Implement this to add custom storage (SQLite, Redis, in-memory, etc.)
 */
export interface SessionPersistence {
	/** Save session metadata */
	saveSession(sessionId: string, metadata: SessionMetadata): void;

	/** Load session metadata (returns null if not found) */
	loadSession(sessionId: string): SessionMetadata | null;

	/** Delete session and its messages */
	deleteSession(sessionId: string): void;

	/** Save message history for a session */
	saveMessages(sessionId: string, messages: AgentMessage[]): void;

	/** Load message history for a session */
	loadMessages(sessionId: string): AgentMessage[];

	/** Update session metadata (turn count, last activity) */
	touchSession(sessionId: string, metadata: Partial<SessionMetadata>): void;

	/** Clean up sessions older than ttlMs */
	cleanupExpiredSessions(ttlMs: number): number;

	/** Optional: Close any open connections */
	close?(): void;
}

/**
 * Configuration for SessionManager
 */
export interface SessionManagerConfig {
	/** Session idle timeout in milliseconds (default: 30 minutes) */
	sessionTtlMs?: number;
	/** Maximum concurrent sessions (default: 100) */
	maxSessions?: number;
	/** Cleanup check interval in milliseconds (default: 60 seconds) */
	cleanupIntervalMs?: number;
	/** Maximum messages to keep per session before pruning (default: 200) */
	maxMessagesPerSession?: number;
	/** Optional persistence layer */
	persistence?: SessionPersistence;
	/** Optional compaction config */
	compaction?: CompactionConfig;
}

/**
 * Factory function for creating agent instances.
 * Consumer provides this to instantiate their specific agent type.
 */
export type AgentFactory<TAgent> = (sessionId: string) => TAgent;

/**
 * Minimal interface that the SessionManager expects agents to implement.
 * This allows the session manager to work with any agent type.
 */
export interface SessionAgent {
	/** Get current message history */
	getMessages(): AgentMessage[];
	/** Clear message history */
	clearMessages(): void;
	/** Abort current execution */
	abort(): void;
	/** Dispose of the agent */
	dispose(): void | Promise<void>;
}

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Internal session entry with metadata
 */
interface SessionEntry<TAgent> {
	agent: TAgent;
	lastActivityAt: number;
	createdAt: number;
	turnCount: number;
}

// =============================================================================
// SessionManager
// =============================================================================

/**
 * Session Manager - Core session lifecycle management
 *
 * Features:
 * - Lazy creation of agents on first use
 * - TTL-based cleanup of idle sessions
 * - Max concurrent session limit with LRU eviction
 * - Optional pluggable persistence for warm restarts
 * - Context pruning to prevent overflow
 */
export class SessionManager<TAgent extends SessionAgent> {
	private readonly sessions: Map<string, SessionEntry<TAgent>> = new Map();
	private readonly sessionTtlMs: number;
	private readonly maxSessions: number;
	private readonly maxMessagesPerSession: number;
	private readonly compactionConfig: CompactionConfig;
	private readonly persistence?: SessionPersistence;
	private readonly createAgent: AgentFactory<TAgent>;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: SessionManagerConfig, createAgent: AgentFactory<TAgent>) {
		this.sessionTtlMs = config.sessionTtlMs ?? 30 * 60 * 1000; // 30 minutes
		this.maxSessions = config.maxSessions ?? 100;
		this.maxMessagesPerSession = config.maxMessagesPerSession ?? 200;
		this.compactionConfig = config.compaction ?? { enabled: true, threshold: 0.8, preserveRecent: 20 };
		this.persistence = config.persistence;
		this.createAgent = createAgent;

		// Auto-start cleanup if persistence is enabled
		const cleanupIntervalMs = config.cleanupIntervalMs ?? 60 * 1000; // 1 minute
		if (this.persistence) {
			this.startCleanup(cleanupIntervalMs);
		}
	}

	/**
	 * Get an existing agent session or create a new one.
	 * If persistence is enabled and a saved session exists, loads message history (warm start).
	 *
	 * @param sessionId - Unique session identifier
	 * @returns The agent for this session
	 */
	getOrCreate(sessionId: string): TAgent {
		// Check for existing in-memory session
		const existing = this.sessions.get(sessionId);
		if (existing) {
			existing.lastActivityAt = Date.now();
			return existing.agent;
		}

		// Enforce max sessions limit - evict LRU if needed
		if (this.sessions.size >= this.maxSessions) {
			this.evictLruSession();
		}

		// Create new agent
		const agent = this.createAgent(sessionId);
		const now = Date.now();
		let turnCount = 0;

		// Warm start - load persisted session if available
		if (this.persistence) {
			const savedSession = this.persistence.loadSession(sessionId);
			if (savedSession) {
				const messages = this.persistence.loadMessages(sessionId);
				if (messages.length > 0) {
					// Prune if needed before loading
					const prunedMessages = this.pruneMessages(messages);
					// Note: Consumer is responsible for loading messages into agent
					// if they want warm restarts. We track turnCount from persistence.
					turnCount = savedSession.turnCount;
					logger.info(
						{
							sessionId,
							restoredMessages: prunedMessages.length,
							originalMessages: messages.length,
							turnCount,
						},
						"Restored agent session from persistence",
					);
				}
			}
		}

		this.sessions.set(sessionId, {
			agent,
			lastActivityAt: now,
			createdAt: now,
			turnCount,
		});

		// Persist new session metadata
		if (this.persistence) {
			this.persistence.saveSession(sessionId, {
				sessionId,
				createdAt: now,
				lastActivityAt: now,
				turnCount: 0,
			});
		}

		logger.debug({ sessionId, activeSessions: this.sessions.size }, "Created new agent session");

		return agent;
	}

	/**
	 * Get an existing session without creating a new one.
	 */
	get(sessionId: string): TAgent | undefined {
		const entry = this.sessions.get(sessionId);
		if (entry) {
			entry.lastActivityAt = Date.now();
			return entry.agent;
		}
		return undefined;
	}

	/**
	 * Check if a session exists for the given sessionId.
	 */
	has(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/**
	 * Remove a specific session.
	 */
	remove(sessionId: string): boolean {
		const entry = this.sessions.get(sessionId);
		if (entry) {
			entry.agent.abort();
			entry.agent.dispose();
			this.sessions.delete(sessionId);

			// Also remove from persistence
			if (this.persistence) {
				this.persistence.deleteSession(sessionId);
			}

			logger.debug({ sessionId }, "Removed agent session");
			return true;
		}
		return false;
	}

	/**
	 * Persist the current message history for a session.
	 * Call this after each successful prompt() to save state.
	 *
	 * @param sessionId - Session to persist
	 * @param messages - Optional messages to persist (if not provided, uses agent.getMessages())
	 */
	persistSession(sessionId: string, messages?: AgentMessage[]): void {
		if (!this.persistence) return;

		const entry = this.sessions.get(sessionId);
		if (!entry) return;

		try {
			const msgs = messages ?? entry.agent.getMessages();
			entry.turnCount++;

			// Prune before persisting
			const toPersist = this.pruneMessages(msgs);
			this.persistence.saveMessages(sessionId, toPersist);
			this.persistence.touchSession(sessionId, {
				turnCount: entry.turnCount,
				lastActivityAt: Date.now(),
			});

			logger.debug(
				{ sessionId, messageCount: toPersist.length, turnCount: entry.turnCount },
				"Persisted agent session",
			);
		} catch (error) {
			logger.error({ sessionId, error }, "Failed to persist agent session");
		}
	}

	/**
	 * Get session metadata.
	 */
	getMetadata(sessionId: string): SessionMetadata | null {
		const entry = this.sessions.get(sessionId);
		if (!entry) {
			// Try to load from persistence
			if (this.persistence) {
				return this.persistence.loadSession(sessionId);
			}
			return null;
		}

		return {
			sessionId,
			createdAt: entry.createdAt,
			lastActivityAt: entry.lastActivityAt,
			turnCount: entry.turnCount,
		};
	}

	/**
	 * Get the number of active sessions.
	 */
	get size(): number {
		return this.sessions.size;
	}

	/**
	 * Start periodic cleanup of expired sessions.
	 */
	startCleanup(intervalMs: number): void {
		if (this.cleanupTimer) {
			this.stopCleanup();
		}

		this.cleanupTimer = setInterval(() => {
			this.cleanupExpiredSessions();
		}, intervalMs);

		// Allow process to exit even if timer is running
		if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
			(this.cleanupTimer as { unref(): void }).unref();
		}

		logger.debug({ intervalMs }, "Session manager cleanup started");
	}

	/**
	 * Stop the cleanup timer.
	 */
	stopCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
			logger.debug("Session manager cleanup stopped");
		}
	}

	/**
	 * Stop the cleanup timer and clear all sessions.
	 */
	dispose(): void {
		this.stopCleanup();

		// Persist all sessions before disposing
		if (this.persistence) {
			for (const [sessionId] of this.sessions) {
				this.persistSession(sessionId);
			}
		}

		for (const [_key, entry] of this.sessions) {
			entry.agent.abort();
			entry.agent.dispose();
		}
		this.sessions.clear();

		// Close persistence connection
		if (this.persistence?.close) {
			this.persistence.close();
		}

		logger.debug("Session manager disposed");
	}

	// =========================================================================
	// Private helpers
	// =========================================================================

	/**
	 * Prune messages to keep within the maxMessagesPerSession limit.
	 * Keeps the most recent messages, always preserving the system prompt context.
	 */
	private pruneMessages(messages: AgentMessage[]): AgentMessage[] {
		if (messages.length <= this.maxMessagesPerSession) {
			return messages;
		}

		// Use sync compaction (slice-based)
		return compactMessagesSync(messages, this.maxMessagesPerSession, this.compactionConfig.preserveRecent ?? 20);
	}

	/**
	 * Check if a session needs compaction.
	 */
	needsCompaction(sessionId: string): boolean {
		const entry = this.sessions.get(sessionId);
		if (!entry) return false;

		const messages = entry.agent.getMessages();
		return needsCompaction(messages.length, this.maxMessagesPerSession, this.compactionConfig.threshold ?? 0.8);
	}

	/**
	 * Remove sessions that have been idle longer than the TTL.
	 */
	private cleanupExpiredSessions(): void {
		const now = Date.now();
		const expiredKeys: string[] = [];

		for (const [key, entry] of this.sessions) {
			if (now - entry.lastActivityAt > this.sessionTtlMs) {
				expiredKeys.push(key);
			}
		}

		for (const key of expiredKeys) {
			const entry = this.sessions.get(key);
			if (entry) {
				// Persist before cleanup
				if (this.persistence) {
					this.persistSession(key);
				}
				entry.agent.abort();
				entry.agent.dispose();
				this.sessions.delete(key);
			}
		}

		// Also cleanup expired sessions in persistence
		if (this.persistence && expiredKeys.length > 0) {
			this.persistence.cleanupExpiredSessions(this.sessionTtlMs);
		}

		if (expiredKeys.length > 0) {
			logger.info({ expired: expiredKeys.length, remaining: this.sessions.size }, "Cleaned up expired agent sessions");
		}
	}

	/**
	 * Evict the least recently used session to make room for a new one.
	 */
	private evictLruSession(): void {
		let oldestKey: string | null = null;
		let oldestTime = Number.POSITIVE_INFINITY;

		for (const [key, entry] of this.sessions) {
			if (entry.lastActivityAt < oldestTime) {
				oldestTime = entry.lastActivityAt;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			const entry = this.sessions.get(oldestKey);
			if (entry) {
				// Persist before eviction
				if (this.persistence) {
					this.persistSession(oldestKey);
				}
				entry.agent.abort();
				entry.agent.dispose();
				this.sessions.delete(oldestKey);
				logger.warn(
					{ evictedSessionId: oldestKey, maxSessions: this.maxSessions },
					"Evicted LRU agent session (max sessions reached)",
				);
			}
		}
	}
}
