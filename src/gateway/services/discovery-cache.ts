import fs from "node:fs";
import path from "node:path";
import { logger } from "@/packages/logger";

// Cache file location
const CACHE_PATH = "data/config/discovery-cache.jsonc";
const PLUGINS_CACHE_PATH = `${process.env.HOME || process.env.USERPROFILE || "."}/.claude/plugins/installed_plugins.json`;

// Cache data structure
export interface DiscoveryCache {
	agents: AgentInfo[];
	commands: CommandInfo[];
	skills: SkillInfo[];
	lastUpdated: string;
	version: string;
}

export interface AgentInfo {
	name: string;
	plugin: string;
	version: string;
	description: string;
	model?: string;
	color?: string;
	tools?: string[];
	path: string;
}

export interface CommandInfo {
	name: string;
	plugin: string;
	version: string;
	description: string;
	argumentHint?: string;
	allowedTools?: string[];
	path: string;
}

export interface SkillInfo {
	name: string;
	plugin: string;
	version: string;
	description: string;
	path: string;
}

/**
 * Discovery Cache Service
 * Parses Claude Code plugins and caches agents/commands/skills for fast lookup
 */
export class DiscoveryCacheService {
	private cache: DiscoveryCache | null = null;
	private cachePath: string;
	private pluginsCachePath: string;

	constructor(cachePath: string = CACHE_PATH, pluginsCachePath: string = PLUGINS_CACHE_PATH) {
		this.cachePath = cachePath;
		this.pluginsCachePath = pluginsCachePath;
	}

	/**
	 * Get cached discovery data, refreshing if needed
	 */
	async getCache(forceRefresh = false): Promise<DiscoveryCache> {
		if (!this.cache || forceRefresh) {
			await this.refresh();
		}
		return this.cache as DiscoveryCache;
	}

	/**
	 * Parse YAML frontmatter from markdown content
	 * Simple parser that extracts the YAML block between --- markers
	 */
	private parseFrontmatter(content: string): Record<string, unknown> {
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);
		if (!match) return {};

		const yamlContent = match[1];
		const result: Record<string, unknown> = {};

