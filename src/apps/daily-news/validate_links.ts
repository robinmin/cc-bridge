#!/usr/bin/env bun

type LinkCheck = {
	inputUrl: string;
	finalUrl: string;
	ok: boolean;
	httpStatus: number | null;
	error?: string;
	isLikelyErrorPage: boolean;
	suspectedMismatch: boolean;
};

type CliOptions = {
	fromFile?: string;
	timeoutMs: number;
	concurrency: number;
};

function usage(): never {
	process.stderr.write(
		[
			"Usage:",
			"  bun run src/apps/daily-news/validate_links.ts <url1> [url2 ...]",
			"  bun run src/apps/daily-news/validate_links.ts --from-file <report.md>",
			"",
			"Options:",
			"  --from-file <path>   Extract and validate URLs from markdown/text file",
			"  --timeout-ms <ms>    Per-link timeout in milliseconds (default: 10000)",
			"  --concurrency <n>    Parallel link checks (default: 4)",
		].join("\n"),
	);
	process.exit(1);
}

function parseArgs(argv: string[]): { urls: string[]; options: CliOptions } {
	const options: CliOptions = {
		timeoutMs: 10_000,
		concurrency: 4,
	};
	const urls: string[] = [];

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--from-file") {
			const file = argv[i + 1];
			if (!file) usage();
			options.fromFile = file;
			i += 1;
			continue;
		}
		if (arg === "--timeout-ms") {
			const value = Number.parseInt(argv[i + 1] || "", 10);
			if (!Number.isFinite(value) || value <= 0) usage();
			options.timeoutMs = value;
			i += 1;
			continue;
		}
		if (arg === "--concurrency") {
			const value = Number.parseInt(argv[i + 1] || "", 10);
			if (!Number.isFinite(value) || value <= 0) usage();
			options.concurrency = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--")) usage();
		urls.push(arg);
	}

	if (options.fromFile && urls.length > 0) {
		process.stderr.write("Do not combine --from-file with positional URLs.\n");
		process.exit(1);
	}

	return { urls, options };
}

function normalizeUrl(raw: string): string | null {
	try {
		const parsed = new URL(raw.trim());
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return parsed.toString();
	} catch {
		return null;
	}
}

function extractUrlsFromText(text: string): string[] {
	const found = new Set<string>();
	const markdownLinkRegex = /\[[^\]]*?\]\((https?:\/\/[^\s)]+)\)/g;
	const rawUrlRegex = /https?:\/\/[^\s)]+/g;

	for (const match of text.matchAll(markdownLinkRegex)) {
		const url = normalizeUrl(match[1]);
		if (url) found.add(url);
	}
	for (const match of text.matchAll(rawUrlRegex)) {
		const cleaned = match[0].replace(/[),.;:!?]+$/, "");
		const url = normalizeUrl(cleaned);
		if (url) found.add(url);
	}

	return [...found];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
		promise
			.then((value) => {
				clearTimeout(timer);
				resolve(value);
			})
			.catch((error) => {
				clearTimeout(timer);
				reject(error);
			});
	});
}

function likelyErrorPage(text: string): boolean {
	const sample = text.slice(0, 1200).toLowerCase();
	return /(404|not found|page not found|error|access denied|forbidden|bad gateway|service unavailable)/.test(sample);
}

function hostMismatch(inputUrl: string, finalUrl: string): boolean {
	try {
		const inputHost = new URL(inputUrl).hostname.replace(/^www\./, "");
		const finalHost = new URL(finalUrl).hostname.replace(/^www\./, "");
		if (inputHost === finalHost) return false;
		if (finalHost.endsWith(`.${inputHost}`) || inputHost.endsWith(`.${finalHost}`)) return false;
		return true;
	} catch {
		return true;
	}
}

async function checkOne(url: string, timeoutMs: number): Promise<LinkCheck> {
	try {
		const response = await withTimeout(
			fetch(url, {
				method: "GET",
				redirect: "follow",
				headers: {
					"user-agent": "cc-bridge-daily-news-link-check/1.0",
				},
			}),
			timeoutMs,
			`timeout after ${timeoutMs}ms`,
		);

		const finalUrl = response.url || url;
		const status = response.status;

		let bodySample = "";
		try {
			bodySample = await withTimeout(response.text(), timeoutMs, `body read timeout after ${timeoutMs}ms`);
		} catch {
			// Best effort; keep empty body sample.
		}

		const isLikelyError = likelyErrorPage(bodySample);
		const mismatch = hostMismatch(url, finalUrl);
		const ok = status >= 200 && status < 400 && !isLikelyError;

		return {
			inputUrl: url,
			finalUrl,
			ok,
			httpStatus: status,
			isLikelyErrorPage: isLikelyError,
			suspectedMismatch: mismatch,
		};
	} catch (error) {
		return {
			inputUrl: url,
			finalUrl: url,
			ok: false,
			httpStatus: null,
			error: error instanceof Error ? error.message : String(error),
			isLikelyErrorPage: false,
			suspectedMismatch: false,
		};
	}
}

async function mapLimit<TIn, TOut>(items: TIn[], limit: number, fn: (item: TIn) => Promise<TOut>): Promise<TOut[]> {
	const out: TOut[] = new Array(items.length);
	let cursor = 0;

	async function worker(): Promise<void> {
		while (cursor < items.length) {
			const idx = cursor;
			cursor += 1;
			out[idx] = await fn(items[idx]);
		}
	}

	const workerCount = Math.min(limit, Math.max(1, items.length));
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return out;
}

async function main(): Promise<void> {
	const { urls, options } = parseArgs(process.argv.slice(2));

	let targetUrls = urls;
	if (options.fromFile) {
		const file = Bun.file(options.fromFile);
		if (!(await file.exists())) {
			process.stderr.write(`File not found: ${options.fromFile}\n`);
			process.exit(1);
			return;
		}
		const content = await file.text();
		targetUrls = extractUrlsFromText(content);
	}

	if (targetUrls.length === 0) usage();

	const checks = await mapLimit(targetUrls, options.concurrency, (url) => checkOne(url, options.timeoutMs));
	const passCount = checks.filter((c) => c.ok).length;
	const failCount = checks.length - passCount;

	process.stdout.write(
		JSON.stringify({ summary: { total: checks.length, pass: passCount, fail: failCount }, checks }, null, 2),
	);
	process.stdout.write("\n");

	if (failCount > 0) process.exitCode = 2;
}

await main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
