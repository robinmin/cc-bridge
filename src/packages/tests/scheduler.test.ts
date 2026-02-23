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
		expect(recurringIntervalMs("2s")).toBe(2000);
		expect(recurringIntervalMs("5m")).toBe(300000);
		expect(recurringIntervalMs("1h")).toBe(3600000);
		expect(recurringIntervalMs("2d")).toBe(172800000);
		expect(recurringIntervalMs(" 15m ")).toBe(900000);
		expect(recurringIntervalMs("0h")).toBeNull();
		expect(recurringIntervalMs("bad")).toBeNull();
	});

	test("validates cron expressions", () => {
		expect(isValidCronExpr("0 8,20 * * *")).toBe(true);
		expect(isValidCronExpr("*/5 * * * *")).toBe(true);
		expect(isValidCronExpr("0-10/2 8 * * 1-5")).toBe(true);
		expect(isValidCronExpr("5,10,15 9-10 * * 1,3,5")).toBe(true);
		expect(isValidCronExpr("0 25 * * *")).toBe(false);
		expect(isValidCronExpr("*/0 * * * *")).toBe(false);
		expect(isValidCronExpr("60 * * * *")).toBe(false);
		expect(isValidCronExpr("1-70 * * * *")).toBe(false);
		expect(isValidCronExpr("0 8 * *")).toBe(false);
	});

	test("calculates next cron run in UTC", () => {
		const from = new Date("2026-02-21T07:30:00.000Z");
		expect(calculateNextCronRun("0 8,20 * * *", from)).toBe("2026-02-21 08:00:00");
	});

	test("calculates next cron run for range/step and exact values", () => {
		const from = new Date("2026-02-21T08:09:00.000Z");
		expect(calculateNextCronRun("10-12 8 * * *", from)).toBe("2026-02-21 08:10:00");
		expect(calculateNextCronRun("*/15 8 * * *", from)).toBe("2026-02-21 08:15:00");
		expect(calculateNextCronRun("11 8 * * *", from)).toBe("2026-02-21 08:11:00");
	});

	test("returns null for invalid or unsatisfiable cron expressions", () => {
		const from = new Date("2026-01-01T00:00:00.000Z");
		expect(calculateNextCronRun("0 8 * *", from)).toBeNull();
		expect(calculateNextCronRun("0,,5 * * * *", from)).toBeNull();
		expect(calculateNextCronRun("abc/5 * * * *", from)).toBeNull();
		expect(calculateNextCronRun("60-70/2 * * * *", from)).toBeNull();
		// February 31st cannot occur, so no match in the one-year search window.
		expect(calculateNextCronRun("0 0 31 2 *", from)).toBeNull();
	});

	test("calculates next run for recurring and once", () => {
		const from = new Date("2026-02-21T07:30:00.000Z");
		expect(calculateNextRun({ schedule_type: "once", schedule_value: "0s" }, from)).toBeNull();
		expect(calculateNextRun({ schedule_type: "recurring", schedule_value: "30m" }, from)).toBe(
			"2026-02-21 08:00:00",
		);
		expect(calculateNextRun({ schedule_type: "recurring", schedule_value: "bad" }, from)).toBeNull();
		expect(calculateNextRun({ schedule_type: "cron", schedule_value: "0 8 * * *" }, from)).toBe(
			"2026-02-21 08:00:00",
		);
	});
});
