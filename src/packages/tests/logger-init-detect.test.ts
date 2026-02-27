import { describe, expect, test } from "bun:test";
import { logger } from "@/packages/logger";

describe("Logger Initialization - detectLogFormat paths (safe)", () => {
	test("logger should be initialized", () => {
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
	});

	test("logger child method should work", () => {
		const child = logger.child({ component: "test" });
		expect(child).toBeDefined();
	});
});
