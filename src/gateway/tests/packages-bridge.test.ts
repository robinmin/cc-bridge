import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { mapWithConcurrency } from "@/packages/async";
import { deepMerge, isRecord, loadConfig } from "@/packages/config";
import { createLogger, detectLogFormat, detectServiceName, setLogLevel } from "@/packages/logger";
import {
	calculateNextCronRun,
	calculateNextRun,
	isValidCronExpr,
	isValidRecurringScheduleValue,
	recurringIntervalMs,
	toSqlNow,
} from "@/packages/scheduler";
import { splitTextChunks } from "@/packages/text";
import { getMissingRequiredFields } from "@/packages/validation";

describe("packages bridge coverage (gateway run)", () => {
	afterEach(() => {
		delete process.env.LOG_FORMAT;
		delete process.env.SERVICE_NAME;
		delete process.env.LOG_LEVEL;
	});

	test("covers async/text/validation helpers", async () => {
		const mapped = await mapWithConcurrency([1, 2, 3], 2, async (n, i) => `${i}:${n * 2}`);
		expect(mapped).toEqual(["0:2", "1:4", "2:6"]);
		expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);

		expect(splitTextChunks("a\nb\nc", 3).length).toBeGreaterThan(1);
		expect(splitTextChunks("x".repeat(10), 3).every((chunk) => chunk.length <= 3)).toBe(true);
		expect(splitTextChunks("   ", 5)).toEqual([]);

		expect(
			getMissingRequiredFields(
				{ a: "ok", b: "", c: "   ", d: 1 },
				["a", "b", "c", "d"],
			),
		).toEqual(["b", "c", "d"]);
	});

	test("covers config helpers and loading branches", () => {
		expect(isRecord({ a: 1 })).toBe(true);
		expect(isRecord(null)).toBe(false);
		expect(isRecord([])).toBe(false);
		expect(deepMerge("default", "parsed")).toBe("parsed");
		expect(
			deepMerge(
				{ nested: { keep: 1, override: 0 }, top: "x" },
				{ nested: { override: 2 } },
			),
		).toEqual({ nested: { keep: 1, override: 2 }, top: "x" });

		const existsSpy = spyOn(fs, "existsSync").mockImplementation((p) => String(p).includes("exists"));
		const readSpy = spyOn(fs, "readFileSync")
			.mockReturnValueOnce('{"a":2}')
			.mockImplementationOnce(() => {
				throw new Error("read failed");
			});

		expect(loadConfig("/tmp/exists.jsonc", { a: 1 })).toEqual({ a: 2 });
		expect(loadConfig("/tmp/missing.jsonc", { a: 1 })).toEqual({ a: 1 });
		expect(loadConfig("/tmp/exists-read-error.jsonc", { a: 1 })).toEqual({ a: 1 });

		existsSpy.mockRestore();
		readSpy.mockRestore();
	});

	test("covers logger helper branches", () => {
		process.env.LOG_FORMAT = "text";
		expect(detectLogFormat()).toBe("text");
		delete process.env.LOG_FORMAT;

		const existsSpy = spyOn(fs, "existsSync").mockImplementation((p) => String(p).includes("gateway.jsonc"));
		const readSpy = spyOn(fs, "readFileSync").mockReturnValue('{"logFormat":"json"}');
		expect(detectLogFormat()).toBe("json");
		existsSpy.mockRestore();
		readSpy.mockRestore();

		const mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
		const existsSpy2 = spyOn(fs, "existsSync").mockReturnValue(false);
		createLogger("gateway", "json");
		expect(mkdirSpy).toHaveBeenCalled();
		existsSpy2.mockRestore();
		mkdirSpy.mockRestore();

		process.env.SERVICE_NAME = "custom-service";
		expect(detectServiceName()).toBe("custom-service");
		delete process.env.SERVICE_NAME;
		const prevArgv = process.argv[1];
		process.argv[1] = "/tmp/gateway/main.ts";
		expect(detectServiceName()).toBe("gateway");
		process.argv[1] = prevArgv;

		const l = createLogger("gateway", "json");
		expect(() => l.info("hello")).not.toThrow();
		setLogLevel("trace");
		setLogLevel("info");
		setLogLevel("debug");
	});

	test("covers scheduler helpers", () => {
		expect(toSqlNow()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		expect(isValidRecurringScheduleValue("5m")).toBe(true);
		expect(isValidRecurringScheduleValue("0m")).toBe(false);
		expect(recurringIntervalMs("2s")).toBe(2000);
		expect(recurringIntervalMs("2h")).toBe(7200000);
		expect(recurringIntervalMs("2d")).toBe(172800000);
		expect(recurringIntervalMs("bad")).toBeNull();

		expect(isValidCronExpr("0 8,20 * * *")).toBe(true);
		expect(isValidCronExpr("0-10/2 8 * * 1-5")).toBe(true);
		expect(isValidCronExpr("*/0 * * * *")).toBe(false);
		expect(isValidCronExpr("1-70 * * * *")).toBe(false);
		expect(isValidCronExpr("0 25 * * *")).toBe(false);
		const from = new Date("2026-02-21T07:30:00.000Z");
		expect(calculateNextCronRun("0 8,20 * * *", from)).toBe("2026-02-21 08:00:00");
		expect(calculateNextCronRun("10-12 8 * * *", new Date("2026-02-21T08:09:00.000Z"))).toBe("2026-02-21 08:10:00");
		expect(calculateNextCronRun("*/15 8 * * *", new Date("2026-02-21T08:09:00.000Z"))).toBe("2026-02-21 08:15:00");
		expect(calculateNextCronRun("abc/5 * * * *", from)).toBeNull();
		expect(calculateNextCronRun("0,,5 * * * *", from)).toBeNull();
		expect(calculateNextCronRun("0 0 31 2 *", from)).toBeNull();
		expect(calculateNextRun({ schedule_type: "once", schedule_value: "1m" }, from)).toBeNull();
		expect(calculateNextRun({ schedule_type: "recurring", schedule_value: "30m" }, from)).toBe(
			"2026-02-21 08:00:00",
		);
		expect(calculateNextRun({ schedule_type: "cron", schedule_value: "0 8 * * *" }, from)).toBe(
			"2026-02-21 08:00:00",
		);
	});
});
