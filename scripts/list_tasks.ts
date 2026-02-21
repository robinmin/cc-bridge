#!/usr/bin/env bun
import { Database } from "bun:sqlite";

const db = new Database("data/gateway.db");
const tasks = db.query("SELECT id, chat_id, status FROM tasks").all() as any[];

console.log("📋 Scheduled Tasks:");
console.table(tasks.map(t => ({ id: t.id, chat_id: t.chat_id, status: t.status })));

db.close();
