import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiscoveryCacheService } from "@/gateway/services/discovery-cache";

describe("DiscoveryCacheService", () => {
	let baseDir: string;
	let cachePath: string;
	let pluginsCachePath: string;

	beforeEach(async () => {
		baseDir = await mkdtemp(path.join(tmpdir(), "discovery-cache-test-"));
		cachePath = path.join(baseDir, "data", "config", "discovery-cache.jsonc");
		pluginsCachePath = path.join(baseDir, "installed_plugins.json");
	});

	afterEach(async () => {
		await rm(baseDir, { recursive: true, force: true });
	});

	test("returns empty scan result when installed plugins cache is missing", async () => {
		const service = new DiscoveryCacheService(cachePath, pluginsCachePath);
		await expect(service.scanPlugins()).resolves.toEqual({
			agents: [],
			commands: [],
			skills: [],
		});
	});

	test("returns empty scan result when installed plugins cache is invalid json", async () => {
		await writeFile(pluginsCachePath, "{ invalid json", "utf-8");
		const service = new DiscoveryCacheService(cachePath, pluginsCachePath);
		await expect(service.scanPlugins()).resolves.toEqual({
			agents: [],
			commands: [],
			skills: [],
		});
	});

	test("scans agents, commands, and skills from valid plugin entries", async () => {
		const pluginRoot = path.join(baseDir, "plugin-a");
		const agentsDir = path.join(pluginRoot, "agents");
		const commandsDir = path.join(pluginRoot, "commands");
		const skillDir = path.join(pluginRoot, "skills", "summarizer");

		await mkdir(agentsDir, { recursive: true });
		await mkdir(commandsDir, { recursive: true });
		await mkdir(skillDir, { recursive: true });

		await writeFile(
			path.join(agentsDir, "assistant.md"),
			`---
name: assistant
description: Assistant agent
model: claude-3-7-sonnet
color: cyan
tools: [Read, Edit]
---
# Agent`,
			"utf-8",
		);
		await writeFile(
			path.join(commandsDir, "deploy.md"),
			`---
description: Deploy command
argument-hint: <env>
allowed-tools: [Bash]
---
Run deploy`,
			"utf-8",
		);
		await writeFile(
			path.join(skillDir, "SKILL.md"),
			`---
name: summarizer
description: Summarize long text
---
Use this to summarize.`,
			"utf-8",
		);

		await writeFile(
			pluginsCachePath,
			JSON.stringify({
				plugins: {
					pluginA: { installPath: pluginRoot, version: "1.2.3" },
				},
			}),
			"utf-8",
		);

		const service = new DiscoveryCacheService(cachePath, pluginsCachePath);
		const result = await service.scanPlugins();

		expect(result.agents).toHaveLength(1);
		expect(result.agents[0]).toMatchObject({
			name: "assistant",
			plugin: "pluginA",
			version: "1.2.3",
			description: "Assistant agent",
			model: "claude-3-7-sonnet",
			color: "cyan",
			tools: ["Read", "Edit"],
		});
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]).toMatchObject({
			name: "deploy",
			plugin: "pluginA",
			version: "1.2.3",
			description: "Deploy command",
			argumentHint: "<env>",
			allowedTools: ["Bash"],
		});
		expect(result.skills).toHaveLength(1);
		expect(result.skills[0]).toMatchObject({
			name: "summarizer",
			plugin: "pluginA",
			version: "1.2.3",
			description: "Summarize long text",
		});
	});

	test("skips invalid plugin entries and supports array entries", async () => {
		const validPluginRoot = path.join(baseDir, "plugin-valid");
		await mkdir(path.join(validPluginRoot, "commands"), { recursive: true });
		await writeFile(path.join(validPluginRoot, "commands", "run.md"), "Run command", "utf-8");

		await writeFile(
			pluginsCachePath,
			JSON.stringify({
				plugins: {
					badShape: [null, 123, { version: "1.0.0" }, { installPath: "", version: "1.0.0" }],
					missingVersion: { installPath: validPluginRoot },
					missingPath: { version: "1.0.0" },
					missingDir: { installPath: path.join(baseDir, "does-not-exist"), version: "2.0.0" },
					validArray: [{ installPath: validPluginRoot, version: "3.0.0" }],
				},
			}),
			"utf-8",
		);

		const service = new DiscoveryCacheService(cachePath, pluginsCachePath);
		const result = await service.scanPlugins();

		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]).toMatchObject({
			name: "run",
			plugin: "validArray",
			version: "3.0.0",
		});
		expect(result.agents).toHaveLength(0);
		expect(result.skills).toHaveLength(0);
	});

	test("refresh persists cache to disk and loadFromDisk handles success/failure", async () => {
		const pluginRoot = path.join(baseDir, "plugin-refresh");
		await mkdir(path.join(pluginRoot, "agents"), { recursive: true });
		await writeFile(
			path.join(pluginRoot, "agents", "agent.md"),
			`---
name: cached-agent
---
Agent body`,
			"utf-8",
		);
		await writeFile(
			pluginsCachePath,
			JSON.stringify({
				plugins: {
					pluginRefresh: { installPath: pluginRoot, version: "4.5.6" },
				},
			}),
			"utf-8",
		);

		const service = new DiscoveryCacheService(cachePath, pluginsCachePath);
		const cache = await service.refresh();
		expect(cache.version).toBe("1.0");
		expect(cache.agents).toHaveLength(1);
		expect(cache.lastUpdated).toBeString();

		const persistedRaw = await readFile(cachePath, "utf-8");
		expect(() => JSON.parse(persistedRaw)).not.toThrow();

		const loaded = await service.loadFromDisk();
		expect(loaded?.agents[0].name).toBe("cached-agent");

		await writeFile(cachePath, "{ invalid", "utf-8");
		await expect(service.loadFromDisk()).resolves.toBeNull();
	});

	test("getCache reuses in-memory cache unless forceRefresh is true", async () => {
		const service = new DiscoveryCacheService(cachePath, pluginsCachePath);
		const refreshSpy = spyOn(service, "refresh");
		refreshSpy.mockImplementation(async () => {
			const cache = {
				agents: [],
				commands: [],
				skills: [],
				lastUpdated: new Date().toISOString(),
				version: "1.0",
			};
			(service as unknown as { cache: unknown }).cache = cache;
			return cache;
		});

		await service.getCache();
		await service.getCache();
		await service.getCache(true);

		expect(refreshSpy).toHaveBeenCalledTimes(2);
	});
});
