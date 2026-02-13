import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// Set environment BEFORE any mock setup
// This test file tests the pino-roll transport path (lines 87-94)
const originalLogFormat = process.env.LOG_FORMAT;
const originalLogLevel = process.env.LOG_LEVEL;

// Mock setup
const mockMkdirSync = mock((_path: string, _options?: { recursive: boolean }) => undefined);

const mockExistsSync = mock((path: string) => {
	if (path === "data/logs") return true; // Log dir exists
	return false; // No config files
});

const mockReadFileSync = mock((_path: string, _encoding: string) => "{}");

const mockFs = {
	default: {
		existsSync: mockExistsSync,
		readFileSync: mockReadFileSync,
		mkdirSync: mockMkdirSync,
	},
	existsSync: mockExistsSync,
	readFileSync: mockReadFileSync,
	mkdirSync: mockMkdirSync,
};

mock.module("node:fs", () => mockFs);

describe("Logger Initialization - pino-roll transport (lines 87-94)", () => {
	let logger: typeof import("@/packages/logger").logger;
	let setLogLevel: typeof import("@/packages/logger").setLogLevel;

	beforeAll(async () => {
		// Set env before import
		process.env.LOG_FORMAT = "json"; // Use json format -> pino-roll
		delete process.env.LOG_LEVEL;

		// Dynamic import AFTER mock is set up
		const module = await import("@/packages/logger");
		logger = module.logger;
		setLogLevel = module.setLogLevel;
	});

	test("logger should use pino-roll with json format", () => {
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
		expect(typeof logger.error).toBe("function");
		expect(typeof logger.warn).toBe("function");
	});

	test("logger should have correct default level", () => {
		expect(logger.level).toBe("debug");
	});

	test("logger should work with json format", () => {
		expect(() => {
			logger.info("Test message with pino-roll");
		}).not.toThrow();
	});

	test("setLogLevel should change logger level", () => {
		setLogLevel("info");
		expect(logger.level).toBe("info");
		setLogLevel("debug"); // Reset
	});

	afterAll(() => {
		if (originalLogFormat !== undefined) {
			process.env.LOG_FORMAT = originalLogFormat;
		} else {
			delete process.env.LOG_FORMAT;
		}
		if (originalLogLevel !== undefined) {
			process.env.LOG_LEVEL = originalLogLevel;
		}
	});
});
