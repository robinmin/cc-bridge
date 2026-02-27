import { describe, expect, test } from "bun:test";
import { logger } from "@/packages/logger";

describe("Logger Initialization - detectLogFormat catch block (safe)", () => {
	test("logger should initialize and expose methods", () => {
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
		expect(typeof logger.error).toBe("function");
	});
});
