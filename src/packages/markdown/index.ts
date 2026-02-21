export type FrontmatterValue = string | string[];
export type FrontmatterRecord = Record<string, FrontmatterValue>;

export function parseMarkdownFrontmatter(content: string): FrontmatterRecord {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return {};

	const result: FrontmatterRecord = {};
	for (const rawLine of match[1].split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const idx = line.indexOf(":");
		if (idx === -1) continue;

		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();

		if (value.startsWith("[") && value.endsWith("]")) {
			result[key] = value
				.slice(1, -1)
				.split(",")
				.map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
				.filter(Boolean);
			continue;
		}

		result[key] = value.replace(/^['"]|['"]$/g, "");
	}

	return result;
}

export function stripMarkdownFrontmatter(content: string): string {
	return content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

export function extractMarkdownDescription(content: string): string {
	const body = stripMarkdownFrontmatter(content);
	if (!body) return "";

	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("```")) continue;
		return line.replace(/\*\*/g, "").replace(/\*/g, "").replace(/`/g, "").trim();
	}

	return "";
}

