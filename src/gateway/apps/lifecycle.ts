#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { type MiniAppDefinition, miniAppDriver } from "@/gateway/apps/driver";
import { persistence } from "@/gateway/persistence";
import { calculateNextCronRun, isValidCronExpr, isValidRecurringScheduleValue, toSqlNow } from "@/packages/scheduler";

type ScheduleType = "once" | "recurring" | "cron";

function usage(): never {
	process.stderr.write(
		[
			"Usage:",
			"  bun run src/gateway/apps/lifecycle.ts schedule <app-id> [once|recurring|cron] [schedule-value] [input] [instance]",
			"  bun run src/gateway/apps/lifecycle.ts list [app-id]",
			"  bun run src/gateway/apps/lifecycle.ts unschedule --task-id <task-id> | --app-id <app-id>",
		].join("\n"),
	);
	process.exit(1);
}

function toSafeIdPart(value: string): string {
	return value.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buildMiniAppTaskId(appId: string, instanceName: string, input: string): string {
	const seed = `${appId}\n${instanceName}\n${input}`;
	const digest = createHash("sha256").update(seed).digest("hex").slice(0, 12);
	return `miniapp-${toSafeIdPart(appId)}-${toSafeIdPart(instanceName)}-${digest}`;
}

async function cmdSchedule(args: string[]): Promise<void> {
	const [appId, scheduleTypeArg, scheduleValueArg, inputArg, instanceArg] = args;

	if (!appId) usage();

	let app: MiniAppDefinition;
	try {
		app = await miniAppDriver.loadApp(appId);
	} catch {
		process.stderr.write(`Mini-app not found: src/apps/${appId}.md\n`);
		process.exitCode = 1;
		return;
	}
	if (!app.enabled) {
		process.stderr.write(`Mini-app "${appId}" is disabled. Enable it first before scheduling.\n`);
		process.exitCode = 1;
		return;
	}

	if (scheduleTypeArg && scheduleTypeArg !== "once" && scheduleTypeArg !== "recurring" && scheduleTypeArg !== "cron") {
		process.stderr.write(`Invalid schedule type: "${scheduleTypeArg}" (expected: once, recurring, or cron)\n`);
		process.exitCode = 1;
		return;
	}

	const scheduleType: ScheduleType =
		scheduleTypeArg === "once" || scheduleTypeArg === "recurring" || scheduleTypeArg === "cron"
			? scheduleTypeArg
			: (app.scheduleType ?? "recurring");

	const scheduleValue = (
		scheduleValueArg ||
		app.scheduleValue ||
		(scheduleType === "once" ? "0s" : scheduleType === "cron" ? "0 * * * *" : "1h")
	).trim();

	if (scheduleType === "recurring" && !isValidRecurringScheduleValue(scheduleValue)) {
		process.stderr.write(`Invalid schedule value for recurring task: "${scheduleValue}" (example: 5m, 1h, 1d)\n`);
		process.exitCode = 1;
		return;
	}
	if (scheduleType === "cron" && !isValidCronExpr(scheduleValue)) {
		process.stderr.write(`Invalid cron expression: "${scheduleValue}" (expected 5 fields, UTC, e.g. "0 9 * * 1-5")\n`);
		process.exitCode = 1;
		return;
	}

	const input = inputArg?.trim() || "";
	const prompt = miniAppDriver.createTaskPrompt(appId, input || undefined);
	const instanceName = (instanceArg || app.instance || "cc-bridge").trim();
	const taskId = buildMiniAppTaskId(appId, instanceName, input);
	const nextRun = scheduleType === "cron" ? (calculateNextCronRun(scheduleValue) ?? toSqlNow()) : toSqlNow();

	const result = await persistence.upsertMiniAppTask({
		id: taskId,
		instance_name: instanceName,
		app_id: appId,
		prompt,
		schedule_type: scheduleType,
		schedule_value: scheduleValue,
		next_run: nextRun,
		status: "active",
	});

	process.stdout.write(`✅ Mini-app schedule ${result.created ? "created" : "updated"} (upsert)\n`);
	process.stdout.write(`id: ${taskId}\n`);
	process.stdout.write(`app: ${appId}\n`);
	process.stdout.write(`instance: ${instanceName}\n`);
	process.stdout.write(`schedule: ${scheduleType} ${scheduleValue}\n`);
	process.stdout.write(`prompt: ${prompt}\n`);
	process.stdout.write(`next_run: ${nextRun}\n`);
	process.stdout.write(`duplicates_deleted: ${result.duplicate_ids_deleted.length}\n`);
}

async function cmdList(args: string[]): Promise<void> {
	const appIdFilter = args[0]?.trim();
	const rows = await persistence.getMiniAppTasks(appIdFilter);

	process.stdout.write("📋 Mini-app Scheduled Tasks:\n");
	if (rows.length === 0) {
		process.stdout.write(appIdFilter ? `(none for app: ${appIdFilter})\n` : "(none)\n");
		return;
	}

	console.table(
		rows.map((row) => ({
			id: row.id,
			app_id: row.app_id,
			instance: row.instance_name,
			schedule: `${row.schedule_type} ${row.schedule_value}`,
			next_run: row.next_run,
			status: row.status,
		})),
	);
}

async function cmdUnschedule(args: string[]): Promise<void> {
	const [flag, value] = args;
	if (!flag || !value) usage();

	if (flag === "--task-id") {
		const updated = await persistence.unscheduleMiniAppTaskByTaskId(value);
		process.stdout.write(
			updated > 0 ? `✅ Unscheduled mini-app task: ${value}\n` : `⚠️ Mini-app task not found: ${value}\n`,
		);
		return;
	}

	if (flag === "--app-id") {
		const updated = await persistence.unscheduleMiniAppTaskByAppId(value);
		process.stdout.write(
			updated > 0
				? `✅ Unscheduled ${updated} mini-app task(s) for app: ${value}\n`
				: `⚠️ No scheduled mini-app tasks found for app: ${value}\n`,
		);
		return;
	}

	usage();
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (!command) usage();

	if (command === "schedule") {
		await cmdSchedule(args);
		return;
	}
	if (command === "list") {
		await cmdList(args);
		return;
	}
	if (command === "unschedule") {
		await cmdUnschedule(args);
		return;
	}

	usage();
}

await main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
