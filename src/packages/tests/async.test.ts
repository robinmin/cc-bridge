import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "@/packages/async";

describe("async package", () => {
	test("maps items with bounded concurrency", async () => {
		const started: number[] = [];
		const finished: number[] = [];

		const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
			started.push(n);
			await Bun.sleep(n % 2 === 0 ? 5 : 10);
			finished.push(n);
			return n * 10;
		});

		expect(out).toEqual([10, 20, 30, 40]);
		expect(started.length).toBe(4);
		expect(finished.length).toBe(4);
	});

	test("defaults to sequential when concurrency is invalid", async () => {
		const out = await mapWithConcurrency([1, 2], 0, async (n) => n + 1);
		expect(out).toEqual([2, 3]);
	});
});

