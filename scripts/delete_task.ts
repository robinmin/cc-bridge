#!/usr/bin/env bun
import { Database } from "bun:sqlite";

const db = new Database("data/gateway.db");
const taskId = process.argv[2];

if (!taskId) {
	console.error("Usage: bun scripts/delete_task.ts <task_id>");
	process.exit(1);
}

const result = db.run("UPDATE tasks SET status = 'deleted' WHERE id = ?", [taskId]);

if (result.changes > 0) {
	console.log(`✅ Deleted task: ${taskId}`);
} else {
	console.log(`⚠️ Task not found: ${taskId}`);
}

db.close();