		// Simple YAML parser for our specific use case
		// Handles key: value and key: [list] formats
		for (const line of yamlContent.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const colonIndex = trimmed.indexOf(":");
			if (colonIndex === -1) continue;

			const key = trimmed.slice(0, colonIndex).trim();
			const valueStr = trimmed.slice(colonIndex + 1).trim();

			// Handle array values
			if (valueStr.startsWith("[") && valueStr.endsWith("]")) {
				const arrayContent = valueStr.slice(1, -1);
				const items = arrayContent
					.split(",")
					.map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
					.filter(Boolean);
				result[key] = items;
			}
			// Handle string values (remove quotes if present)
			else if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
				result[key] = valueStr.slice(1, -1);
			} else if (valueStr.startsWith("'") && valueStr.endsWith("'")) {
				result[key] = valueStr.slice(1, -1);
			} else {
				result[key] = valueStr;
			}
		}

		return result;
	}

	/**
	 * Extract description from markdown content
	 * Gets the first paragraph after frontmatter
	 */
	private extractDescription(content: string): string {
		// Skip frontmatter
		const frontmatterEnd = content.indexOf("\n---", 4);
		if (frontmatterEnd === -1) return "";

		const afterFrontmatter = content.slice(frontmatterEnd + 5).trim();

		// Get first paragraph or first line
		const lines = afterFrontmatter.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("```")) {
				// Remove markdown formatting
				return trimmed.replace(/\*\*/g, "").replace(/\*/g, "").replace(/`/g, "").trim();
			}
		}

		return afterFrontmatter.split("\n")[0]?.trim() || "";
	}

	/**
	 * Scan plugins directory and parse all agents, commands, and skills
	 */
	async scanPlugins(): Promise<{
		agents: AgentInfo[];
		commands: CommandInfo[];
		skills: SkillInfo[];
	}> {
		const agents: AgentInfo[] = [];
		const commands: CommandInfo[] = [];
		const skills: SkillInfo[] = [];

		// Read installed plugins
		if (!fs.existsSync(this.pluginsCachePath)) {
			logger.warn({ path: this.pluginsCachePath }, "Installed plugins cache not found");
			return { agents, commands, skills };
		}

		const pluginsData = JSON.parse(fs.readFileSync(this.pluginsCachePath, "utf-8"));

		for (const [pluginName, pluginEntries] of Object.entries(pluginsData.plugins || {})) {
			const entries = Array.isArray(pluginEntries) ? pluginEntries : [pluginEntries];

			for (const entry of entries as Array<{
				installPath: string;
				version: string;
			}>) {
				const { installPath, version } = entry;

				// Scan agents
				const agentsDir = path.join(installPath, "agents");
				if (fs.existsSync(agentsDir)) {
					const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));

					for (const file of agentFiles) {
						const filePath = path.join(agentsDir, file);
						try {
							const content = fs.readFileSync(filePath, "utf-8");
							const frontmatter = this.parseFrontmatter(content);
							const name = frontmatter.name as string;
							if (name) {
								agents.push({
									name,
									plugin: pluginName,
									version,
									description: (frontmatter.description as string) || this.extractDescription(content),
									model: frontmatter.model as string | undefined,
									color: frontmatter.color as string | undefined,
									tools: frontmatter.tools as string[] | undefined,
									path: filePath,
								});
							}
						} catch (err) {
							logger.debug({ file: filePath, error: err }, "Failed to parse agent file");
						}
					}
				}

				// Scan commands
				const commandsDir = path.join(installPath, "commands");
				if (fs.existsSync(commandsDir)) {
					const commandFiles = fs.readdirSync(commandsDir).filter((f) => f.endsWith(".md"));

					for (const file of commandFiles) {
						const filePath = path.join(commandsDir, file);
						try {
							const content = fs.readFileSync(filePath, "utf-8");
							const frontmatter = this.parseFrontmatter(content);
							const name = file.replace(".md", "");
							commands.push({
								name,
								plugin: pluginName,
								version,
								description: (frontmatter.description as string) || this.extractDescription(content),
								argumentHint: frontmatter["argument-hint"] as string | undefined,
								allowedTools: frontmatter["allowed-tools"] as string[] | undefined,
								path: filePath,
							});
						} catch (err) {
							logger.debug({ file: filePath, error: err }, "Failed to parse command file");
						}
					}
				}

				// Scan skills (skills are in subdirectories)
				const skillsBaseDir = path.join(installPath, "skills");
				if (fs.existsSync(skillsBaseDir)) {
					const skillDirs = fs.readdirSync(skillsBaseDir, {
						withFileTypes: true,
					});

					for (const skillDir of skillDirs) {
						if (!skillDir.isDirectory()) continue;

						const skillFile = path.join(skillsBaseDir, skillDir.name, "SKILL.md");
						if (fs.existsSync(skillFile)) {
							try {
								const content = fs.readFileSync(skillFile, "utf-8");
								const frontmatter = this.parseFrontmatter(content);
								const name = frontmatter.name as string;
								if (name) {
									skills.push({
										name,
										plugin: pluginName,
										version,
										description: (frontmatter.description as string) || this.extractDescription(content),
										path: skillFile,
									});
								}
							} catch (err) {
								logger.debug({ file: skillFile, error: err }, "Failed to parse skill file");
							}
						}
					}
				}
			}
		}

		logger.info(
			{
				agents: agents.length,
				commands: commands.length,
				skills: skills.length,
			},
			"Scanned plugins for discovery data",
		);

		return { agents, commands, skills };
	}

	/**
	 * Refresh the discovery cache by rescanning all plugins
	 */
	async refresh(): Promise<DiscoveryCache> {
		logger.info("Refreshing discovery cache");

		// Ensure cache directory exists
		const cacheDir = path.dirname(this.cachePath);
		if (!fs.existsSync(cacheDir)) {
			fs.mkdirSync(cacheDir, { recursive: true });
		}

		// Scan all plugins
		const { agents, commands, skills } = await this.scanPlugins();

		// Build cache object
		this.cache = {
			agents,
			commands,
			skills,
			lastUpdated: new Date().toISOString(),
			version: "1.0",
		};

		// Write to file
		fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), "utf-8");

		logger.info({ path: this.cachePath, size: JSON.stringify(this.cache).length }, "Discovery cache updated");

		return this.cache;
	}

	/**
	 * Load cache from disk (without refreshing)
	 */
	async loadFromDisk(): Promise<DiscoveryCache | null> {
		if (!fs.existsSync(this.cachePath)) {
			return null;
		}

		try {
			const content = fs.readFileSync(this.cachePath, "utf-8");
			this.cache = JSON.parse(content) as DiscoveryCache;
			return this.cache;
		} catch (err) {
			logger.warn({ path: this.cachePath, error: err }, "Failed to load discovery cache from disk");
			return null;
		}
	}
}

// Singleton instance
export const discoveryCache = new DiscoveryCacheService();
