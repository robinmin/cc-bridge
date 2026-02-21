#!/usr/bin/env bun
import { miniAppDriver, type MiniAppDefinition } from "@/gateway/apps/driver";
import { persistence } from "@/gateway/persistence";
import { calculateNextCronRun, isValidCronExpr, isValidRecurringScheduleValue, toSqlNow } from "@/packages/scheduler";

type ScheduleType = "once" | "recurring" | "cron";

async function main(): Promise<void> {
	const [appId, scheduleTypeArg, scheduleValueArg, inputArg, instanceArg] = process.argv.slice(2);

	if (!appId) {
		process.stderr.write(
			"Usage: bun run scripts/schedule_miniapp.ts <app-id> [once|recurring|cron] [schedule-value] [input] [instance]\n",
		);
		process.exitCode = 1;
		return;
	}

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
		process.stderr.write(
			`Invalid cron expression: "${scheduleValue}" (expected 5 fields, UTC, e.g. "0 9 * * 1-5")\n`,
		);
		process.exitCode = 1;
		return;
	}

	const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const prompt = miniAppDriver.createTaskPrompt(appId, inputArg?.trim() || undefined);
	const instanceName = (instanceArg || app.instance || "cc-bridge").trim();
	const nextRun =
		scheduleType === "cron"
			? (calculateNextCronRun(scheduleValue) ?? toSqlNow())
			: toSqlNow();

	await persistence.saveTask({
		id: taskId,
		instance_name: instanceName,
		chat_id: `miniapp:${appId}`,
		prompt,
		schedule_type: scheduleType,
		schedule_value: scheduleValue,
		next_run: nextRun,
		status: "active",
	});

	process.stdout.write("✅ Mini-app scheduled\n");
	process.stdout.write(`id: ${taskId}\n`);
	process.stdout.write(`app: ${appId}\n`);
	process.stdout.write(`instance: ${instanceName}\n`);
	process.stdout.write(`schedule: ${scheduleType} ${scheduleValue}\n`);
	process.stdout.write(`prompt: ${prompt}\n`);
	process.stdout.write(`next_run: ${nextRun}\n`);
}

await main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
