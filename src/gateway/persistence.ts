import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { logger } from "@/packages/logger";

export interface DBMessage {
	id?: number;
	chat_id: string | number;
	sender: string;
	text: string;
	timestamp: string;
}

export interface DBSession {
	chat_id: string | number;
	instance_name: string;
	last_activity: string;
}

export interface DBTask {
	id?: string;
	instance_name?: string;
	chat_id?: string | number;
	prompt?: string;
	schedule_type?: string;
	schedule_value?: string;
	next_run?: string;
	status?: string;
}

export interface UpsertMiniAppTaskInput {
	id: string;
	instance_name: string;
	app_id: string;
	prompt: string;
	schedule_type: "once" | "recurring" | "cron";
	schedule_value: string;
	next_run: string | null;
	status?: string;
}

export interface UpsertMiniAppTaskResult {
	created: boolean;
	duplicate_ids_deleted: string[];
}

export interface DBMiniAppTask {
	id: string;
	chat_id: string;
	instance_name: string;
	prompt: string;
	schedule_type: string;
	schedule_value: string;
	next_run: string | null;
	status: string;
	app_id: string;
}

export interface DBWorkspace {
	chat_id: string | number;
	workspace_name: string;
	last_updated: string;
}

export interface DBChatChannel {
	chat_id: string | number;
	channel: string;
	last_updated: string;
}

/**
 * Simple LRU Cache entry with TTL support
 */
interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

/**
 * Simple LRU Cache with TTL (Time To Live) support
 */
class LRUCache<T> {
	private cache: Map<string, CacheEntry<T>>;
	private maxSize: number;
	private ttlMs: number;

	constructor(maxSize: number, ttlMinutes: number) {
		this.cache = new Map();
		this.maxSize = maxSize;
		this.ttlMs = ttlMinutes * 60 * 1000;
	}

	get(key: string): T | null {
		const entry = this.cache.get(key);
		if (!entry) {
			return null;
		}

		// Check if expired
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			return null;
		}

		// Move to end (most recently used)
		this.cache.delete(key);
		this.cache.set(key, entry);

		return entry.value;
	}

	set(key: string, value: T): void {
		// Remove oldest if at capacity
		if (this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey) {
				this.cache.delete(firstKey);
			}
		}

		this.cache.set(key, {
			value,
			expiresAt: Date.now() + this.ttlMs,
		});
	}

	delete(key: string): void {
		this.cache.delete(key);
	}

	deleteByPrefix(prefix: string): void {
		for (const key of this.cache.keys()) {
			if (key.startsWith(prefix)) {
				this.cache.delete(key);
			}
		}
	}

	clear(): void {
		this.cache.clear();
	}

	get size(): number {
		return this.cache.size;
	}
}

// Cache key generator for history
function historyCacheKey(chatId: string | number, limit: number, workspace: string): string {
	return `history:${chatId}:${workspace}:${limit}`;
}

export class PersistenceManager {
	private db: Database;
	private historyCache: LRUCache<DBMessage[]> | null;
	private enableCache: boolean;

