import { describe, expect, test } from "bun:test";
import { getMissingRequiredFields } from "@/packages/validation";

describe("validation package", () => {
	test("reports missing required string fields", () => {
		const missing = getMissingRequiredFields(
			{ id: "daily-news", name: "", description: "ok" },
			["id", "name", "description"],
		);
		expect(missing).toEqual(["name"]);
	});
});

