import { afterEach, describe, expect, test } from "bun:test";
import {
	isTestMode,
	TEST_MODE__INTERNAL_ONLY,
	validateDirPath,
	validatePath,
	validateTestMode,
} from "@/agent/utils/path-utils";

const ENV_KEYS = ["NODE_ENV", "TEST_MODE__INTERNAL_ONLY", "WORKSPACE_NAME"] as const;

const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

function restoreEnv(): void {
	for (const [key, value] of originalEnv.entries()) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

afterEach(() => {
	restoreEnv();
});

describe("path-utils", () => {
	test("isTestMode should return true only in test environment with flag", () => {
		process.env.NODE_ENV = "test";
		process.env.TEST_MODE__INTERNAL_ONLY = "true";
		expect(isTestMode()).toBe(true);
		expect(TEST_MODE__INTERNAL_ONLY()).toBe(true);

		process.env.TEST_MODE__INTERNAL_ONLY = "false";
		expect(isTestMode()).toBe(false);
	});

	test("validateTestMode should throw when internal test mode flag is set outside test env", () => {
		process.env.NODE_ENV = "production";
		process.env.TEST_MODE__INTERNAL_ONLY = "true";
		expect(() => validateTestMode()).toThrow(/can only be enabled in test environment/i);
	});

	test("validatePath should allow any path in test mode", () => {
		process.env.NODE_ENV = "test";
		process.env.TEST_MODE__INTERNAL_ONLY = "true";
		expect(validatePath("../../outside")).toBeDefined();
	});

	test("validatePath should allow exact workspace root in normal mode", () => {
		process.env.NODE_ENV = "production";
		delete process.env.TEST_MODE__INTERNAL_ONLY;
		process.env.WORKSPACE_NAME = "alpha";
		expect(validatePath("/workspaces/alpha")).toBe("/workspaces/alpha");
	});

	test("validatePath should allow workspace child path in normal mode", () => {
		process.env.NODE_ENV = "production";
		delete process.env.TEST_MODE__INTERNAL_ONLY;
		process.env.WORKSPACE_NAME = "alpha";
		expect(validatePath("/workspaces/alpha/src/index.ts")).toBe("/workspaces/alpha/src/index.ts");
	});

	test("validatePath should reject path outside workspace in normal mode", () => {
		process.env.NODE_ENV = "production";
		delete process.env.TEST_MODE__INTERNAL_ONLY;
		process.env.WORKSPACE_NAME = "alpha";
		expect(() => validatePath("/workspaces/alphabeta/file.txt")).toThrow(/outside the allowed workspace directory/i);
		expect(() => validatePath("/tmp/file.txt")).toThrow(/outside the allowed workspace directory/i);
	});

	test("validateDirPath should delegate to validatePath", () => {
		process.env.NODE_ENV = "production";
		delete process.env.TEST_MODE__INTERNAL_ONLY;
		process.env.WORKSPACE_NAME = "alpha";
		expect(validateDirPath("/workspaces/alpha/data")).toBe("/workspaces/alpha/data");
	});
});
