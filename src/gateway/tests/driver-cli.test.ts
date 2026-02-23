import { describe, expect, test } from "bun:test";

const DRIVER = "src/gateway/apps/driver.ts";

async function runDriver(args: string[]) {
	const proc = Bun.spawn(["bun", "run", DRIVER, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			NODE_ENV: "test",
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("MiniAppDriver CLI", () => {
	test("prints usage when no command is provided", async () => {
		const result = await runDriver([]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stdout).toContain("task-prompt");
	});

	test("prints task prompt token", async () => {
		const result = await runDriver(["task-prompt", "daily-news", "focus", "ai"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("@miniapp:daily-news focus ai");
	});

	test("fails with usage error when run command misses app-id", async () => {
		const result = await runDriver(["run"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Usage: bun run src/gateway/apps/driver.ts run <app-id> [input]");
	});

	test("lists available apps", async () => {
		const result = await runDriver(["list"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("daily-news");
	});
});
