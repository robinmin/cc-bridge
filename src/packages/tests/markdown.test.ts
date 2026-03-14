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

	test("extract description from content with no frontmatter", () => {
		const input = `# Heading

First non-header line.`;
		expect(extractMarkdownDescription(input)).toBe("First non-header line.");
	});

	test("extract description from empty input", () => {
		expect(extractMarkdownDescription("")).toBe("");
	});

	test("parse frontmatter with single-quoted values", () => {
		const input = `---
name: 'Single Quoted'
value: 'test value'
---
Body`;
		const parsed = parseMarkdownFrontmatter(input);
		expect(parsed.name).toBe("Single Quoted");
		expect(parsed.value).toBe("test value");
	});

	test("strip frontmatter when no frontmatter present", () => {
		const input = "Just plain content";
		expect(stripMarkdownFrontmatter(input)).toBe("Just plain content");
	});

	test("extract description handles bold and italic", () => {
		const input = `---
id: test
---
# Title
**bold** and *italic* text
Another line`;
		const result = extractMarkdownDescription(input);
		expect(result).toBe("bold and italic text");
	});

	test("extract description handles backticks", () => {
		const input = `---
id: test
---
# Title
\`code\` inline`;
		const result = extractMarkdownDescription(input);
		expect(result).toBe("code inline");
	});

	test("parse frontmatter returns empty object for malformed frontmatter", () => {
		const input = `---
malformed
no colon here
---
Body`;
		const parsed = parseMarkdownFrontmatter(input);
		expect(parsed).toEqual({});
	});

	test("strip frontmatter handles edge case with no closing", () => {
		const input = `---
id: test
No closing dash
More content`;
		// Should return original when no proper closing
		const result = stripMarkdownFrontmatter(input);
		expect(result).toContain("id: test");
	});
});