	constructor(dbPath: string = "data/gateway.db") {
		const dir = path.dirname(dbPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		this.db = new Database(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA synchronous = NORMAL;");
		this.db.exec("PRAGMA busy_timeout = 5000;");

		// Check ENABLE_LRU_HISTORY environment variable (default: false)
		const enableLruHistory = process.env.ENABLE_LRU_HISTORY === "true" || process.env.ENABLE_LRU_HISTORY === "1";
		this.enableCache = enableLruHistory;

		// Initialize cache if enabled (100 entries, 5 minutes TTL)
		this.historyCache = this.enableCache ? new LRUCache<DBMessage[]>(100, 5) : null;

		if (this.enableCache) {
			logger.info({ enabled: true }, "LRU history cache enabled");
		}

		this.init();
	}

	private init() {
		this.db.run(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                workspace_name TEXT NOT NULL DEFAULT 'cc-bridge',
                sender TEXT NOT NULL,
                text TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

		this.db.run(`
            CREATE TABLE IF NOT EXISTS sessions (
                chat_id TEXT PRIMARY KEY,
                instance_name TEXT NOT NULL,
                last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

		this.db.run(`
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                instance_name TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                prompt TEXT NOT NULL,
                schedule_type TEXT NOT NULL,
                schedule_value TEXT NOT NULL,
                next_run DATETIME,
                status TEXT NOT NULL DEFAULT 'active'
            )
        `);

		// Best-effort schema alignment (no migrations in early stage)
		try {
			this.db.run(`ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
		} catch {
			// Ignore if column already exists
		}

		// Normalize existing rows
		this.db.run(`UPDATE tasks SET status = 'active' WHERE status IS NULL OR status = ''`);

		this.db.run(`
            CREATE TABLE IF NOT EXISTS workspaces (
                chat_id TEXT PRIMARY KEY,
                workspace_name TEXT NOT NULL DEFAULT 'cc-bridge',
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

		this.db.run(`
            CREATE TABLE IF NOT EXISTS chat_channels (
                chat_id TEXT PRIMARY KEY,
                channel TEXT NOT NULL,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
	}

	// --- Messages ---
	async storeMessage(chatId: string | number, sender: string, text: string, workspace?: string) {
		const workspaceName = workspace || "cc-bridge";

		// Invalidate cache for this chat/workspace when storing new message
		if (this.historyCache) {
			this.historyCache.deleteByPrefix(`history:${chatId}:${workspaceName}:`);
		}

		this.db.run("INSERT INTO messages (chat_id, workspace_name, sender, text) VALUES (?, ?, ?, ?)", [
			String(chatId),
			workspaceName,
			sender,
			text,
		]);
	}

	async getHistory(chatId: string | number, limit: number = 50, workspace?: string): Promise<DBMessage[]> {
		const workspaceName = workspace || "cc-bridge";

		// Check cache first if enabled
		if (this.historyCache) {
			const cacheKey = historyCacheKey(chatId, limit, workspaceName);
			const cached = this.historyCache.get(cacheKey);
			if (cached) {
				logger.debug({ chatId, limit, workspace: workspaceName, hit: true }, "History cache hit");
				return cached;
			}
			logger.debug({ chatId, limit, workspace: workspaceName, hit: false }, "History cache miss");
		}

		// Fetch from database
		const result = this.db
			.query("SELECT * FROM messages WHERE chat_id = ? AND workspace_name = ? ORDER BY id DESC LIMIT ?")
			.all(String(chatId), workspaceName, limit) as DBMessage[];

		// Store in cache if enabled
		if (this.historyCache) {
			const cacheKey = historyCacheKey(chatId, limit, workspaceName);
			this.historyCache.set(cacheKey, result);
		}

		return result;
	}

	// --- Sessions ---
	async setSession(chatId: string | number, instanceName: string) {
		this.db.run(
			"INSERT OR REPLACE INTO sessions (chat_id, instance_name, last_activity) VALUES (?, ?, CURRENT_TIMESTAMP)",
			[String(chatId), instanceName],
		);
	}

	async getSession(chatId: string | number): Promise<string | null> {
		const result = this.db.query("SELECT instance_name FROM sessions WHERE chat_id = ?").get(String(chatId)) as {
			instance_name: string;
		} | null;
		return result ? result.instance_name : null;
	}

	async getAllSessions(): Promise<DBSession[]> {
		return this.db
			.query("SELECT chat_id, instance_name, last_activity FROM sessions ORDER BY last_activity DESC")
			.all() as DBSession[];
	}

	// --- Tasks ---
	async saveTask(task: DBTask) {
		this.db.run(
			"INSERT OR REPLACE INTO tasks (id, instance_name, chat_id, prompt, schedule_type, schedule_value, next_run, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				task.id,
				task.instance_name,
				task.chat_id,
				task.prompt,
				task.schedule_type,
				task.schedule_value,
				task.next_run,
				task.status,
			],
		);
	}

	async upsertMiniAppTask(input: UpsertMiniAppTaskInput): Promise<UpsertMiniAppTaskResult> {
		const chatId = `miniapp:${input.app_id}`;
		const existingRows = this.db
			.query("SELECT id FROM tasks WHERE status != 'deleted' AND instance_name = ? AND prompt = ?")
			.all(input.instance_name, input.prompt) as Array<{ id: string }>;

		const created = !existingRows.some((row) => row.id === input.id);
		const duplicateIds = existingRows.filter((row) => row.id !== input.id).map((row) => row.id);

		if (duplicateIds.length > 0) {
			const placeholders = duplicateIds.map(() => "?").join(", ");
			this.db.run(`UPDATE tasks SET status = 'deleted' WHERE id IN (${placeholders})`, duplicateIds);
		}

		await this.saveTask({
			id: input.id,
			instance_name: input.instance_name,
			chat_id: chatId,
			prompt: input.prompt,
			schedule_type: input.schedule_type,
			schedule_value: input.schedule_value,
			next_run: input.next_run ?? undefined,
			status: input.status ?? "active",
		});

		return {
			created,
			duplicate_ids_deleted: duplicateIds,
		};
	}

	async getMiniAppTasks(appId?: string): Promise<DBMiniAppTask[]> {
		const rows = this.db
			.query(
				"SELECT id, chat_id, instance_name, prompt, schedule_type, schedule_value, next_run, status FROM tasks WHERE status != 'deleted' AND prompt LIKE '@miniapp:%' ORDER BY next_run ASC",
			)
			.all() as Array<{
			id: string;
			chat_id: string;
			instance_name: string;
			prompt: string;
			schedule_type: string;
			schedule_value: string;
			next_run: string | null;
			status: string;
		}>;

		return rows
			.map((row) => {
				const appMatch = row.prompt.match(/^@miniapp:([^\s]+)/);
				const parsedAppId = appMatch?.[1] || "";
				return { ...row, app_id: parsedAppId };
			})
			.filter((row) => row.app_id && (!appId || row.app_id === appId));
	}

	async unscheduleMiniAppTaskByTaskId(taskId: string): Promise<number> {
		const result = this.db.run("UPDATE tasks SET status = 'deleted' WHERE id = ? AND prompt LIKE '@miniapp:%'", [
			taskId,
		]);
		return result.changes;
	}

	async unscheduleMiniAppTaskByAppId(appId: string): Promise<number> {
		const result = this.db.run(
			"UPDATE tasks SET status = 'deleted' WHERE status != 'deleted' AND prompt LIKE '@miniapp:%' AND (prompt = ? OR prompt LIKE ?)",
			[`@miniapp:${appId}`, `@miniapp:${appId} %`],
		);
		return result.changes;
	}

	async getActiveTasks() {
		return this.db.query("SELECT * FROM tasks WHERE status = 'active' AND next_run <= datetime('now')").all();
	}

	async getAllTasks() {
		try {
			return this.db.query("SELECT * FROM tasks WHERE status != 'deleted' ORDER BY next_run ASC").all();
		} catch {
			return [];
		}
	}

	async deleteTask(id: string) {
		this.db.run("UPDATE tasks SET status = 'deleted' WHERE id = ?", [id]);
	}

	// --- Workspaces ---
	async setWorkspace(chatId: string | number, workspaceName: string) {
		this.db.run(
			"INSERT OR REPLACE INTO workspaces (chat_id, workspace_name, last_updated) VALUES (?, ?, CURRENT_TIMESTAMP)",
			[String(chatId), workspaceName],
		);
	}

	async getWorkspace(chatId: string | number): Promise<string> {
		const result = this.db.query("SELECT workspace_name FROM workspaces WHERE chat_id = ?").get(String(chatId)) as {
			workspace_name: string;
		} | null;
		return result?.workspace_name || "cc-bridge"; // Default to cc-bridge
	}

	// --- Chat Channels ---
	async setChatChannel(chatId: string | number, channel: string) {
		this.db.run(
			"INSERT OR REPLACE INTO chat_channels (chat_id, channel, last_updated) VALUES (?, ?, CURRENT_TIMESTAMP)",
			[String(chatId), channel],
		);
	}

	async getChatChannel(chatId: string | number): Promise<string | null> {
		const result = this.db.query("SELECT channel FROM chat_channels WHERE chat_id = ?").get(String(chatId)) as {
			channel: string;
		} | null;
		return result?.channel || null;
	}

	async getAllChatChannels(): Promise<DBChatChannel[]> {
		return this.db
			.query("SELECT chat_id, channel, last_updated FROM chat_channels ORDER BY last_updated DESC")
			.all() as DBChatChannel[];
	}

	close() {
		this.db.close();
	}
}

export const persistence = new PersistenceManager();

// =============================================================================
// Agent Session Persistence (Phase 4)
// =============================================================================

/**
 * Stored agent session metadata
 */
export interface DBAgentSession {
	session_id: string;
	provider: string;
	model: string;
	workspace_dir: string;
	turn_count: number;
	last_activity: string;
	created_at: string;
}

/**
 * Stored agent message (serialized AgentMessage from pi-agent-core)
 */
export interface DBAgentMessage {
	id?: number;
	session_id: string;
	message_json: string;
	sequence: number;
	created_at: string;
}

/**
 * Agent Session Persistence Manager
 *
 * Extends the base PersistenceManager pattern for agent-specific tables.
 * Uses a separate class to avoid bloating PersistenceManager with agent concerns.
 */
export class AgentPersistence {
	private db: Database;

	constructor(dbPath: string = "data/gateway.db") {
		const dir = path.dirname(dbPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		this.db = new Database(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA synchronous = NORMAL;");
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.initTables();
	}

	private initTables(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS agent_sessions (
				session_id TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				model TEXT NOT NULL,
				workspace_dir TEXT NOT NULL,
				turn_count INTEGER NOT NULL DEFAULT 0,
				last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP
			)
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS agent_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				message_json TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE CASCADE
			)
		`);

		this.db.run(`
			CREATE INDEX IF NOT EXISTS idx_agent_messages_session
			ON agent_messages(session_id, sequence)
		`);
	}

	// --- Session CRUD ---

	/**
	 * Save or update agent session metadata.
	 */
	saveSession(sessionId: string, provider: string, model: string, workspaceDir: string, turnCount: number): void {
		this.db.run(
			`INSERT OR REPLACE INTO agent_sessions (session_id, provider, model, workspace_dir, turn_count, last_activity)
			 VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
			[sessionId, provider, model, workspaceDir, turnCount],
		);
	}

	/**
	 * Get session metadata by ID.
	 */
	getSession(sessionId: string): DBAgentSession | null {
		return (
			(this.db.query("SELECT * FROM agent_sessions WHERE session_id = ?").get(sessionId) as DBAgentSession) || null
		);
	}

	/**
	 * Delete a session and its messages (CASCADE).
	 */
	deleteSession(sessionId: string): void {
		// Delete messages first (in case FK cascade not supported)
		this.db.run("DELETE FROM agent_messages WHERE session_id = ?", [sessionId]);
		this.db.run("DELETE FROM agent_sessions WHERE session_id = ?", [sessionId]);
	}

	/**
	 * List all sessions ordered by last activity.
	 */
	listSessions(): DBAgentSession[] {
		return this.db.query("SELECT * FROM agent_sessions ORDER BY last_activity DESC").all() as DBAgentSession[];
	}

	/**
	 * Delete sessions older than the given TTL (in milliseconds).
	 */
	cleanupExpiredSessions(ttlMs: number): number {
		const cutoff = new Date(Date.now() - ttlMs).toISOString();
		// Delete messages for expired sessions
		this.db.run(
			"DELETE FROM agent_messages WHERE session_id IN (SELECT session_id FROM agent_sessions WHERE last_activity < ?)",
			[cutoff],
		);
		const result = this.db.run("DELETE FROM agent_sessions WHERE last_activity < ?", [cutoff]);
		return result.changes;
	}

	// --- Message History ---

	/**
	 * Save the full message history for a session (replace strategy).
	 * This replaces all existing messages for the session.
	 */
	saveMessages(sessionId: string, messages: unknown[]): void {
		// Use a transaction for atomicity
		const deleteStmt = this.db.prepare("DELETE FROM agent_messages WHERE session_id = ?");
		const insertStmt = this.db.prepare(
			"INSERT INTO agent_messages (session_id, message_json, sequence) VALUES (?, ?, ?)",
		);

		this.db.transaction(() => {
			deleteStmt.run(sessionId);
			for (let i = 0; i < messages.length; i++) {
				insertStmt.run(sessionId, JSON.stringify(messages[i]), i);
			}
		})();
	}

	/**
	 * Load message history for a session.
	 * Returns deserialized messages in order.
	 */
	loadMessages(sessionId: string): unknown[] {
		const rows = this.db
			.query("SELECT message_json FROM agent_messages WHERE session_id = ? ORDER BY sequence ASC")
			.all(sessionId) as Array<{ message_json: string }>;

		return rows
			.map((row) => {
				try {
					return JSON.parse(row.message_json);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	}

	/**
	 * Get the count of messages for a session.
	 */
	getMessageCount(sessionId: string): number {
		const result = this.db
			.query("SELECT COUNT(*) as count FROM agent_messages WHERE session_id = ?")
			.get(sessionId) as { count: number };
		return result?.count ?? 0;
	}

	/**
	 * Update the turn count and last activity for a session.
	 */
	touchSession(sessionId: string, turnCount: number): void {
		this.db.run("UPDATE agent_sessions SET turn_count = ?, last_activity = CURRENT_TIMESTAMP WHERE session_id = ?", [
			turnCount,
			sessionId,
		]);
	}

	close(): void {
		this.db.close();
	}
}
