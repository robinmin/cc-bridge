import { describe, expect, test } from "bun:test";
import {
	calculateNextCronRun,
	calculateNextRun,
	isValidCronExpr,
	isValidRecurringScheduleValue,
	recurringIntervalMs,
} from "@/packages/scheduler";

describe("scheduler package", () => {
	test("validates recurring schedule values", () => {
		expect(isValidRecurringScheduleValue("5m")).toBe(true);
		expect(isValidRecurringScheduleValue("1h")).toBe(true);
		expect(isValidRecurringScheduleValue("0m")).toBe(false);
		expect(isValidRecurringScheduleValue("5x")).toBe(false);
		expect(isValidRecurringScheduleValue("abc")).toBe(false);
	});

	test("parses recurring interval milliseconds", () => {
		expect(recurringIntervalMs("5m")).toBe(300000);
		expect(recurringIntervalMs("1h")).toBe(3600000);
		expect(recurringIntervalMs("2d")).toBe(172800000);
		expect(recurringIntervalMs("0h")).toBeNull();
		expect(recurringIntervalMs("bad")).toBeNull();
	});

	test("validates cron expressions", () => {
		expect(isValidCronExpr("0 8,20 * * *")).toBe(true);
		expect(isValidCronExpr("*/5 * * * *")).toBe(true);
		expect(isValidCronExpr("0 25 * * *")).toBe(false);
		expect(isValidCronExpr("0 8 * *")).toBe(false);
	});

	test("calculates next cron run in UTC", () => {
		const from = new Date("2026-02-21T07:30:00.000Z");
		expect(calculateNextCronRun("0 8,20 * * *", from)).toBe("2026-02-21 08:00:00");
	});

	test("calculates next run for recurring and once", () => {
		const from = new Date("2026-02-21T07:30:00.000Z");
		expect(calculateNextRun({ schedule_type: "once", schedule_value: "0s" }, from)).toBeNull();
		expect(calculateNextRun({ schedule_type: "recurring", schedule_value: "30m" }, from)).toBe(
			"2026-02-21 08:00:00",
		);
	});
});
