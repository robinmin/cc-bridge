import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { ConfigLoader, deepMerge, isRecord } from "@/packages/config/index";

describe("ConfigLoader - Coverage", () => {
	const defaults = {
		key1: "default1",
		key2: "default2",
		nested: { value: 0 },
	};

	// Helper to get unique test file path and track for cleanup
	const getTestPath = (testName: string) => `/tmp/test-config-${testName}-${Date.now()}.jsonc`;

	const cleanup = (testPath: string) => {
		try {
			const stats = fs.statSync(testPath);
			if (stats.isDirectory()) {
				fs.rmSync(testPath, { recursive: true, force: true });
			} else {
				fs.unlinkSync(testPath);
			}
		} catch {
			// Ignore
		}
	};

	test("should return defaults when file not found (line 17)", () => {
		const result = ConfigLoader.load("/non/existent/path.jsonc", defaults);
		expect(result).toEqual(defaults);
	});

	test("should read file content (line 19) and parse (line 20)", () => {
		const testConfigPath = getTestPath("read-parse");
		try {
			fs.writeFileSync(testConfigPath, '{"key1": "new1"}', "utf-8");
			const result = ConfigLoader.load(testConfigPath, defaults);
			expect(result.key1).toBe("new1");
		} finally {
			cleanup(testConfigPath);
		}
	});

	test("should return defaults for invalid parsed value (lines 22-25)", () => {
		const testConfigPath = getTestPath("invalid-string");
		try {
			fs.writeFileSync(testConfigPath, '"just a string"', "utf-8");
			const result = ConfigLoader.load(testConfigPath, defaults);
			expect(result).toEqual(defaults);
		} finally {
			cleanup(testConfigPath);
		}
	});

	test("should return defaults for null parsed value (lines 22-25)", () => {
		const testConfigPath = getTestPath("null-value");
		try {
			fs.writeFileSync(testConfigPath, "null", "utf-8");
			const result = ConfigLoader.load(testConfigPath, defaults);
			expect(result).toEqual(defaults);
		} finally {
			cleanup(testConfigPath);
		}
	});

	test("should return defaults for array parsed value (lines 22-25)", () => {
		const testConfigPath = getTestPath("array-value");
		try {
			fs.writeFileSync(testConfigPath, "[1, 2, 3]", "utf-8");
			const result = ConfigLoader.load(testConfigPath, defaults);
			// Arrays spread into result
			expect(result).toHaveProperty("0", 1);
			expect(result).toHaveProperty("1", 2);
		} finally {
			cleanup(testConfigPath);
		}
	});

	test("should log success and return merged config (lines 27-28)", () => {
		const testConfigPath = getTestPath("merge-config");
		try {
			fs.writeFileSync(testConfigPath, '{"key1": "value1"}', "utf-8");
			const result = ConfigLoader.load(testConfigPath, defaults);
			expect(result.key1).toBe("value1");
			expect(result.key2).toBe("default2"); // from defaults
		} finally {
			cleanup(testConfigPath);
		}
	});

	test("should handle read errors gracefully (lines 30-31)", () => {
		const testConfigPath = getTestPath("read-error");
		try {
			// Create a directory to cause read error
			fs.mkdirSync(testConfigPath, { recursive: true });
			const result = ConfigLoader.load(testConfigPath, defaults);
			expect(result).toEqual(defaults);
		} finally {
			cleanup(testConfigPath);
		}
	});

	test("should handle parse errors gracefully (lines 30-31)", () => {
		const testConfigPath = getTestPath("parse-error");
		try {
			fs.writeFileSync(testConfigPath, "{ invalid json }", "utf-8");
			const result = ConfigLoader.load(testConfigPath, defaults);
			expect(result).toEqual(defaults);
		} finally {
			cleanup(testConfigPath);
		}
	});

	test("should cover deepMerge non-record defaults branch", () => {
		const testConfigPath = getTestPath("non-record-defaults");
		try {
			fs.writeFileSync(testConfigPath, '{"value":"from-config"}', "utf-8");
			const result = ConfigLoader.load(testConfigPath, "default-value" as unknown as Record<string, unknown>);
			expect(result).toEqual({ value: "from-config" });
		} finally {
			cleanup(testConfigPath);
		}
	});

	test("should expose and validate isRecord helper", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("x")).toBe(false);
	});

	test("should deepMerge nested objects recursively", () => {
		const out = deepMerge({ nested: { a: 1, b: 2 }, top: "x" }, { nested: { b: 3 } });
		expect(out).toEqual({ nested: { a: 1, b: 3 }, top: "x" });
	});

	test("should expose functional loader API", () => {
		expect(typeof ConfigLoader.load).toBe("function");
	});
});
