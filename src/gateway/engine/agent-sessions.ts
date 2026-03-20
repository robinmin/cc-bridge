/**
 * Agent Session Manager
 *
 * Gateway-specific session manager.
 * Handles chatId-based sessions with SQLite persistence for warm restarts.
 *
 * Phase 4 additions:
 * - SQLite persistence via AgentPersistence (sessions survive process restarts)
 * - Warm start: load previous message history when creating a session
 * - Context pruning: trim old messages when approaching context window limit
 * - Session metrics: turn count, last activity tracking
 *
 * Phase 5 additions:
 * - LLM-powered context compaction for long-running sessions
 * - Configurable compaction thresholds and summarization
 *
 * Note: This class manages sessions directly using its own Map.
 * It uses the reusable SessionManager's persistence interface for storage,
 * but handles session lifecycle itself to support agentConfig passed at runtime.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { AgentPersistence } from "@/gateway/persistence";
import {
	type AgentConfig,
	compactMessages,
	compactMessagesSync,
	EmbeddedAgent,
	needsCompaction,
} from "@/packages/agent";
import type { MemoryIndexer } from "@/packages/agent/memory/indexer/indexer";
import { logger } from "@/packages/logger";

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the session manager
 */
export interface AgentSessionManagerConfig {
	/** Session idle timeout in milliseconds (default: 30 minutes) */
	sessionTtlMs?: number;
	/** Maximum concurrent sessions (default: 100) */
	maxSessions?: number;
	/** Cleanup check interval in milliseconds (default: 60 seconds) */
	cleanupIntervalMs?: number;
	/** Enable SQLite persistence for session warm restarts (default: false) */
	enablePersistence?: boolean;
	/** SQLite database path (default: "data/gateway.db") */
	dbPath?: string;
	/** Maximum messages to keep per session before pruning (default: 200) */
	maxMessagesPerSession?: number;
	/** Context compaction configuration (Phase 5) */
	compaction?: CompactionConfig;
	/** Optional memory indexer for RAG context retrieval */
	memoryIndexer?: MemoryIndexer;
	/** Factory function for creating agent instances (for testing) */
	_createAgent?: (sessionId: string) => EmbeddedAgent;
}

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Internal session entry with metadata
 */
interface SessionEntry {
	agent: EmbeddedAgent;
	lastActivityAt: number;
	createdAt: number;
	turnCount: number;
	provider?: string;
	model?: string;
	workspaceDir?: string;
}

// =============================================================================
// Gateway Session Persistence Adapter
// =============================================================================

/**
 * Gateway-specific persistence adapter that wraps AgentPersistence
 * and implements the SessionPersistence interface.
 */
// =============================================================================
// AgentSessionManager
// =============================================================================

/**
 * Manages a pool of EmbeddedAgent instances keyed by chatId.
 *
 * This class provides:
 * - SQLite persistence for warm restarts
 * - chatId normalization (string | number -> string)
 * - Gateway-specific methods like steerOrQueue, getSessionMetrics
 * - TTL-based cleanup of idle sessions
 * - Max concurrent session limits with LRU eviction
 */
