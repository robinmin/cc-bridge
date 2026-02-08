import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { logger } from "@/packages/logger";

/**
 * Simple mutex for concurrent operation safety
 */
class Mutex {
	private queue: Array<() => void> = [];
	private locked = false;

	async acquire(): Promise<() => void> {
		return new Promise((resolve) => {
			if (!this.locked) {
				this.locked = true;
				resolve(() => this.release());
			} else {
				this.queue.push(() => {
					this.locked = true;
					resolve(() => this.release());
				});
			}
		});
	}

	private release(): void {
		const next = this.queue.shift();
		if (next) {
			next();
		} else {
			this.locked = false;
		}
	}
}

// Type definitions for tmux session management
export interface TmuxSessionInfo {
	sessionName: string;
	workspace: string;
	chatId: string | number;
	createdAt: Date;
	lastUsedAt: Date;
	containerId: string;
}

export interface TmuxManagerConfig {
	maxSessionsPerContainer?: number;
	sessionIdleTimeoutMs?: number;
}

// Error context for structured logging
interface TmuxErrorContext {
	containerId?: string;
	sessionName?: string;
	operation: string;
	workspace?: string;
	chatId?: string | number;
	cause?: unknown;
}

/**
 * Custom error class for TmuxManager operations
 */
export class TmuxManagerError extends Error {
	constructor(
		message: string,
		public readonly context: TmuxErrorContext,
		cause?: Error,
	) {
		super(message);
		this.name = "TmuxManagerError";
		if (cause) {
			this.cause = cause;
		}
	}
}

/**
 * Timeout error class for operations that exceed their time limit
 */
export class TmuxTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TmuxTimeoutError";
	}
}

/**
 * TmuxManager - Manages persistent tmux sessions inside Docker containers
 *
 * This class handles:
 * - Creating and naming tmux sessions deterministically
 * - Sending commands to existing sessions
 * - Session discovery and cleanup
 * - Shell escaping for safe command execution
 */
export class TmuxManager {
	private sessions: Map<string, TmuxSessionInfo> = new Map();
	private readonly config: Required<TmuxManagerConfig>;
	private started: boolean = false;
	private stopping: boolean = false;
	private readonly DEFAULT_SEND_TIMEOUT = 5000; // 5 seconds for send commands
	private readonly syncLock = new Mutex();

	constructor(config?: TmuxManagerConfig) {
		this.config = {
			maxSessionsPerContainer: config?.maxSessionsPerContainer ?? GATEWAY_CONSTANTS.TMUX.MAX_SESSIONS_PER_CONTAINER,
			sessionIdleTimeoutMs: config?.sessionIdleTimeoutMs ?? GATEWAY_CONSTANTS.TMUX.DEFAULT_IDLE_TIMEOUT_MS,
		};
	}

	/**
	 * Start the tmux manager and initialize resources
	 */
	async start(): Promise<void> {
		if (this.started) {
			logger.warn("TmuxManager already started");
			return;
		}

		try {
			// Ensure tmux server is running
			await this.ensureTmuxServer();

			// Initialize session tracking by discovering existing sessions
			await this.discoverExistingSessions();

			this.started = true;
			logger.info("TmuxManager started successfully");
		} catch (error) {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to start TmuxManager");
			throw error;
		}
	}

