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

	test("returns empty frontmatter object when block is missing", () => {
		expect(parseMarkdownFrontmatter("# Just body")).toEqual({});
	});

	test("ignores comment and malformed lines while parsing frontmatter", () => {
		const input = `---
# comment
id: test-app
channels: [telegram, "feishu",   ]
bad line without colon
---
Body`;
		const parsed = parseMarkdownFrontmatter(input);
		expect(parsed).toEqual({
			id: "test-app",
			channels: ["telegram", "feishu"],
		});
	});

	test("strips frontmatter and trims surrounding whitespace", () => {
		const input = `---
id: trim-test
---

Body line
`;
		expect(stripMarkdownFrontmatter(input)).toBe("Body line");
	});

	test("extract description skips headers and returns first non-header line", () => {
		const input = `---
id: test
---
# Heading
\`\`\`ts
const x = 1;
\`\`\`
Plain description line`;
		expect(extractMarkdownDescription(input)).toBe("const x = 1;");
	});

	test("extract description returns empty when there is no usable text", () => {
		const input = `---
id: empty
---
# Heading`;
		expect(extractMarkdownDescription(input)).toBe("");
	});
});