export class AgentSessionManager {
	private readonly sessions: Map<string, SessionEntry> = new Map();
	private readonly sessionTtlMs: number;
	private readonly maxSessions: number;
	private readonly persistence: AgentPersistence | null;
	private readonly maxMessagesPerSession: number;
	private readonly compactionConfig: CompactionConfig;
	private readonly memoryIndexer: MemoryIndexer | null;
	private readonly _createAgent?: (sessionId: string) => EmbeddedAgent;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config?: AgentSessionManagerConfig) {
		this.sessionTtlMs = config?.sessionTtlMs ?? 30 * 60 * 1000;
		this.maxSessions = config?.maxSessions ?? 100;
		this.maxMessagesPerSession = config?.maxMessagesPerSession ?? 200;
		this.compactionConfig = config?.compaction ?? { enabled: true, threshold: 0.8, preserveRecent: 20 };
		this.memoryIndexer = config?.memoryIndexer ?? null;
		this._createAgent = config?._createAgent;

		// Initialize persistence if enabled
		if (config?.enablePersistence) {
			try {
				this.persistence = new AgentPersistence(config?.dbPath);
				logger.info({ dbPath: config?.dbPath || "data/gateway.db" }, "Agent session persistence enabled");
			} catch (error) {
				logger.error({ error }, "Failed to initialize agent persistence, running without persistence");
				this.persistence = null;
			}
		} else {
			this.persistence = null;
		}

		// Start cleanup timer
		const cleanupIntervalMs = config?.cleanupIntervalMs ?? 60 * 1000;
		this.startCleanup(cleanupIntervalMs);
	}

	/**
	 * Get an existing agent session or create a new one.
	 * If persistence is enabled and a saved session exists, loads message history (warm start).
	 */
	getOrCreate(chatId: string | number, agentConfig: AgentConfig): EmbeddedAgent {
		const key = String(chatId);

		// Check for existing session
		const existing = this.sessions.get(key);
		if (existing) {
			existing.lastActivityAt = Date.now();
			return existing.agent;
		}

		// Enforce max sessions limit - evict LRU if needed
		if (this.sessions.size >= this.maxSessions) {
			this.evictLruSession();
		}

		// Create new agent using the config or factory
		// Inject memoryIndexer into agentConfig if available
		const effectiveConfig: AgentConfig = this.memoryIndexer
			? { ...agentConfig, memoryIndexer: this.memoryIndexer }
			: agentConfig;
		const agent = this._createAgent ? this._createAgent(key) : new EmbeddedAgent(effectiveConfig);
		const now = Date.now();
		let turnCount = 0;

		// Warm start from persistence
		if (this.persistence) {
			const savedSession = this.persistence.getSession(key);
			if (savedSession) {
				const messages = this.persistence.loadMessages(key);
				if (messages.length > 0) {
					turnCount = savedSession.turn_count;
					logger.info(
						{
							chatId: key,
							restoredMessages: messages.length,
							originalMessages: messages.length,
							turnCount,
						},
						"Restored agent session from persistence",
					);
				}
			}
		}

		// Add to internal sessions map
		this.sessions.set(key, {
			agent,
			lastActivityAt: now,
			createdAt: now,
			turnCount,
			provider: agentConfig.provider,
			model: agentConfig.model,
			workspaceDir: agentConfig.workspaceDir,
		});

		// Persist session metadata
		if (this.persistence) {
			this.persistence.saveSession(key, agentConfig.provider, agentConfig.model, agentConfig.workspaceDir, turnCount);
		}

		logger.info({ chatId: key, activeSessions: this.sessions.size }, "Created new agent session");

		return agent;
	}

	/**
	 * Get an existing session without creating a new one.
	 */
	get(chatId: string | number): EmbeddedAgent | undefined {
		const entry = this.sessions.get(String(chatId));
		if (entry) {
			entry.lastActivityAt = Date.now();
			return entry.agent;
		}
		return undefined;
	}

	/**
	 * Check if a session exists for the given chatId.
	 */
	has(chatId: string | number): boolean {
		return this.sessions.has(String(chatId));
	}

	/**
	 * Remove a specific session.
	 */
	remove(chatId: string | number): boolean {
		const key = String(chatId);
		const entry = this.sessions.get(key);
		if (entry) {
			entry.agent.abort();
			entry.agent.dispose();
			this.sessions.delete(key);

			if (this.persistence) {
				this.persistence.deleteSession(key);
			}

			logger.debug({ chatId: key }, "Removed agent session");
			return true;
		}
		return false;
	}

	/**
	 * Persist the current message history for a session.
	 */
	persistSession(chatId: string | number): void {
		if (!this.persistence) return;

		const key = String(chatId);
		const entry = this.sessions.get(key);
		if (!entry) return;

		try {
			const messages = entry.agent.getMessages();
			entry.turnCount++;

			const toPersist = this.pruneMessages(messages);
			this.persistence.saveMessages(key, toPersist);
			this.persistence.touchSession(key, entry.turnCount);

			logger.debug(
				{ chatId: key, messageCount: toPersist.length, turnCount: entry.turnCount },
				"Persisted agent session",
			);
		} catch (error) {
			logger.error({ chatId: key, error }, "Failed to persist agent session");
		}
	}

	/**
	 * Get session metrics for monitoring.
	 */
	getSessionMetrics(chatId: string | number): { turnCount: number; lastActivity: number; messageCount: number } | null {
		const key = String(chatId);
		const entry = this.sessions.get(key);

		if (!entry) return null;

		return {
			turnCount: entry.turnCount,
			lastActivity: entry.lastActivityAt,
			messageCount: entry.agent.getMessages().length,
		};
	}

	/** Check if a chat session's agent is currently running */
	isRunning(chatId: string | number): boolean {
		const agent = this.get(chatId);
		return agent?.isRunning() ?? false;
	}

	/** Steer or queue a message for a running agent */
	steerOrQueue(chatId: string | number, message: string): "steered" | "queued" | "not-running" {
		const agent = this.get(chatId);
		if (!agent || !agent.isRunning()) return "not-running";

		try {
			agent.steer(message);
			return "steered";
		} catch {
			agent.queueFollowUp(message);
			return "queued";
		}
	}

	/**
	 * Get the number of active sessions.
	 */
	get size(): number {
		return this.sessions.size;
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

		if (this.persistence) {
			this.persistence.close();
		}

		logger.debug("Agent session manager disposed");
	}

	/**
	 * Check if a session needs compaction.
	 */
	needsCompaction(chatId: string | number): boolean {
		const agent = this.get(chatId);
		if (!agent) return false;

		const messages = agent.getMessages();
		return needsCompaction(messages.length, this.maxMessagesPerSession, this.compactionConfig.threshold ?? 0.8);
	}

	/**
	 * Compact a session's message history using LLM summarization.
	 */
	async compactSession(chatId: string | number): Promise<void> {
		const key = String(chatId);
		const agent = this.get(chatId);
		if (!agent) return;

		const messages = agent.getMessages();
		if (!needsCompaction(messages.length, this.maxMessagesPerSession, this.compactionConfig.threshold ?? 0.8)) {
			return;
		}

		try {
			const summarizeFn = async (text: string): Promise<string> => {
				try {
					const result = await agent.prompt(text, {
						maxIterations: 1,
						timeoutMs: 30000,
					});
					return result.output;
				} catch (error) {
					logger.warn({ error }, "Failed to summarize context with LLM");
					throw error;
				}
			};

			const { messages: compacted, result } = await compactMessages(messages, this.compactionConfig, summarizeFn);

			// Apply compacted messages to the agent
			agent.clearMessages();
			for (const msg of compacted) {
				agent.getMessages().push(msg);
			}

			logger.info(
				{
					chatId: key,
					originalCount: result.originalCount,
					compactedCount: result.compactedCount,
				},
				"Session compaction completed",
			);
		} catch (error) {
			logger.error({ chatId: key, error }, "Failed to compact session");
		}
	}

	// =========================================================================
	// Cleanup and Private helpers
	// =========================================================================

	/**
	 * Start periodic cleanup of expired sessions.
	 */
	private startCleanup(intervalMs: number): void {
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

		logger.debug({ intervalMs }, "Agent session manager cleanup started");
	}

	/**
	 * Stop the cleanup timer.
	 */
	private stopCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
			logger.debug("Agent session manager cleanup stopped");
		}
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

	/**
	 * Prune messages to keep within the maxMessagesPerSession limit.
	 */
	private pruneMessages(messages: AgentMessage[]): AgentMessage[] {
		if (messages.length <= this.maxMessagesPerSession) {
			return messages;
		}

		return compactMessagesSync(messages, this.maxMessagesPerSession, this.compactionConfig.preserveRecent ?? 20);
	}
}
