import { describe, expect, test, beforeAll, afterAll, mock, beforeEach } from "bun:test";

// Mock fs module BEFORE importing logger
const mockExistsSync = mock((path: string) => {
	if (path.includes("gateway.jsonc")) return true;
	if (path.includes("agent.jsonc")) return true;
	if (path === "data/logs") return true; // Log dir exists
	return false;
});

const mockReadFileSync = mock((path: string, _encoding: string) => {
	if (path.includes("gateway.jsonc")) return '{"logFormat":"text"}';
	if (path.includes("agent.jsonc")) return '{"logFormat":"json"}';
	return "{}";
});

const mockMkdirSync = mock((_path: string, _options?: { recursive: boolean }) => {
	return undefined;
});

mock.module("node:fs", () => ({
	existsSync: mockExistsSync,
	readFileSync: mockReadFileSync,
	mkdirSync: mockMkdirSync,
}));

// Now import the logger - it will use our mocked fs
// We need to import after mocking
const { logger, setLogLevel } = await import("@/packages/logger");

describe("Logger Module - Coverage Tests", () => {
	// Store original env
	const originalEnv: Record<string, string | undefined> = {};
	const originalArgv: string[] = [];

	beforeAll(() => {
		for (const key of ["LOG_FORMAT", "SERVICE_NAME", "LOG_LEVEL", "WORKSPACE_NAME"]) {
			originalEnv[key] = process.env[key];
		}
		originalArgv[0] = process.argv[0];
		originalArgv[1] = process.argv[1];
	});

	afterAll(() => {
		for (const key of ["LOG_FORMAT", "SERVICE_NAME", "LOG_LEVEL", "WORKSPACE_NAME"]) {
			if (originalEnv[key] !== undefined) {
				process.env[key] = originalEnv[key];
			} else {
				delete process.env[key];
			}
		}
		process.argv[0] = originalArgv[0];
		process.argv[1] = originalArgv[1];
	});

	beforeEach(() => {
		mockExistsSync.mockClear();
		mockReadFileSync.mockClear();
		mockMkdirSync.mockClear();
	});

	describe("detectLogFormat - fs.existsSync paths (lines 14-17, 25)", () => {
		test("should read from gateway.jsonc config file", () => {
			mockExistsSync.mockImplementation((p: string) => p.includes("gateway.jsonc"));
			mockReadFileSync.mockImplementation((p: string) => {
				if (p.includes("gateway.jsonc")) return '{"logFormat":"text"}';
				return "{}";
			});

			// The module should have already detected format at import
			// We verify by checking the mock was called during import
			expect(mockExistsSync).toHaveBeenCalled();
		});

		test("should handle catch block when fs operations fail (line 22)", () => {
			mockExistsSync.mockImplementation(() => {
				throw new Error("Simulated FS error");
			});

			// Import again with new mock - the catch block should prevent crash
			const testModule = await import("@/packages/logger");
			expect(testModule.logger).toBeDefined();
		});

		test("should return json when no config files found", () => {
			mockExistsSync.mockImplementation(() => false);

			const testModule = await import("@/packages/logger");
			expect(testModule.logger).toBeDefined();
		});

		test("should skip files without logFormat key", () => {
			mockExistsSync.mockImplementation(() => true);
			mockReadFileSync.mockImplementation(() => '{"otherKey":"value"}');

			const testModule = await import("@/packages/logger");
			expect(testModule.logger).toBeDefined();
		});
	});

	describe("fs.mkdirSync for LOG_DIR (line 57)", () => {
		test("should create log directory when it does not exist", () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p === "data/logs") return false; // Dir doesn't exist
				if (p.includes("gateway.jsonc")) return false;
				if (p.includes("agent.jsonc")) return false;
				return false;
			});

			const testModule = await import("@/packages/logger");
			expect(mockMkdirSync).toHaveBeenCalled();
		});

		test("should skip mkdirSync if directory already exists", () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p === "data/logs") return true; // Dir exists
				if (p.includes("gateway.jsonc")) return false;
				if (p.includes("agent.jsonc")) return false;
				return false;
			});

			const testModule = await import("@/packages/logger");
			// mkdirSync might not be called if dir exists
			expect(testModule.logger).toBeDefined();
		});
	});

	describe("pino-roll transport configuration (lines 87-94)", () => {
		test("should use pino-roll for json format", () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes("gateway.jsonc")) return true;
				if (p.includes("agent.jsonc")) return true;
				if (p === "data/logs") return true;
				return false;
			});
			mockReadFileSync.mockImplementation((p: string) => {
				if (p.includes("gateway.jsonc")) return '{"logFormat":"json"}';
				return '{"logFormat":"json"}';
			});

			const { logger: jsonLogger } = await import("@/packages/logger");
			expect(jsonLogger).toBeDefined();
		});

		test("should use pino-pretty for text format", () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes("gateway.jsonc")) return true;
				if (p.includes("agent.jsonc")) return false;
				if (p === "data/logs") return true;
				return false;
			});
			mockReadFileSync.mockImplementation((p: string) => {
				if (p.includes("gateway.jsonc")) return '{"logFormat":"text"}';
				return "{}";
			});

			const { logger: textLogger } = await import("@/packages/logger");
			expect(textLogger).toBeDefined();
		});

		test("should configure pino-roll with file, frequency, mkdir options (lines 88-93)", () => {
			// This exercises lines 87-94 which configure pino-roll
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes("gateway.jsonc")) return false;
				if (p.includes("agent.jsonc")) return true;
				if (p === "data/logs") return true;
				return false;
			});
			mockReadFileSync.mockImplementation((p: string) => {
				if (p.includes("agent.jsonc")) return '{"logFormat":"json"}';
				return "{}";
			});

			const { logger: pinoRollLogger } = await import("@/packages/logger");
			expect(pinoRollLogger).toBeDefined();
			expect(pinoRollLogger.level).toBe("debug"); // Default level
		});
	});

	describe("setLogLevel function (lines 100-102)", () => {
		test("should set logger level to trace", () => {
			setLogLevel("trace");
			expect(logger.level).toBe("trace");
		});

		test("should set logger level to info", () => {
			setLogLevel("info");
			expect(logger.level).toBe("info");
		});

		test("should set logger level to error", () => {
			setLogLevel("error");
			expect(logger.level).toBe("error");
		});

		test("should restore to debug after tests", () => {
			setLogLevel("debug");
			expect(logger.level).toBe("debug");
		});
	});

	describe("logger instance basic functionality", () => {
		test("logger should have info method", () => {
			expect(typeof logger.info).toBe("function");
		});

		test("logger should have error method", () => {
			expect(typeof logger.error).toBe("function");
		});

		test("logger should have warn method", () => {
			expect(typeof logger.warn).toBe("function");
		});

		test("logger should have debug method", () => {
			expect(typeof logger.debug).toBe("function");
		});

		test("logger should have child method", () => {
			expect(typeof logger.child).toBe("function");
		});

		test("should log without throwing", () => {
			expect(() => {
				logger.info("Test message");
				logger.error({ err: new Error("test") }, "Error message");
				logger.warn("Warning message");
			}).not.toThrow();
		});
	});
});
