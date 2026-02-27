import { describe, expect, test } from "bun:test";
import { logger, setLogLevel } from "@/packages/logger";

describe("Logger Module - Coverage Tests (safe)", () => {
	test("logger methods should exist", () => {
		expect(typeof logger.info).toBe("function");
		expect(typeof logger.warn).toBe("function");
		expect(typeof logger.error).toBe("function");
		expect(typeof logger.debug).toBe("function");
		expect(typeof logger.child).toBe("function");
	});

	test("setLogLevel should update level", () => {
		const previous = logger.level;
		setLogLevel("trace");
		expect(logger.level).toBe("trace");
		setLogLevel(previous as never);
	});

	test("logger should log without throwing", () => {
		expect(() => {
			logger.info("info");
			logger.warn("warn");
			logger.error("error");
		}).not.toThrow();
	});
});
