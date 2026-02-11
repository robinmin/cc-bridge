import { logger } from "@/packages/logger";
import type { TmuxManager } from "./tmux-manager";

/**
 * Session metadata for tracking workspace sessions
 */
export interface SessionMetadata {
	workspace: string;
	sessionName: string;
	containerId: string;
	createdAt: number;
	lastActivityAt: number;
	activeRequests: number;
	totalRequests: number;
	status: "active" | "idle" | "terminating";
}

/**
 * Configuration for SessionPoolService
 */
export interface SessionPoolConfig {
	containerId: string;
	maxSessions: number;
	inactivityTimeoutMs: number;
	cleanupIntervalMs: number;
	enableAutoCleanup: boolean;
}

/**
 * SessionPoolService - Manages multiple workspace sessions
 *
 * Features:
 * - One tmux session per workspace
 * - Lazy session creation
 * - Automatic session cleanup
 * - Session metadata tracking
 * - Workspace isolation
 */
export class SessionPoolService {
	private sessions: Map<string, SessionMetadata> = new Map();
	private pendingCreations: Map<string, Promise<SessionMetadata>> = new Map();
	private tmuxManager: TmuxManager;
	private config: Required<SessionPoolConfig>;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private started = false;
	private destroyed = false;

	constructor(tmuxManager: TmuxManager, config: Partial<SessionPoolConfig> = {}) {
		this.tmuxManager = tmuxManager;

		// Validate containerId is provided
		if (!config.containerId) {
			throw new Error("containerId is required for SessionPoolService");
		}

		this.config = {
			containerId: config.containerId,
			maxSessions: 50,
			inactivityTimeoutMs: 3600000, // 1 hour
			cleanupIntervalMs: 300000, // 5 minutes
			enableAutoCleanup: true,
			...config,
		};

		logger.info(
			{
				containerId: this.config.containerId,
				maxSessions: this.config.maxSessions,
				inactivityTimeoutMs: this.config.inactivityTimeoutMs,
			},
			"SessionPoolService created",
		);
	}

	/**
	 * Start session pool management
	 */
	async start(): Promise<void> {
		if (this.started) {
			logger.warn("SessionPoolService already started");
			return;
		}

		logger.info(
			{
				maxSessions: this.config.maxSessions,
				inactivityTimeout: this.config.inactivityTimeoutMs,
			},
			"Starting session pool service",
		);

		// List existing tmux sessions and register them
		await this.discoverExistingSessions();

		// Start cleanup timer
		if (this.config.enableAutoCleanup) {
			this.cleanupTimer = setInterval(() => {
				this.cleanupInactiveSessions().catch((err) => {
					logger.error({ err }, "Session cleanup failed");
				});
			}, this.config.cleanupIntervalMs);

			logger.info({ cleanupIntervalMs: this.config.cleanupIntervalMs }, "Session cleanup timer started");
		}

		this.started = true;
	}

	/**
	 * Stop session pool management
	 */
	async stop(): Promise<void> {
		if (!this.started) {
			return;
		}

		logger.info("Stopping session pool service");

		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		// Terminate all sessions gracefully
		await this.terminateAllSessions();

		this.started = false;
	}

	/**
	 * Cleanup all sessions and release resources
	 * More comprehensive than stop() - ensures all resources are released
	 */
	async cleanup(): Promise<void> {
		if (this.destroyed) {
			return;
		}

		logger.info("Cleaning up SessionPoolService");

		const cleanupPromises: Promise<void>[] = [];

		// Cleanup all sessions
		for (const [workspace, session] of this.sessions.entries()) {
			cleanupPromises.push(
				this.cleanupSession(workspace, session).catch((err) => {
					logger.warn({ workspace, error: err }, "Failed to cleanup session");
				}),
			);
		}

		// Wait for all cleanups (with timeout)
		await Promise.allSettled(cleanupPromises);

		// Clear sessions map
		this.sessions.clear();

		// Stop cleanup timer
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		this.destroyed = true;
		this.started = false;
		logger.info("SessionPoolService cleanup complete");
	}

	/**
	 * Cleanup a single session
	 */
	private async cleanupSession(workspace: string, session: SessionMetadata): Promise<void> {
		try {
			// Stop accepting new requests
			session.status = "terminating";

			// Wait for active requests to complete (with timeout)
			const timeout = 5000; // 5 seconds
			const start = Date.now();

			while (session.activeRequests > 0 && Date.now() - start < timeout) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			if (session.activeRequests > 0) {
				logger.warn(
					{ workspace, activeRequests: session.activeRequests },
					"Session still has active requests during cleanup",
				);
			}

			// Kill the tmux session
			if (session.sessionName) {
				try {
					await this.tmuxManager.killWorkspaceSession(this.config.containerId, session.sessionName);
				} catch (err) {
					// Session may already be dead
					logger.debug({ err, sessionName: session.sessionName }, "Session already terminated");
				}
			}

			this.sessions.delete(workspace);
			logger.debug({ workspace }, "Session cleaned up");
		} catch (error) {
			logger.error({ workspace, error }, "Error cleaning up session");
			throw error;
		}
	}

