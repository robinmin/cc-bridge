#!/usr/bin/env bun
import { Database } from "bun:sqlite";

type TaskRow = {
	id: string;
	chat_id: string;
	instance_name: string;
	prompt: string;
	schedule_type: string;
	schedule_value: string;
	next_run: string | null;
	status: string;
};

function parseAppId(prompt: string): string {
	const match = prompt.match(/^@miniapp:([^\s]+)/);
	return match?.[1] || "";
}

function main(): void {
	const appIdFilter = process.argv[2]?.trim();
	const db = new Database("data/gateway.db");

	const rows = db
		.query(
			"SELECT id, chat_id, instance_name, prompt, schedule_type, schedule_value, next_run, status FROM tasks WHERE status != 'deleted' AND prompt LIKE '@miniapp:%' ORDER BY next_run ASC",
		)
		.all() as TaskRow[];

	const filtered = rows.filter((row) => {
		const appId = parseAppId(row.prompt);
		if (!appId) return false;
		if (!appIdFilter) return true;
		return appId === appIdFilter;
	});

	console.log("📋 Mini-app Scheduled Tasks:");
	if (filtered.length === 0) {
		if (appIdFilter) {
			console.log(`(none for app: ${appIdFilter})`);
		} else {
			console.log("(none)");
		}
		db.close();
		return;
	}

	console.table(
		filtered.map((row) => ({
			id: row.id,
			app_id: parseAppId(row.prompt),
			instance: row.instance_name,
			schedule: `${row.schedule_type} ${row.schedule_value}`,
			next_run: row.next_run,
			status: row.status,
		})),
	);

	db.close();
}

main();
