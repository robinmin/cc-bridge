import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

describe("logger real late coverage", () => {
	const originalEnv = {
		LOG_FORMAT: process.env.LOG_FORMAT,
		SERVICE_NAME: process.env.SERVICE_NAME,
		LOG_LEVEL: process.env.LOG_LEVEL,
	};
	const originalArgv1 = process.argv[1];

	afterEach(() => {
		if (originalEnv.LOG_FORMAT === undefined) delete process.env.LOG_FORMAT;
		else process.env.LOG_FORMAT = originalEnv.LOG_FORMAT;
		if (originalEnv.SERVICE_NAME === undefined) delete process.env.SERVICE_NAME;
		else process.env.SERVICE_NAME = originalEnv.SERVICE_NAME;
		if (originalEnv.LOG_LEVEL === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = originalEnv.LOG_LEVEL;
		process.argv[1] = originalArgv1;
	});

	test("covers detectLogFormat branches on real module", async () => {
		const { detectLogFormat } = await import("@/packages/logger/index.ts");
		process.env.LOG_FORMAT = "text";
		expect(detectLogFormat()).toBe("text");
		delete process.env.LOG_FORMAT;

		const originalExists = fs.existsSync;
		const originalRead = fs.readFileSync;
		(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = ((p: fs.PathLike) =>
			String(p).includes("gateway.jsonc")) as typeof fs.existsSync;
		(fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync =
			((p: fs.PathOrFileDescriptor) =>
				String(p).includes("gateway.jsonc") ? '{"logFormat":"json"}' : "{}") as typeof fs.readFileSync;
		expect(detectLogFormat()).toBe("json");
		(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = (() => {
			throw new Error("boom");
		}) as typeof fs.existsSync;
		expect(detectLogFormat()).toBe("json");
		(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = originalExists;
		(fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalRead;
	});

	test("covers detectServiceName branches on real module", async () => {
		const { detectServiceName } = await import("@/packages/logger/index.ts");
		process.env.SERVICE_NAME = "custom";
		expect(detectServiceName()).toBe("custom");
		delete process.env.SERVICE_NAME;

		process.argv[1] = "/tmp/gateway/main.ts";
		expect(detectServiceName()).toBe("gateway");
		process.argv[1] = "/tmp/agent/main.ts";
		expect(detectServiceName()).toBe("agent");
		process.argv[1] = "/tmp/unknown/main.ts";
		expect(detectServiceName()).toBe("unknown");
	});

	test("covers createLogger and setLogLevel on real module", async () => {
		const { createLogger, logger, setLogLevel } = await import("@/packages/logger/index.ts");
		const originalExists = fs.existsSync;
		const originalMkdir = fs.mkdirSync;
		(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = (() => false) as typeof fs.existsSync;
		(fs as unknown as { mkdirSync: typeof fs.mkdirSync }).mkdirSync = (() => undefined) as typeof fs.mkdirSync;
		expect(createLogger("gateway", "json")).toBeDefined();
		expect(createLogger("agent", "text")).toBeDefined();
		(fs as unknown as { existsSync: typeof fs.existsSync }).existsSync = originalExists;
		(fs as unknown as { mkdirSync: typeof fs.mkdirSync }).mkdirSync = originalMkdir;

		expect(() => setLogLevel("info")).not.toThrow();
		if (typeof logger.level === "string") setLogLevel(logger.level);
	});
});