	/**
	 * Check if pool is destroyed
	 */
	isDestroyed(): boolean {
		return this.destroyed;
	}

	/**
	 * Get pool statistics
	 */
	getStats(): {
		totalSessions: number;
		activeSessions: number;
		idleSessions: number;
		terminatingSessions: number;
		totalRequests: number;
		activeRequests: number;
		maxSessions: number;
		destroyed: boolean;
		started: boolean;
	} {
		const sessions = Array.from(this.sessions.values());
		const totalRequests = sessions.reduce((sum, s) => sum + s.totalRequests, 0);
		const activeRequests = sessions.reduce((sum, s) => sum + s.activeRequests, 0);

		return {
			totalSessions: this.sessions.size,
			activeSessions: sessions.filter((s) => s.status === "active").length,
			idleSessions: sessions.filter((s) => s.status === "idle").length,
			terminatingSessions: sessions.filter((s) => s.status === "terminating").length,
			totalRequests,
			activeRequests,
			maxSessions: this.config.maxSessions,
			destroyed: this.destroyed,
			started: this.started,
		};
	}

	/**
	 * Get or create session for workspace
	 */
	async getOrCreateSession(workspace: string): Promise<SessionMetadata> {
		// Validate workspace name
		if (!this.isValidWorkspaceName(workspace)) {
			throw new Error(`Invalid workspace name: ${workspace}`);
		}

		// Check if session exists
		const session = this.sessions.get(workspace);

		if (session) {
			// Update last activity
			session.lastActivityAt = Date.now();
			session.status = "active";

			logger.debug({ workspace, sessionName: session.sessionName }, "Reusing existing session");
			return session;
		}

		// Check duplicate creation requests (race condition fix)
		const pendingPromise = this.pendingCreations.get(workspace);
		if (pendingPromise) {
			logger.debug({ workspace }, "Waiting for pending session creation");
			return pendingPromise;
		}

		// Check session limit
		if (this.sessions.size >= this.config.maxSessions) {
			throw new Error(`Session limit reached (${this.config.maxSessions}). Cannot create new session.`);
		}

		// Create new session with locking
		const creationPromise = (async () => {
			try {
				const session = await this.createSession(workspace);
				this.sessions.set(workspace, session);
				logger.info({ workspace, sessionName: session.sessionName }, "Created new session");
				return session;
			} finally {
				this.pendingCreations.delete(workspace);
			}
		})();

		this.pendingCreations.set(workspace, creationPromise);

		return creationPromise;
	}

	/**
	 * Create new tmux session for workspace
	 */
	private async createSession(workspace: string): Promise<SessionMetadata> {
		const sessionName = `claude-${workspace}`;
		const now = Date.now();

		try {
			// Create tmux session
			await this.tmuxManager.createWorkspaceSession(this.config.containerId, sessionName, workspace);

			const metadata: SessionMetadata = {
				workspace,
				sessionName,
				containerId: this.config.containerId,
				createdAt: now,
				lastActivityAt: now,
				activeRequests: 0,
				totalRequests: 0,
				status: "active",
			};

			return metadata;
		} catch (err) {
			logger.error({ err, workspace }, "Failed to create session");
			throw err;
		}
	}

	/**
	 * Switch to different workspace
	 */
	async switchWorkspace(currentWorkspace: string, targetWorkspace: string): Promise<SessionMetadata> {
		logger.info({ currentWorkspace, targetWorkspace }, "Switching workspace");

		// Get or create target session
		const targetSession = await this.getOrCreateSession(targetWorkspace);

		logger.info(
			{
				from: currentWorkspace,
				to: targetWorkspace,
				targetSessionName: targetSession.sessionName,
			},
			"Workspace switched",
		);

		return targetSession;
	}

