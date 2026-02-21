import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// Set environment BEFORE any mock setup
// This test file tests detectLogFormat reading from config files (lines 12-25)
const originalLogFormat = process.env.LOG_FORMAT;
const originalLogLevel = process.env.LOG_LEVEL;

// Mock setup - config files exist with logFormat
const mockMkdirSync = mock((_path: string, _options?: { recursive: boolean }) => undefined);

const mockExistsSync = mock((path: string) => {
	if (path === "data/logs") return true; // Log dir exists
	if (path.includes("gateway.jsonc")) return true; // Gateway config exists
	if (path.includes("agent.jsonc")) return true; // Agent config exists
	return false;
});

const mockReadFileSync = mock((path: string, _encoding: string) => {
	if (path.includes("gateway.jsonc")) return '{"logFormat": "text"}';
	if (path.includes("agent.jsonc")) return '{"logFormat": "json"}';
	return "{}";
});

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

describe("Logger Initialization - detectLogFormat paths (lines 12-25)", () => {
	let logger: typeof import("@/packages/logger").logger;

	beforeAll(async () => {
		// Set env before import
		delete process.env.LOG_FORMAT; // Clear to test file detection
		delete process.env.LOG_LEVEL;

		// Dynamic import AFTER mock is set up
		const module = await import("../logger/index.ts?case=logger-init-detect");
		logger = module.logger;
	});

	test("logger should be initialized with config file detection", () => {
		// With our mocks, gateway.jsonc exists and has logFormat: text
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
	});

	test("existsSync should have been called for config paths", () => {
		// The detectLogFormat function should check config paths
		expect(mockExistsSync).toHaveBeenCalled();
	});

	test("readFileSync should have been called for gateway config", () => {
		// Should read gateway.jsonc to find logFormat
		expect(mockReadFileSync).toHaveBeenCalled();
	});

	test("logger methods should work correctly", () => {
		expect(() => {
			logger.info("Test info message");
			logger.warn("Test warn message");
			logger.error("Test error message");
		}).not.toThrow();
	});

	test("logger should have child method", () => {
		expect(typeof logger.child).toBe("function");
		const childLogger = logger.child({ component: "test" });
		expect(childLogger).toBeDefined();
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
