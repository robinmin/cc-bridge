import { describe, expect, test } from "bun:test";
import { splitTextChunks } from "@/packages/text";

describe("text package", () => {
	test("splits by line boundaries under size cap", () => {
		const chunks = splitTextChunks("a\nbb\nccc", 4);
		expect(chunks).toEqual(["a\nbb", "ccc"]);
	});

	test("hard-splits oversized single lines", () => {
		const chunks = splitTextChunks("abcdefghij", 4);
		expect(chunks).toEqual(["abcd", "efgh", "ij"]);
	});

	test("returns empty for blank input", () => {
		expect(splitTextChunks("   ", 10)).toEqual([]);
	});
});

