import { describe, expect, test } from "bun:test";
import { extractMarkdownDescription, parseMarkdownFrontmatter, stripMarkdownFrontmatter } from "@/packages/markdown";

describe("markdown package", () => {
	test("parses frontmatter strings and arrays", () => {
		const input = `---
id: daily-news
channels: [telegram, feishu]
description: "Hello"
---
# Title
Body`;

		const parsed = parseMarkdownFrontmatter(input);
		expect(parsed.id).toBe("daily-news");
		expect(parsed.channels).toEqual(["telegram", "feishu"]);
		expect(parsed.description).toBe("Hello");
	});

	test("strips frontmatter body", () => {
		const input = `---
id: test
---
# Header
Line`;
		expect(stripMarkdownFrontmatter(input)).toBe("# Header\nLine");
	});

	test("extracts first body description line", () => {
		const input = `---
id: test
---
# Header
**First** line.
Second line.`;
		expect(extractMarkdownDescription(input)).toBe("First line.");
	});
});

