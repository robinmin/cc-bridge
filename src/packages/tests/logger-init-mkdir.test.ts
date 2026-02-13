import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// Set environment BEFORE any mock setup
// This test file tests mkdirSync being called when LOG_DIR doesn't exist (line 57)
const originalLogFormat = process.env.LOG_FORMAT;
const originalLogLevel = process.env.LOG_LEVEL;

// Mock setup - log dir does NOT exist to trigger mkdirSync
const mockMkdirSync = mock((_path: string, _options?: { recursive: boolean }) => undefined);

const mockExistsSync = mock((path: string) => {
	if (path === "data/logs") return false; // Log dir DOESN'T exist - triggers mkdirSync
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

describe("Logger Initialization - mkdirSync path (line 57)", () => {
	let logger: typeof import("@/packages/logger").logger;

	beforeAll(async () => {
		// Set env before import
		process.env.LOG_FORMAT = "text"; // Use text format (pino-pretty)
		delete process.env.LOG_LEVEL;

		// Dynamic import AFTER mock is set up
		const module = await import("@/packages/logger");
		logger = module.logger;
	});

	test("logger module should be defined", () => {
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
	});

	test("mkdirSync should have been called with correct path and options", () => {
		// Since log dir didn't exist, mkdirSync should have been called
		expect(mockMkdirSync).toHaveBeenCalledWith("data/logs", { recursive: true });
	});

	test("logger should work correctly", () => {
		expect(() => {
			logger.info("Test message");
		}).not.toThrow();
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
