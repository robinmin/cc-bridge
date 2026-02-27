import { describe, expect, test } from "bun:test";
import { logger, setLogLevel } from "@/packages/logger";

describe("Logger Initialization - pino-roll transport (safe)", () => {
	test("logger should be available", () => {
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
	});

	test("setLogLevel should change logger level", () => {
		const prev = logger.level;
		setLogLevel("info");
		expect(logger.level).toBe("info");
		setLogLevel(prev as never);
	});
});
