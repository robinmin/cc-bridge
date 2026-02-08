import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

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

export interface DBWorkspace {
	chat_id: string | number;
	workspace_name: string;
	last_updated: string;
}

export class PersistenceManager {
	private db: Database;

	constructor(dbPath: string = "data/gateway.db") {
		const dir = path.dirname(dbPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		this.db = new Database(dbPath);
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
                status TEXT DEFAULT 'active'
            )
        `);

		this.db.run(`
            CREATE TABLE IF NOT EXISTS workspaces (
                chat_id TEXT PRIMARY KEY,
                workspace_name TEXT NOT NULL DEFAULT 'cc-bridge',
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
	}

	// --- Messages ---
	async storeMessage(chatId: string | number, sender: string, text: string, workspace?: string) {
		const workspaceName = workspace || "cc-bridge";
		this.db.run("INSERT INTO messages (chat_id, workspace_name, sender, text) VALUES (?, ?, ?, ?)", [
			String(chatId),
			workspaceName,
			sender,
			text,
		]);
	}

	async getHistory(chatId: string | number, limit: number = 50, workspace?: string): Promise<DBMessage[]> {
		const workspaceName = workspace || "cc-bridge";
		return this.db
			.query("SELECT * FROM messages WHERE chat_id = ? AND workspace_name = ? ORDER BY id DESC LIMIT ?")
			.all(String(chatId), workspaceName, limit) as DBMessage[];
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

	async getActiveTasks() {
		return this.db.query("SELECT * FROM tasks WHERE status = 'active' AND next_run <= datetime('now')").all();
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

	close() {
		this.db.close();
	}
}

export const persistence = new PersistenceManager();
