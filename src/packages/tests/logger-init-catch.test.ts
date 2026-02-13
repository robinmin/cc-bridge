import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// Set environment BEFORE any mock setup
// This test file tests the catch block in detectLogFormat (lines 21-22,25)
const originalLogFormat = process.env.LOG_FORMAT;
const originalLogLevel = process.env.LOG_LEVEL;

// Mock setup - throw errors to trigger catch block
const mockMkdirSync = mock((_path: string, _options?: { recursive: boolean }) => undefined);

const mockExistsSync = mock((path: string) => {
	if (path === "data/logs") return true; // Log dir exists
	// Throw error when checking config files to trigger catch block
	throw new Error("Simulated fs error for catch block coverage");
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

describe("Logger Initialization - detectLogFormat catch block (lines 21-22,25)", () => {
	let logger: typeof import("@/packages/logger").logger;

	beforeAll(async () => {
		// Set env before import
		delete process.env.LOG_FORMAT; // Clear to test file detection
		delete process.env.LOG_LEVEL;

		// Dynamic import AFTER mock is set up
		const module = await import("@/packages/logger");
		logger = module.logger;
	});

	test("logger should handle fs errors gracefully in detectLogFormat", () => {
		// Even with fs errors, logger should initialize with default format
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
	});

	test("existsSync should have been called (and thrown)", () => {
		expect(mockExistsSync).toHaveBeenCalled();
	});

	test("logger should work with default format after error", () => {
		expect(() => {
			logger.info("Test message after fs error");
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
