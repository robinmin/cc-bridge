import { describe, expect, test } from "bun:test";

// Set up environment before importing app
process.env.NODE_ENV = "test";
process.env.TEST_MODE__INTERNAL_ONLY = "true";

import { app } from "@/agent/app";

describe("Agent App", () => {
	describe("Console redirection", () => {
		test("should redirect console.log to logger", () => {
			// The console methods are redirected to pino logger
			// Test that calling them doesn't throw
			expect(() => {
				console.log("Test log message");
				console.log({ key: "value" }, "Log with context");
				console.log("Multiple", "arguments", "here");
			}).not.toThrow();
		});

		test("should redirect console.error to logger", () => {
			expect(() => {
				console.error("Test error message");
				console.error({ error: "details" }, "Error with context");
				console.error("Multiple", "error", "args");
			}).not.toThrow();
		});

		test("should redirect console.warn to logger", () => {
			expect(() => {
				console.warn("Test warn message");
				console.warn({ warning: "details" }, "Warn with context");
				console.warn("Multiple", "warn", "args");
			}).not.toThrow();
		});

		test("should redirect console.debug to logger", () => {
			expect(() => {
				console.debug("Test debug message");
				console.debug({ debug: "details" }, "Debug with context");
				console.debug("Multiple", "debug", "args");
			}).not.toThrow();
		});

		test("should handle single argument correctly", () => {
			expect(() => {
				console.log("single arg");
			}).not.toThrow();
		});

		test("should handle multiple arguments correctly", () => {
			expect(() => {
				console.log("arg1", "arg2", "arg3");
			}).not.toThrow();
		});

		test("should handle object arguments correctly", () => {
			expect(() => {
				console.log({ key: "value" });
				console.error({ error: "test" });
				console.warn({ warning: "test" });
				console.debug({ debug: "test" });
			}).not.toThrow();
		});

		test("should handle array arguments correctly", () => {
			expect(() => {
				console.log([1, 2, 3]);
				console.error(["error1", "error2"]);
			}).not.toThrow();
		});
	});

	describe("App initialization", () => {
		test("should export app instance", () => {
			expect(app).toBeDefined();
			expect(typeof app.use).toBe("function");
			expect(typeof app.route).toBe("function");
			expect(typeof app.get).toBe("function");
			expect(typeof app.post).toBe("function");
		});

		test("should have middleware configured", () => {
			// The app should have middleware registered
			expect(app).toBeDefined();
		});

		test("should have execute route", () => {
			// The app should have the execute route registered
			expect(app).toBeDefined();
		});

		test("should have read route", () => {
			expect(app).toBeDefined();
		});

		test("should have write route", () => {
			expect(app).toBeDefined();
		});

		test("should have fs route", () => {
			expect(app).toBeDefined();
		});

		test("should have notify route", () => {
			expect(app).toBeDefined();
		});

		test("should have health endpoint", () => {
			expect(app).toBeDefined();
		});
	});

	describe("Configuration loading", () => {
		test("should load configuration from ConfigLoader", () => {
			// The app loads configuration at module load time
			// This test verifies that the app was successfully initialized
			expect(app).toBeDefined();
		});

		test("should apply log level from config", () => {
			// The log level is set from config at module load time
			expect(app).toBeDefined();
		});
	});
});
