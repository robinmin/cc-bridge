import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { createLogger, detectLogFormat, detectServiceName } from "@/packages/logger";

const ORIGINAL_ENV = {
	LOG_FORMAT: process.env.LOG_FORMAT,
	SERVICE_NAME: process.env.SERVICE_NAME,
	LOG_LEVEL: process.env.LOG_LEVEL,
};
const ORIGINAL_ARGV1 = process.argv[1];

afterEach(() => {
	if (ORIGINAL_ENV.LOG_FORMAT === undefined) delete process.env.LOG_FORMAT;
	else process.env.LOG_FORMAT = ORIGINAL_ENV.LOG_FORMAT;

	if (ORIGINAL_ENV.SERVICE_NAME === undefined) delete process.env.SERVICE_NAME;
	else process.env.SERVICE_NAME = ORIGINAL_ENV.SERVICE_NAME;

	if (ORIGINAL_ENV.LOG_LEVEL === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = ORIGINAL_ENV.LOG_LEVEL;

	process.argv[1] = ORIGINAL_ARGV1;
});

describe("logger internals", () => {
	test("detectLogFormat should read from config files when LOG_FORMAT is unset", () => {
		delete process.env.LOG_FORMAT;
		const existsSpy = mock((p: string) => p.includes("gateway.jsonc"));
		const readSpy = mock(() => '{"logFormat":"text"}');
		const originalExists = fs.existsSync;
		const originalRead = fs.readFileSync;

		(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = existsSpy as typeof fs.existsSync;
		(fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = readSpy as typeof fs.readFileSync;
		try {
			expect(detectLogFormat()).toBe("text");
		} finally {
			(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = originalExists;
			(fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalRead;
		}
	});

	test("detectLogFormat should ignore fs errors and return json fallback", () => {
		delete process.env.LOG_FORMAT;
		const originalExists = fs.existsSync;
		(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = (() => {
			throw new Error("boom");
		}) as typeof fs.existsSync;
		try {
			expect(detectLogFormat()).toBe("json");
		} finally {
			(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = originalExists;
		}
	});

	test("detectServiceName should infer gateway/agent/unknown", () => {
		delete process.env.SERVICE_NAME;
		process.argv[1] = "/tmp/gateway/main.ts";
		expect(detectServiceName()).toBe("gateway");
		process.argv[1] = "/tmp/agent/main.ts";
		expect(detectServiceName()).toBe("agent");
		process.argv[1] = "/tmp/other/main.ts";
		expect(detectServiceName()).toBe("unknown");
	});

	test("createLogger should mkdir log dir when missing", () => {
		const originalExists = fs.existsSync;
		const originalMkdir = fs.mkdirSync;
		const existsSpy = mock(() => false);
		const mkdirSpy = mock((_p: string, _opts?: { recursive: boolean }) => undefined);

		(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = existsSpy as typeof fs.existsSync;
		(fs as unknown as { mkdirSync: typeof fs.mkdirSync }).mkdirSync = mkdirSpy as typeof fs.mkdirSync;
		try {
			createLogger("gateway", "json");
			expect(mkdirSpy).toHaveBeenCalled();
		} finally {
			(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = originalExists;
			(fs as unknown as { mkdirSync: typeof fs.mkdirSync }).mkdirSync = originalMkdir;
		}
	});

	test("createLogger should support json and text transports", () => {
		const jsonLogger = createLogger("gateway", "json");
		const textLogger = createLogger("agent", "text");
		expect(jsonLogger).toBeDefined();
		expect(textLogger).toBeDefined();
	});
});
