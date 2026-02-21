#!/usr/bin/env bun
import { Database } from "bun:sqlite";

function usage(): never {
	console.error("Usage: bun run scripts/unschedule_miniapp.ts --task-id <task-id> | --app-id <app-id>");
	process.exit(1);
}

function main(): void {
	const [flag, value] = process.argv.slice(2);
	if (!flag || !value) usage();

	const db = new Database("data/gateway.db");

	if (flag === "--task-id") {
		const result = db.run("UPDATE tasks SET status = 'deleted' WHERE id = ? AND prompt LIKE '@miniapp:%'", [value]);
		if (result.changes > 0) {
			console.log(`✅ Unscheduled mini-app task: ${value}`);
		} else {
			console.log(`⚠️ Mini-app task not found: ${value}`);
		}
		db.close();
		return;
	}

	if (flag === "--app-id") {
		const result = db.run(
			"UPDATE tasks SET status = 'deleted' WHERE status != 'deleted' AND prompt LIKE '@miniapp:%' AND (prompt = ? OR prompt LIKE ?)",
			[`@miniapp:${value}`, `@miniapp:${value} %`],
		);
		if (result.changes > 0) {
			console.log(`✅ Unscheduled ${result.changes} mini-app task(s) for app: ${value}`);
		} else {
			console.log(`⚠️ No scheduled mini-app tasks found for app: ${value}`);
		}
		db.close();
		return;
	}

	db.close();
	usage();
}

main();
