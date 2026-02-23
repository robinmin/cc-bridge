import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createLogger, detectLogFormat, detectServiceName, logger, setLogLevel } from "@/packages/logger";

const ORIGINAL_ENV = {
	LOG_FORMAT: process.env.LOG_FORMAT,
	SERVICE_NAME: process.env.SERVICE_NAME,
};
const ORIGINAL_ARGV1 = process.argv[1];

afterEach(() => {
	if (ORIGINAL_ENV.LOG_FORMAT === undefined) delete process.env.LOG_FORMAT;
	else process.env.LOG_FORMAT = ORIGINAL_ENV.LOG_FORMAT;

	if (ORIGINAL_ENV.SERVICE_NAME === undefined) delete process.env.SERVICE_NAME;
	else process.env.SERVICE_NAME = ORIGINAL_ENV.SERVICE_NAME;

	process.argv[1] = ORIGINAL_ARGV1;
});

describe("logger real coverage branches", () => {
	test("covers detectLogFormat config-file loop and fallback branches", () => {
		delete process.env.LOG_FORMAT;
		const originalExists = fs.existsSync;
		const originalRead = fs.readFileSync;
		let readCount = 0;

		(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = ((p: fs.PathLike) => {
			const s = String(p);
			if (s.includes("gateway.jsonc")) return true;
			if (s.includes("agent.jsonc")) return true;
			return originalExists(p);
		}) as typeof fs.existsSync;
		(fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((p: fs.PathLike) => {
			readCount++;
			if (String(p).includes("gateway.jsonc")) return '{"logFormat":"json"}';
			return originalRead(p) as string;
		}) as typeof fs.readFileSync;

		try {
			expect(detectLogFormat()).toBe("json");
			expect(readCount).toBeGreaterThan(0);
		} finally {
			(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = originalExists;
			(fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalRead;
		}
	});

	test("covers createLogger json transport branch", () => {
		const logger = createLogger("gateway", "json");
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
	});

	test("covers detectServiceName env and unknown branches", () => {
		process.env.SERVICE_NAME = "svc";
		expect(detectServiceName()).toBe("svc");
		delete process.env.SERVICE_NAME;
		process.argv[1] = "/tmp/not-a-known-service/main.ts";
		expect(detectServiceName()).toBe("unknown");
	});

	test("covers setLogLevel on singleton logger", () => {
		const original = logger.level;
		setLogLevel("warn");
		expect(logger.level).toBe("warn");
		setLogLevel(original);
	});
});
