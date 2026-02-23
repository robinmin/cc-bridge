import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { ConfigLoader, deepMerge, isRecord, loadConfig } from "@/packages/config/index";

describe("ConfigLoader", () => {
	const testConfigPath = "/tmp/test-config.jsonc";
	const defaults = { key1: "default1", key2: "default2", nested: { value: 0 } };

	beforeEach(() => {
		// Clean up any existing test file
		if (fs.existsSync(testConfigPath)) {
			fs.unlinkSync(testConfigPath);
		}
	});

	afterEach(() => {
		// Clean up test file
		if (fs.existsSync(testConfigPath)) {
			fs.unlinkSync(testConfigPath);
		}
	});

	test("should return defaults when config file does not exist", () => {
		const result = ConfigLoader.load(testConfigPath, defaults);
		expect(result).toEqual(defaults);
	});

	test("should load and parse JSONC file", () => {
		const configContent = `
		{
			// This is a comment
			"key1": "value1",
			"key2": "value2"
		}
		`;
		fs.writeFileSync(testConfigPath, configContent, "utf-8");

		const result = ConfigLoader.load(testConfigPath, defaults);

		expect(result.key1).toBe("value1");
		expect(result.key2).toBe("value2");
		expect(result.nested).toEqual(defaults.nested); // Should keep default for unspecified nested
	});

	test("should merge config with defaults", () => {
		const configContent = `{"key1": "overridden"}`;
		fs.writeFileSync(testConfigPath, configContent, "utf-8");

		const result = ConfigLoader.load(testConfigPath, defaults);

		expect(result.key1).toBe("overridden");
		expect(result.key2).toBe("default2"); // Should keep default
	});

	test("should handle empty config file", () => {
		fs.writeFileSync(testConfigPath, "{}", "utf-8");

		const result = ConfigLoader.load(testConfigPath, defaults);

		expect(result).toEqual(defaults);
	});

	test("should handle invalid JSONC gracefully", () => {
		fs.writeFileSync(testConfigPath, "{ invalid json }", "utf-8");

		const result = ConfigLoader.load(testConfigPath, defaults);

		// Should return defaults on parse error
		expect(result).toEqual(defaults);
	});

	test("should handle non-object config gracefully", () => {
		fs.writeFileSync(testConfigPath, '"just a string"', "utf-8");

		const result = ConfigLoader.load(testConfigPath, defaults);

		// Should return defaults when parsed value is not an object
		expect(result).toEqual(defaults);
	});

	test("should handle nested object merging", () => {
		const configContent = `{"nested": {"value": 42}}`;
		fs.writeFileSync(testConfigPath, configContent, "utf-8");

		const result = ConfigLoader.load(testConfigPath, defaults);

		expect(result.nested.value).toBe(42);
	});

	test("should expose functional loader API equivalent to ConfigLoader", () => {
		const configContent = `{"key2": "functional"}`;
		fs.writeFileSync(testConfigPath, configContent, "utf-8");

		expect(loadConfig(testConfigPath, defaults)).toEqual(ConfigLoader.load(testConfigPath, defaults));
	});

	test("should expose isRecord helper behavior", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ key: "value" })).toBe(true);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("x")).toBe(false);
		expect(isRecord([])).toBe(false);
	});

	test("should deepMerge recursively for nested records", () => {
		const result = deepMerge(
			{ nested: { keep: 1, override: 0 }, scalar: "a" },
			{ nested: { override: 2 } },
		);
		expect(result).toEqual({ nested: { keep: 1, override: 2 }, scalar: "a" });
	});

	test("should return parsed value for deepMerge non-record defaults branch", () => {
		expect(deepMerge("default", "parsed")).toBe("parsed");
		expect(deepMerge("default", null)).toBe("default");
	});
});