	/**
	 * Stop the tmux manager and cleanup resources
	 */
	async stop(): Promise<void> {
		if (!this.started || this.stopping) {
			return;
		}

		this.stopping = true;

		try {
			// Close all active sessions across all containers
			await this.closeAllSessions();

			this.started = false;
			logger.info("TmuxManager stopped successfully");
		} catch (error) {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "Error during TmuxManager stop");
			throw error;
		} finally {
			this.stopping = false;
		}
	}

	/**
	 * Check if manager is started
	 */
	isRunning(): boolean {
		return this.started;
	}

	/**
	 * Execute promise with timeout
	 * @param promise - Promise to execute
	 * @param timeoutMs - Timeout in milliseconds (0 or Infinity for no timeout)
	 * @param operation - Operation description for error message
	 * @throws {TimeoutError} If operation times out
	 */
	private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
		// If timeout is 0 or Infinity, don't apply timeout
		if (timeoutMs === 0 || timeoutMs === Infinity) {
			return promise;
		}

		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				reject(new TmuxTimeoutError(`Operation "${operation}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});

		try {
			return await Promise.race([promise, timeoutPromise]);
		} finally {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
		}
	}

	/**
	 * Ensure the tmux server is running on the host
	 */
	private async ensureTmuxServer(): Promise<void> {
		const proc = Bun.spawn(["tmux", "ls"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			// Start tmux server
			logger.info("Starting tmux server");
			const startProc = Bun.spawn(["tmux", "start-server"], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			await startProc.exited;
			logger.info("Tmux server started");
		}
	}

	/**
	 * Discover existing tmux sessions on startup
	 */
	private async discoverExistingSessions(): Promise<void> {
		logger.info("Discovering existing tmux sessions");

		// Get all sessions by listing on local tmux
		const proc = Bun.spawn(["tmux", "list-sessions", "-F", "#{session_name}"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			// No server running or no sessions
			logger.debug("No existing tmux sessions found");
			return;
		}

		const sessions = stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.filter((name) => name.startsWith(GATEWAY_CONSTANTS.TMUX.SESSION_PREFIX));

		logger.info({ sessionCount: sessions.length, sessions }, "Discovered existing tmux sessions");

		// Add discovered sessions to tracking
		for (const sessionName of sessions) {
			// Parse session name to extract workspace and chatId
			// Format: claude-{workspace}-{chatId}
			const parts = sessionName.split(GATEWAY_CONSTANTS.TMUX.SESSION_NAME_SEPARATOR);
			if (parts.length >= 3) {
				const workspace = parts[1];
				const chatId = parts[2];
				this.sessions.set(sessionName, {
					sessionName,
					workspace,
					chatId,
					createdAt: new Date(),
					lastUsedAt: new Date(),
					containerId: "local", // Local sessions don't have container
				});
			}
		}
	}

	/**
	 * Close all active sessions across all containers
	 */
	private async closeAllSessions(): Promise<void> {
		logger.info({ sessionCount: this.sessions.size }, "Closing all tmux sessions");

		const errors: Array<{ sessionName: string; error: string }> = [];

		for (const [sessionName, session] of this.sessions.entries()) {
			try {
				if (session.containerId === "local") {
					// Kill local tmux session
					const proc = Bun.spawn(["tmux", "kill-session", "-t", sessionName], {
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					});
					await proc.exited;
				} else {
					// Kill container session
					await this.killSession(session.containerId, sessionName);
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				errors.push({ sessionName, error: errorMsg });
				logger.warn({ sessionName, error: errorMsg }, "Failed to kill session during shutdown");
			}
		}

		// Clear all tracked sessions
		this.sessions.clear();

		if (errors.length > 0) {
			logger.warn({ errorCount: errors.length, errors }, "Some sessions failed to close during shutdown");
		}
	}

	/**
	 * Generate a deterministic session name from workspace and chatId
	 * Format: claude-{workspace}-{chatId}
	 * Protected for testability
	 */
	protected generateSessionName(workspace: string, chatId: string | number): string {
		const sanitizedWorkspace = workspace.replace(/[^a-zA-Z0-9_-]/g, "_");
		const sanitizedChatId = String(chatId).replace(/[^a-zA-Z0-9_-]/g, "_");
		return `${GATEWAY_CONSTANTS.TMUX.SESSION_PREFIX}${GATEWAY_CONSTANTS.TMUX.SESSION_NAME_SEPARATOR}${sanitizedWorkspace}${GATEWAY_CONSTANTS.TMUX.SESSION_NAME_SEPARATOR}${sanitizedChatId}`;
	}

	/**
	 * Escape a string for safe use in single quotes in shell
	 * Replaces ' with '\'' (end quote, escaped quote, start quote)
	 * Protected for testability
	 */
	protected escapeForShell(text: string): string {
		return text.replace(/'/g, "'\\''");
	}

	/**
	 * Execute a command inside a Docker container via docker exec
	 * Protected for testability
	 */
	protected async execInContainer(
		containerId: string,
		command: string[],
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const proc = Bun.spawn(["docker", "exec", containerId, ...command], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		return { stdout, stderr, exitCode };
	}

	/**
	 * Get or create a tmux session for a specific chat and workspace
	 * @returns Session name
	 */
	async getOrCreateSession(containerId: string, workspace: string, chatId: string | number): Promise<string> {
		const sessionName = this.generateSessionName(workspace, chatId);

		// Check if session already exists (in memory or in tmux)
		if (await this.sessionExists(containerId, sessionName)) {
			logger.debug(
				{
					containerId,
					sessionName,
					workspace,
					chatId,
				},
				"Reusing existing tmux session",
			);
			this.updateSessionTimestamp(sessionName);
			return sessionName;
		}

		// Check session limit
		const activeSessions = await this.listSessions(containerId);
		if (activeSessions.length >= this.config.maxSessionsPerContainer) {
			const error = new TmuxManagerError(
				`Maximum sessions per container reached (${this.config.maxSessionsPerContainer})`,
				{
					containerId,
					operation: "get_or_create_session",
					workspace,
					chatId,
				},
			);
			logger.error(
				{
					...error.context,
					activeSessionCount: activeSessions.length,
					maxSessions: this.config.maxSessionsPerContainer,
				},
				"Failed to create session: limit reached",
			);
			throw error;
		}

		// Create new session
		logger.info(
			{
				containerId,
				sessionName,
				workspace,
				chatId,
			},
			"Creating new tmux session",
		);

		const { stderr, exitCode } = await this.execInContainer(containerId, [
			"tmux",
			"new-session",
			"-d",
			"-s",
			sessionName,
		]);

		if (exitCode !== 0) {
			const error = new TmuxManagerError(`Failed to create tmux session: ${stderr || "Unknown error"}`, {
				containerId,
				sessionName,
				operation: "create_session",
				workspace,
				chatId,
			});
			logger.error(
				{
					...error.context,
					exitCode,
					stderr,
				},
				"Failed to create tmux session",
			);
			throw error;
		}

		// Store session metadata
		this.sessions.set(sessionName, {
			sessionName,
			workspace,
			chatId,
			createdAt: new Date(),
			lastUsedAt: new Date(),
			containerId,
		});

		logger.info(
			{
				containerId,
				sessionName,
				workspace,
				chatId,
			},
			"Tmux session created successfully",
		);

		return sessionName;
	}

	/**
	 * Send a prompt to an existing tmux session with optional timeout
	 * @returns void (success is implied if no error is thrown)
	 * @param timeout - Timeout in milliseconds (default: 5000ms, use 0 for no timeout)
	 */
	async sendToSession(
		containerId: string,
		sessionName: string,
		prompt: string,
		metadata: { requestId: string; chatId: string; workspace: string },
		timeout: number = this.DEFAULT_SEND_TIMEOUT,
	): Promise<void> {
		const errorContext: TmuxErrorContext = {
			containerId,
			sessionName,
			operation: "send_to_session",
			workspace: metadata.workspace,
			chatId: metadata.chatId,
		};

		// Verify session exists
		if (!(await this.sessionExists(containerId, sessionName))) {
			const error = new TmuxManagerError(`Session ${sessionName} does not exist`, errorContext);
			logger.error(
				{
					...errorContext,
					requestId: metadata.requestId,
				},
				"Failed to send to session: session does not exist",
			);
			throw error;
		}

		// Escape prompt for shell
		const escapedPrompt = this.escapeForShell(prompt);

		// Set environment variables for Stop Hook
		const envVars = [
			`export REQUEST_ID=${metadata.requestId}`,
			`export CHAT_ID=${metadata.chatId}`,
			`export WORKSPACE_NAME=${metadata.workspace}`,
		].join("; ");

		// Build Claude command with environment
		const command = `${envVars}; claude -p '${escapedPrompt}'`;

		logger.debug(
			{
				...errorContext,
				requestId: metadata.requestId,
				promptLength: prompt.length,
				timeout,
			},
			"Sending prompt to tmux session",
		);

		try {
			// Send to tmux session with timeout
			const { stderr, exitCode } = await this.withTimeout(
				this.execInContainer(containerId, ["tmux", "send-keys", "-t", sessionName, command, "C-m"]),
				timeout,
				`sendToSession(${sessionName})`,
			);

			if (exitCode !== 0) {
				const error = new TmuxManagerError(`Failed to send keys to tmux session: ${stderr || "Unknown error"}`, {
					...errorContext,
					cause: stderr,
				});
				logger.error(
					{
						...errorContext,
						requestId: metadata.requestId,
						exitCode,
						stderr,
					},
					"Failed to send keys to tmux session",
				);
				throw error;
			}

			// Update last used timestamp
			this.updateSessionTimestamp(sessionName);

			logger.debug(
				{
					...errorContext,
					requestId: metadata.requestId,
				},
				"Prompt sent to tmux session successfully",
			);
		} catch (error) {
			if (error instanceof TimeoutError) {
				logger.error(
					{
						...errorContext,
						timeout,
						requestId: metadata.requestId,
					},
					"Send to session timed out",
				);
				throw new TmuxManagerError(
					`Failed to send command to session ${sessionName} within ${timeout}ms`,
					errorContext,
					error,
				);
			}
			throw error;
		}
	}

	/**
	 * Check if a tmux session exists
	 */
	async sessionExists(containerId: string, sessionName: string): Promise<boolean> {
		try {
			const { exitCode } = await this.execInContainer(containerId, ["tmux", "has-session", "-t", sessionName]);

			// exitCode 0 means session exists, 1 means it doesn't
			return exitCode === 0;
		} catch (error) {
			logger.warn(
				{
					containerId,
					sessionName,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error checking if tmux session exists",
			);
			return false;
		}
	}

	/**
	 * List all active sessions in a container
	 */
	async listSessions(containerId: string): Promise<string[]> {
		try {
			const { stdout, exitCode } = await this.execInContainer(containerId, [
				"tmux",
				"list-sessions",
				"-F",
				"#{session_name}",
			]);

			if (exitCode !== 0) {
				// No sessions is not an error - just return empty list
				if (stdout.includes("no server running")) {
					return [];
				}
				logger.warn(
					{
						containerId,
						exitCode,
						stderr: stdout,
					},
					"Failed to list tmux sessions",
				);
				return [];
			}

			// Parse session names from output (one per line)
			const sessions = stdout
				.trim()
				.split("\n")
				.filter(Boolean)
				.filter((name) => name.startsWith(GATEWAY_CONSTANTS.TMUX.SESSION_PREFIX));

			logger.debug(
				{
					containerId,
					sessionCount: sessions.length,
					sessions,
				},
				"Listed tmux sessions",
			);

			return sessions;
		} catch (error) {
			logger.error(
				{
					containerId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error listing tmux sessions",
			);
			return [];
		}
	}

	/**
	 * Kill a specific session
	 */
	async killSession(containerId: string, sessionName: string): Promise<void> {
		logger.info(
			{
				containerId,
				sessionName,
			},
			"Killing tmux session",
		);

		const { stderr, exitCode } = await this.execInContainer(containerId, ["tmux", "kill-session", "-t", sessionName]);

		if (exitCode !== 0) {
			logger.warn(
				{
					containerId,
					sessionName,
					exitCode,
					stderr,
				},
				"Failed to kill tmux session",
			);
		}

		// Remove from memory
		this.sessions.delete(sessionName);

		logger.info(
			{
				containerId,
				sessionName,
			},
			"Tmux session killed",
		);
	}

	/**
	 * Update the last used timestamp for a session
	 */
	private updateSessionTimestamp(sessionName: string): void {
		const session = this.sessions.get(sessionName);
		if (session) {
			session.lastUsedAt = new Date();
		}
	}

	/**
	 * Cleanup idle sessions (not used in last N milliseconds)
	 * @returns Number of sessions cleaned up
	 */
	async cleanupIdleSessions(): Promise<number> {
		const now = Date.now();
		let cleanedCount = 0;

		logger.info(
			{
				timeoutMs: this.config.sessionIdleTimeoutMs,
			},
			"Cleaning up idle tmux sessions",
		);

		// Get all sessions grouped by container
		const sessionsByContainer = new Map<string, TmuxSessionInfo[]>();
		for (const session of this.sessions.values()) {
			const containerSessions = sessionsByContainer.get(session.containerId) ?? [];
			containerSessions.push(session);
			sessionsByContainer.set(session.containerId, containerSessions);
		}

		// Check each session for idle timeout
		for (const session of this.sessions.values()) {
			const idleTime = now - session.lastUsedAt.getTime();

			if (idleTime > this.config.sessionIdleTimeoutMs) {
				logger.info(
					{
						sessionName: session.sessionName,
						containerId: session.containerId,
						idleTimeMs: idleTime,
						idleMinutes: Math.floor(idleTime / 60000),
					},
					"Cleaning up idle tmux session",
				);

				try {
					await this.killSession(session.containerId, session.sessionName);
					cleanedCount++;
				} catch (error) {
					logger.error(
						{
							sessionName: session.sessionName,
							containerId: session.containerId,
							error: error instanceof Error ? error.message : String(error),
						},
						"Failed to cleanup idle session",
					);
				}
			}
		}

		logger.info(
			{
				cleanedCount,
				totalSessions: this.sessions.size,
			},
			"Idle session cleanup complete",
		);

		return cleanedCount;
	}

	/**
	 * Get session info for a specific session name
	 */
	getSessionInfo(sessionName: string): TmuxSessionInfo | undefined {
		return this.sessions.get(sessionName);
	}

	/**
	 * Get all tracked sessions
	 */
	getAllSessions(): TmuxSessionInfo[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * Create a new workspace-level tmux session
	 * This is different from per-chat sessions - one session per workspace
	 */
	async createWorkspaceSession(containerId: string, sessionName: string, workspace: string): Promise<void> {
		logger.info({ containerId, sessionName, workspace }, "Creating workspace tmux session");

		const { stderr, exitCode } = await this.execInContainer(containerId, [
			"tmux",
			"new-session",
			"-d",
			"-s",
			sessionName,
		]);

		if (exitCode !== 0) {
			const error = new TmuxManagerError(`Failed to create workspace tmux session: ${stderr || "Unknown error"}`, {
				containerId,
				sessionName,
				operation: "create_workspace_session",
				workspace,
			});
			logger.error(
				{
					...error.context,
					exitCode,
					stderr,
				},
				"Failed to create workspace tmux session",
			);
			throw error;
		}

		// Set workspace environment variable in the session
		await this.execInContainer(containerId, [
			"tmux",
			"set-environment",
			"-t",
			sessionName,
			"WORKSPACE_NAME",
			workspace,
		]);

		logger.info({ containerId, sessionName, workspace }, "Workspace tmux session created successfully");
	}

	/**
	 * List all tmux sessions (including workspace sessions)
	 */
	async listAllSessions(containerId: string): Promise<string[]> {
		try {
			const { stdout, exitCode } = await this.execInContainer(containerId, [
				"tmux",
				"list-sessions",
				"-F",
				"#{session_name}",
			]);

			if (exitCode !== 0) {
				// No sessions is not an error - just return empty list
				if (stdout.includes("no server running")) {
					return [];
				}
				logger.warn(
					{
						containerId,
						exitCode,
						stderr: stdout,
					},
					"Failed to list tmux sessions",
				);
				return [];
			}

			// Parse session names from output (one per line)
			const sessions = stdout.trim().split("\n").filter(Boolean);

			logger.debug(
				{
					containerId,
					sessionCount: sessions.length,
					sessions,
				},
				"Listed all tmux sessions",
			);

			return sessions;
		} catch (error) {
			logger.error(
				{
					containerId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error listing tmux sessions",
			);
			return [];
		}
	}

	/**
	 * Kill a workspace-level session
	 */
	async killWorkspaceSession(containerId: string, sessionName: string): Promise<void> {
		logger.info({ containerId, sessionName }, "Killing workspace tmux session");

		const { stderr, exitCode } = await this.execInContainer(containerId, ["tmux", "kill-session", "-t", sessionName]);

		if (exitCode !== 0) {
			// Session may already be dead - only log at debug level
			if (!stderr.includes("session not found")) {
				logger.warn(
					{
						containerId,
						sessionName,
						exitCode,
						stderr,
					},
					"Failed to kill workspace tmux session",
				);
			} else {
				logger.debug({ containerId, sessionName }, "Workspace tmux session already terminated");
			}
		}

		logger.info({ containerId, sessionName }, "Workspace tmux session killed");
	}

	/**
	 * Sync in-memory session tracking with actual tmux sessions
	 * Call this on startup to recover state
	 */
	async syncSessions(containerId: string): Promise<void> {
		const release = await this.syncLock.acquire();

		try {
			logger.info(
				{
					containerId,
				},
				"Syncing tmux sessions with container state",
			);

			const activeSessions = await this.listSessions(containerId);

			// Remove sessions that no longer exist
			for (const [sessionName, sessionInfo] of this.sessions.entries()) {
				if (sessionInfo.containerId === containerId && !activeSessions.includes(sessionName)) {
					this.sessions.delete(sessionName);
					logger.debug(
						{
							sessionName,
							containerId,
						},
						"Removed stale session from tracking",
					);
				}
			}

			// Note: We can't recover workspace/chatId from session name alone
			// because we'd need to parse the sanitized names which is lossy
			// In production, consider persisting this metadata to disk

			this.lastSyncTime = Date.now();

			logger.info(
				{
					containerId,
					trackedSessions: this.sessions.size,
					activeTmuxSessions: activeSessions.length,
				},
				"Session sync complete",
			);
		} finally {
			release();
		}
	}
}
