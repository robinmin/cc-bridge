import fs from "node:fs";
import path from "node:path";

type FileCoverage = {
	file: string;
	funcPct: number;
	linePct: number;
};

type CoveragePolicy = {
	includePrefixes?: string[];
	excludePrefixes?: string[];
};

function parseArgs(argv: string[]) {
	const args = {
		lcov: "coverage/lcov.info",
		threshold: 90,
		include: [] as string[],
		exclude: [] as string[],
		policyFile: "",
	};

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--lcov" && argv[i + 1]) {
			args.lcov = argv[++i];
			continue;
		}
		if (token === "--threshold" && argv[i + 1]) {
			args.threshold = Number(argv[++i]);
			continue;
		}
		if (token === "--include" && argv[i + 1]) {
			args.include.push(argv[++i]);
			continue;
		}
		if (token === "--exclude" && argv[i + 1]) {
			args.exclude.push(argv[++i]);
			continue;
		}
		if (token === "--policy" && argv[i + 1]) {
			args.policyFile = argv[++i];
		}
	}

	return args;
}

function readPolicy(policyFile: string): CoveragePolicy {
	if (!policyFile) return {};
	const raw = fs.readFileSync(policyFile, "utf8");
	const parsed = JSON.parse(raw) as CoveragePolicy;
	return parsed;
}

function pct(hit: number, found: number): number {
	return found === 0 ? 100 : (hit / found) * 100;
}

function parseLcov(content: string): FileCoverage[] {
	const records = content.split("end_of_record");
	const result: FileCoverage[] = [];

	for (const rawRecord of records) {
		const record = rawRecord.trim();
		if (!record) continue;

		const lines = record.split("\n");
		let sf = "";
		let lf = 0;
		let lh = 0;
		let fnf = 0;
		let fnh = 0;

		for (const line of lines) {
			if (line.startsWith("SF:")) sf = line.slice(3).trim();
			if (line.startsWith("LF:")) lf = Number(line.slice(3).trim());
			if (line.startsWith("LH:")) lh = Number(line.slice(3).trim());
			if (line.startsWith("FNF:")) fnf = Number(line.slice(4).trim());
			if (line.startsWith("FNH:")) fnh = Number(line.slice(4).trim());
		}

		if (!sf) continue;
		result.push({
			file: sf,
			funcPct: pct(fnh, fnf),
			linePct: pct(lh, lf),
		});
	}

	return result;
}

function toWorkspaceRelative(file: string): string {
	const cwd = process.cwd();
	return file.startsWith(cwd) ? path.relative(cwd, file) : file;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const policy = readPolicy(args.policyFile);
	const include = [...(policy.includePrefixes ?? []), ...args.include];
	const exclude = [...(policy.excludePrefixes ?? []), ...args.exclude];

	if (!fs.existsSync(args.lcov)) {
		console.error(`Coverage file not found: ${args.lcov}`);
		process.exit(1);
	}

	const content = fs.readFileSync(args.lcov, "utf8");
	const all = parseLcov(content).map((entry) => ({
		...entry,
		file: toWorkspaceRelative(entry.file),
	}));

	const scoped = all
		.filter((entry) => (include.length > 0 ? include.some((prefix) => entry.file.startsWith(prefix)) : true))
		.filter((entry) => !exclude.some((prefix) => entry.file.startsWith(prefix)));

	const failed = scoped.filter(
		(entry) => entry.funcPct < args.threshold || entry.linePct < args.threshold,
	);

	if (failed.length === 0) {
		console.log(
			`Coverage gate passed: ${scoped.length} file(s) >= ${args.threshold}% for funcs and lines.`,
		);
		return;
	}

	console.error(`Coverage gate failed: ${failed.length} file(s) below ${args.threshold}%`);
	for (const entry of failed.sort((a, b) => a.file.localeCompare(b.file))) {
		console.error(
			`- ${entry.file} | funcs=${entry.funcPct.toFixed(2)}% | lines=${entry.linePct.toFixed(2)}%`,
		);
	}
	process.exit(1);
}

main();
