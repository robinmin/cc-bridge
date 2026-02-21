export function splitTextChunks(text: string, maxChars: number): string[] {
	const normalized = text.trim();
	if (!normalized) return [];
	if (maxChars <= 0) return [normalized];
	if (normalized.length <= maxChars) return [normalized];

	const chunks: string[] = [];
	let current = "";

	const pushCurrent = () => {
		if (current.length > 0) chunks.push(current);
		current = "";
	};

	const appendWithHardSplit = (line: string) => {
		let remaining = line;
		while (remaining.length > maxChars) {
			if (current) pushCurrent();
			chunks.push(remaining.slice(0, maxChars));
			remaining = remaining.slice(maxChars);
		}
		if (!remaining) return;

		if (!current) {
			current = remaining;
			return;
		}

		const candidate = `${current}\n${remaining}`;
		if (candidate.length <= maxChars) {
			current = candidate;
			return;
		}

		pushCurrent();
		current = remaining;
	};

	for (const line of normalized.split("\n")) {
		appendWithHardSplit(line);
	}

	pushCurrent();
	return chunks;
}
