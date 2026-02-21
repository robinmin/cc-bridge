export type ScheduleType = "once" | "recurring" | "cron";
type ScheduleUnit = "s" | "m" | "h" | "d";

function toSqlDate(date: Date): string {
	return date.toISOString().replace("T", " ").substring(0, 19);
}

export function toSqlNow(): string {
	return toSqlDate(new Date());
}

export function isValidRecurringScheduleValue(value: string): boolean {
	return recurringIntervalMs(value) !== null;
}

export function recurringIntervalMs(value: string): number | null {
	const match = value.trim().match(/^(\d+)([smhd])$/);
	if (!match) return null;
	const num = Number.parseInt(match[1], 10);
	const unit = match[2] as ScheduleUnit;
	if (!Number.isFinite(num) || num <= 0) return null;

	switch (unit) {
		case "s":
			return num * 1000;
		case "m":
			return num * 60 * 1000;
		case "h":
			return num * 60 * 60 * 1000;
		case "d":
			return num * 24 * 60 * 60 * 1000;
	}
}

export function isValidCronExpr(value: string): boolean {
	const parts = value.trim().split(/\s+/);
	if (parts.length !== 5) return false;

	const ranges: Array<[number, number]> = [
		[0, 59], // minute
		[0, 23], // hour
		[1, 31], // day of month
		[1, 12], // month
		[0, 6], // day of week
	];

	return parts.every((field, idx) => isValidCronField(field, ranges[idx][0], ranges[idx][1]));
}

function isValidCronField(field: string, min: number, max: number): boolean {
	const segments = field.split(",");
	return segments.every((segment) => isValidCronSegment(segment.trim(), min, max));
}

function isValidCronSegment(segment: string, min: number, max: number): boolean {
	if (!segment) return false;
	if (segment === "*") return true;

	const stepMatch = segment.match(/^(.+)\/(\d+)$/);
	if (stepMatch) {
		const step = Number.parseInt(stepMatch[2], 10);
		if (!Number.isFinite(step) || step <= 0) return false;
		const base = stepMatch[1];
		if (base === "*") return true;
		const range = base.match(/^(\d+)-(\d+)$/);
		if (!range) return false;
		const start = Number.parseInt(range[1], 10);
		const end = Number.parseInt(range[2], 10);
		return start >= min && end <= max && start <= end;
	}

	const rangeMatch = segment.match(/^(\d+)-(\d+)$/);
	if (rangeMatch) {
		const start = Number.parseInt(rangeMatch[1], 10);
		const end = Number.parseInt(rangeMatch[2], 10);
		return start >= min && end <= max && start <= end;
	}

	const n = Number.parseInt(segment, 10);
	return Number.isFinite(n) && n >= min && n <= max;
}

type CronParts = {
	minutes: Set<number>;
	hours: Set<number>;
	daysOfMonth: Set<number>;
	months: Set<number>;
	daysOfWeek: Set<number>;
};

function parseCronExpr(expr: string): CronParts | null {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return null;

	const minutes = parseCronField(fields[0], 0, 59);
	const hours = parseCronField(fields[1], 0, 23);
	const daysOfMonth = parseCronField(fields[2], 1, 31);
	const months = parseCronField(fields[3], 1, 12);
	const daysOfWeek = parseCronField(fields[4], 0, 6);

	if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
	return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

function parseCronField(field: string, min: number, max: number): Set<number> | null {
	const out = new Set<number>();
	const segments = field.split(",");

	for (const rawSegment of segments) {
		const segment = rawSegment.trim();
		if (!segment) return null;
		const values = expandCronSegment(segment, min, max);
		if (!values) return null;
		for (const value of values) out.add(value);
	}

	return out;
}

function expandCronSegment(segment: string, min: number, max: number): number[] | null {
	if (segment === "*") {
		const values: number[] = [];
		for (let i = min; i <= max; i += 1) values.push(i);
		return values;
	}

	const stepMatch = segment.match(/^(.+)\/(\d+)$/);
	if (stepMatch) {
		const base = stepMatch[1];
		const step = Number.parseInt(stepMatch[2], 10);
		if (!Number.isFinite(step) || step <= 0) return null;

		if (base === "*") {
			const values: number[] = [];
			for (let i = min; i <= max; i += step) values.push(i);
			return values;
		}

		const rangeMatch = base.match(/^(\d+)-(\d+)$/);
		if (!rangeMatch) return null;
		const start = Number.parseInt(rangeMatch[1], 10);
		const end = Number.parseInt(rangeMatch[2], 10);
		if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < min || end > max) return null;
		const values: number[] = [];
		for (let i = start; i <= end; i += step) values.push(i);
		return values;
	}

	const rangeMatch = segment.match(/^(\d+)-(\d+)$/);
	if (rangeMatch) {
		const start = Number.parseInt(rangeMatch[1], 10);
		const end = Number.parseInt(rangeMatch[2], 10);
		if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < min || end > max) return null;
		const values: number[] = [];
		for (let i = start; i <= end; i += 1) values.push(i);
		return values;
	}

	const single = Number.parseInt(segment, 10);
	if (!Number.isFinite(single) || single < min || single > max) return null;
	return [single];
}

function matchesCron(date: Date, cron: CronParts): boolean {
	const minute = date.getUTCMinutes();
	const hour = date.getUTCHours();
	const dayOfMonth = date.getUTCDate();
	const month = date.getUTCMonth() + 1;
	const dayOfWeek = date.getUTCDay();

	return (
		cron.minutes.has(minute) &&
		cron.hours.has(hour) &&
		cron.daysOfMonth.has(dayOfMonth) &&
		cron.months.has(month) &&
		cron.daysOfWeek.has(dayOfWeek)
	);
}

export function calculateNextCronRun(expr: string, from = new Date()): string | null {
	const cron = parseCronExpr(expr);
	if (!cron) return null;

	// Align to next minute boundary and search forward up to one year.
	const start = new Date(from);
	start.setUTCSeconds(0, 0);
	start.setUTCMinutes(start.getUTCMinutes() + 1);

	const maxChecks = 366 * 24 * 60;
	const probe = new Date(start);

	for (let i = 0; i < maxChecks; i += 1) {
		if (matchesCron(probe, cron)) {
			return toSqlDate(probe);
		}
		probe.setUTCMinutes(probe.getUTCMinutes() + 1);
	}

	return null;
}

export function calculateNextRun(task: { schedule_type: ScheduleType; schedule_value: string }, from = new Date()): string | null {
	if (task.schedule_type === "once") return null;
	if (task.schedule_type === "cron") return calculateNextCronRun(task.schedule_value, from);

	const interval = recurringIntervalMs(task.schedule_value);
	if (!interval) return null;
	return toSqlDate(new Date(from.getTime() + interval));
}
