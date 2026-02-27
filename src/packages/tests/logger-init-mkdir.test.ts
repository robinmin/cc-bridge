import { describe, expect, test } from "bun:test";
import { logger } from "@/packages/logger";

describe("Logger Initialization - mkdir path (safe)", () => {
	test("logger module should be defined", () => {
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
	});
});