	/**
	 * List all active sessions
	 */
	listSessions(): SessionMetadata[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * Get session metadata
	 */
	getSession(workspace: string): SessionMetadata | undefined {
		return this.sessions.get(workspace);
	}

	/**
	 * Delete session
	 */
	async deleteSession(workspace: string): Promise<void> {
		const session = this.sessions.get(workspace);
		if (!session) {
			throw new Error(`Session not found: ${workspace}`);
		}

		// Check for active requests
		if (session.activeRequests > 0) {
			throw new Error(`Cannot delete session with active requests (${session.activeRequests} pending)`);
		}

		// Terminate tmux session
		try {
			await this.tmuxManager.killWorkspaceSession(this.config.containerId, session.sessionName);
		} catch (err) {
			logger.warn({ err, sessionName: session.sessionName }, "Failed to kill tmux session");
		}

		// Remove from pool
		this.sessions.delete(workspace);

		logger.info({ workspace, sessionName: session.sessionName }, "Deleted session");
	}

	/**
	 * Track request start
	 */
	trackRequestStart(workspace: string): void {
		const session = this.sessions.get(workspace);
		if (session) {
			session.activeRequests++;
			session.totalRequests++;
			session.lastActivityAt = Date.now();
			session.status = "active";

			logger.debug({ workspace, activeRequests: session.activeRequests }, "Request start tracked");
		}
	}

	/**
	 * Track request completion
	 */
	trackRequestComplete(workspace: string): void {
		const session = this.sessions.get(workspace);
		if (session) {
			session.activeRequests = Math.max(0, session.activeRequests - 1);
			session.lastActivityAt = Date.now();

			if (session.activeRequests === 0) {
				session.status = "idle";
			}

			logger.debug({ workspace, activeRequests: session.activeRequests }, "Request complete tracked");
		}
	}

	/**
	 * Cleanup inactive sessions
	 */
	private async cleanupInactiveSessions(): Promise<void> {
		const now = Date.now();
		const sessionsToClean: string[] = [];

		for (const [workspace, session] of this.sessions.entries()) {
			const inactiveMs = now - session.lastActivityAt;

			// Skip if session has active requests
			if (session.activeRequests > 0) {
				continue;
			}

			// Check if session exceeded inactivity timeout
			if (inactiveMs > this.config.inactivityTimeoutMs) {
				sessionsToClean.push(workspace);
			}
		}

		if (sessionsToClean.length > 0) {
			logger.info({ count: sessionsToClean.length }, "Cleaning up inactive sessions");
		}

		for (const workspace of sessionsToClean) {
			try {
				await this.deleteSession(workspace);
			} catch (err) {
				logger.error({ err, workspace }, "Failed to cleanup session");
			}
		}
	}

	/**
	 * Discover existing tmux sessions and add to pool.
	 *
	 * LIMITATION: Metadata Loss on Restart
	 *
	 * This method discovers active tmux sessions but cannot recover:
	 * - createdAt timestamps (will be set to current time)
	 * - lastActivityAt timestamps (will be set to current time)
	 * - totalRequests count (will be reset to 0)
	 *
	 * This is because tmux does not store this metadata. Only the session
	 * name and workspace are recoverable from the tmux session name.
	 *
	 * To preserve metadata across restarts, consider implementing persistent
	 * metadata storage (e.g., writing session metadata to disk on changes
	 * and loading it during discovery).
	 *
	 * @returns Promise that resolves when discovery is complete
	 */
	private async discoverExistingSessions(): Promise<void> {
		try {
			const sessions = await this.tmuxManager.listAllSessions(this.config.containerId);

			logger.debug({ sessions }, "Discovered existing tmux sessions");

			for (const sessionName of sessions) {
				// Parse workspace from session name
				const match = sessionName.match(/^claude-(.+)$/);
				if (match) {
					const workspace = match[1];

					// Only register if we don't already have it
					if (!this.sessions.has(workspace)) {
						const now = Date.now();
						const metadata: SessionMetadata = {
							workspace,
							sessionName,
							containerId: this.config.containerId,
							createdAt: now, // Reset to now - original timestamp is lost
							lastActivityAt: now, // Reset to now - original timestamp is lost
							activeRequests: 0,
							totalRequests: 0, // Reset to 0 - original count is lost
							status: "idle",
						};

						this.sessions.set(workspace, metadata);
						logger.info({ workspace, sessionName }, "Discovered existing session (metadata reset due to restart)");
					}
				}
			}
		} catch (err) {
			logger.warn({ err }, "Failed to discover existing sessions");
		}
	}

	/**
	 * Terminate all sessions
	 */
	private async terminateAllSessions(): Promise<void> {
		const workspaces = Array.from(this.sessions.keys());

		logger.info({ count: workspaces.length }, "Terminating all sessions");

		for (const workspace of workspaces) {
			try {
				const session = this.sessions.get(workspace);
				if (session) {
					session.status = "terminating";

					try {
						await this.tmuxManager.killWorkspaceSession(this.config.containerId, session.sessionName);
					} catch (err) {
						// Session may already be dead
						logger.debug({ err, sessionName: session.sessionName }, "Session already terminated");
					}

					this.sessions.delete(workspace);
				}
			} catch (err) {
				logger.error({ err, workspace }, "Failed to terminate session");
			}
		}

		this.sessions.clear();
	}

	/**
	 * Validate workspace name
	 */
	private isValidWorkspaceName(workspace: string): boolean {
		// Alphanumeric, hyphens, underscores only, max 64 chars
		return /^[a-zA-Z0-9_-]+$/.test(workspace) && workspace.length <= 64 && workspace.length > 0;
	}

	/**
	 * Check if service is started
	 */
	isRunning(): boolean {
		return this.started;
	}
}
