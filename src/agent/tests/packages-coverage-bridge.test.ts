import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import {
	ConfigLoader,
	deepMerge,
	isRecord,
} from "@/packages/config";
import {
	AuthError,
	ConflictError,
	HTTPError,
	NotFoundError,
	ValidationError,
} from "@/packages/errors";
import {
	createLogger,
	detectLogFormat,
} from "@/packages/logger";

const restoreEnv = {
	LOG_FORMAT: process.env.LOG_FORMAT,
};

afterEach(() => {
	process.env.LOG_FORMAT = restoreEnv.LOG_FORMAT;
});

describe("package coverage bridge", () => {
	test("covers config helpers and loader branches", () => {
		expect(isRecord({ key: "value" })).toBe(true);
		expect(isRecord(null)).toBe(false);
		expect(isRecord([])).toBe(false);

		expect(deepMerge("default", "parsed")).toBe("parsed");
		expect(deepMerge("default", null)).toBe("default");
		expect(
			deepMerge(
				{ nested: { keep: 1, override: 0 } },
				{ nested: { override: 2 } },
			),
		).toEqual({ nested: { keep: 1, override: 2 } });

		expect(ConfigLoader.load("/tmp/does-not-exist-config.jsonc", { key: "v" })).toEqual({ key: "v" });

		const originalExistsSync = fs.existsSync;
		const originalReadFileSync = fs.readFileSync;
		let existsCalled = false;
		let readCalled = false;
		(fs.existsSync as unknown as (p: fs.PathLike) => boolean) = () => {
			existsCalled = true;
			return true;
		};
		(fs.readFileSync as unknown as (p: fs.PathOrFileDescriptor, o?: unknown) => string) = () => {
			readCalled = true;
			return "{ invalid";
		};
		expect(ConfigLoader.load("/tmp/invalid-config.jsonc", { key: "default" })).toEqual({
			key: "default",
		});
		expect(existsCalled).toBe(true);
		expect(readCalled).toBe(true);

		(fs.existsSync as unknown as (p: fs.PathLike) => boolean) = () => true;
		(fs.readFileSync as unknown as (p: fs.PathOrFileDescriptor, o?: unknown) => string) = () => {
			throw new Error("read failed");
		};
		expect(ConfigLoader.load("/tmp/read-fail.jsonc", { key: "default" })).toEqual({
			key: "default",
		});
		fs.existsSync = originalExistsSync;
		fs.readFileSync = originalReadFileSync;
	});

	test("covers custom error constructors", () => {
		expect(new HTTPError("x").name).toBe("HTTPError");
		expect(new ValidationError("x", { field: "a" }).name).toBe("ValidationError");
		expect(new NotFoundError("Resource").name).toBe("NotFoundError");
		expect(new AuthError().name).toBe("AuthError");
		expect(new ConflictError("already exists").name).toBe("ConflictError");
	});

	test("covers logger helpers and json transport branch", () => {
		process.env.LOG_FORMAT = "text";
		expect(detectLogFormat()).toBe("text");
		delete process.env.LOG_FORMAT;

		const originalExistsSync = fs.existsSync;
		const originalReadFileSync = fs.readFileSync;
		let existsCalled = 0;
		let readCalled = 0;
		(fs.existsSync as unknown as (p: fs.PathLike) => boolean) = (target: fs.PathLike) => {
			existsCalled += 1;
			return String(target).includes("gateway.jsonc");
		};
		(fs.readFileSync as unknown as (p: fs.PathOrFileDescriptor, o?: unknown) => string) = () => {
			readCalled += 1;
			return '{"logFormat":"json"}';
		};
		expect(detectLogFormat()).toBe("json");
		expect(existsCalled).toBeGreaterThan(0);
		expect(readCalled).toBeGreaterThan(0);

		(fs.existsSync as unknown as (p: fs.PathLike) => boolean) = () => {
			throw new Error("stat failed");
		};
		expect(detectLogFormat()).toBe("json");

		let mkdirCalled = false;
		const originalMkdirSync = fs.mkdirSync;
		(fs.mkdirSync as unknown as (p: fs.PathLike, o?: unknown) => undefined) = () => {
			mkdirCalled = true;
			return undefined;
		};
		(fs.existsSync as unknown as (p: fs.PathLike) => boolean) = () => false;
		createLogger("gateway", "json");
		expect(mkdirCalled).toBe(true);

		const l = createLogger("gateway", "json");
		expect(() => l.info("json transport logger smoke test")).not.toThrow();
		fs.existsSync = originalExistsSync;
		fs.readFileSync = originalReadFileSync;
		fs.mkdirSync = originalMkdirSync;
	});
});
