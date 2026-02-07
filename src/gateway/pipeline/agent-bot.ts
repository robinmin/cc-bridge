import type { Channel } from "@/gateway/channels";
import { instanceManager } from "@/gateway/instance-manager";
import { persistence } from "@/gateway/persistence";
import { discoveryCache } from "@/gateway/services/discovery-cache";
import { logger } from "@/packages/logger";
import {
	type ClaudeExecutionConfig,
	type ClaudeExecutionResult,
	executeClaudeWithHistory,
	validateAndSanitizePrompt,
} from "../services/claude-executor";
import type { Bot, Message } from "./index";

export class AgentBot implements Bot {
	name = "AgentBot";

	constructor(
		private channel: Channel,
		private persistenceManager = persistence,
	) {}

	getMenus() {
		return [
			{ command: "agents", description: "List all Claude Code agents" },
			{ command: "commands", description: "List all slash commands" },
			{ command: "skills", description: "List all agent skills" },
		];
	}

	async handle(message: Message): Promise<boolean> {
		// 1. Session Tracking: Try to find a sticky instance
		const instanceName = await this.persistenceManager.getSession(
			message.chatId,
		);
		let instance = instanceName
			? instanceManager.getInstance(instanceName)
			: undefined;

		// Fallback to any running instance if sticky one is gone or doesn't exist
		if (!instance || instance.status !== "running") {
			const instances = instanceManager.getInstances();
			instance = instances.find((i) => i.status === "running");

			if (instance) {
				logger.info(
					{ chatId: message.chatId, instance: instance.name },
					"Sticky session lost or missing, selecting new instance",
				);
				await this.persistenceManager.setSession(message.chatId, instance.name);
			}
		} else {
			logger.debug(
				{ chatId: message.chatId, instance: instance.name },
				"Sticky session hit",
			);
		}

		if (!instance) {
			logger.warn(
				{ chatId: message.chatId },
				"No running instances available for message",
			);
			await this.channel.sendMessage(
				message.chatId,
				"⚠️ No running Claude instance found. Use `/list` to check status.",
			);
			return true;
		}

		// 2. Get user's current workspace for context isolation
		const workspace = await this.persistenceManager.getWorkspace(
			message.chatId,
		);

		// 3. Handle discovery commands (/agents, /commands, /skills)
		const text = message.text.trim();
		if (text.startsWith("/agents")) {
			await this.handleListAgents(message);
			return true;
		}
		if (text.startsWith("/commands")) {
			await this.handleListCommands(message);
			return true;
		}
		if (text.startsWith("/skills")) {
			await this.handleListSkills(message);
			return true;
		}

		// 4. Validate user input before processing
		const validationResult = validateAndSanitizePrompt(message.text);
		if (!validationResult.valid) {
			logger.warn(
				{ chatId: message.chatId, reason: validationResult.reason },
				"Message validation failed",
			);
			await this.channel.sendMessage(
				message.chatId,
				`⚠️ Invalid message: ${validationResult.reason}`,
			);
			return true;
		}

		// 4. Get message history for context (workspace-specific)
		const history = await this.persistenceManager.getHistory(
			message.chatId,
			11,
			workspace,
		); // latest 10 + current

		// 5. Execute Claude request with retry logic
		const result = await this.executeWithRetry(
			instance,
			message,
			history,
			workspace,
		);

		// 6. Handle result
		if (result.success && result.output) {
			await this.channel.sendMessage(message.chatId, result.output);

			// Store agent response (workspace-specific)
			await this.persistenceManager.storeMessage(
				message.chatId,
				"agent",
				result.output,
				workspace,
			);
			return true;
		}

		// 6. Handle error case
		const errorMsg = result.error || "Unknown error";
		await this.channel.sendMessage(message.chatId, `❌ Error: ${errorMsg}`);

		return true;
	}

	/**
	 * Executes Claude with retry logic for stale containers
	 */
	private async executeWithRetry(
		instance: { name: string; containerId: string; status: string },
		message: Message,
		history: Array<{ sender: string; text: string; timestamp: string }>,
		workspace: string,
	): Promise<ClaudeExecutionResult> {
		const config: ClaudeExecutionConfig = {
			allowDangerouslySkipPermissions: true,
			allowedTools: "*",
			timeout: 120000, // 2 minutes
			workspace,
			chatId: message.chatId, // For session identification
		};

		logger.debug(
			{ chatId: message.chatId, workspace },
			"Using workspace for Claude execution",
		);

		let result = await executeClaudeWithHistory(
			instance,
			message.text,
			history,
			config,
		);

		// If retryable error (stale container), refresh and retry once
		if (!result.success && result.retryable) {
			logger.info(
				{ instance: instance.name },
				"Refreshing instances and retrying Claude execution",
			);

			const instances = await instanceManager.refresh();
			const refreshedInstance = instances.find((i) => i.name === instance.name);

			if (refreshedInstance && refreshedInstance.status === "running") {
				result = await executeClaudeWithHistory(
					refreshedInstance,
					message.text,
					history,
					config,
				);
			}
		}

		return result;
	}

	/**
	 * Handle /agents command - list all available Claude Code agents
	 */
	async handleListAgents(message: Message): Promise<void> {
		try {
			const cache = await discoveryCache.getCache();

			if (cache.agents.length === 0) {
				await this.channel.sendMessage(
					message.chatId,
					"📋 No agents found. Make sure plugins are installed.",
				);
				return;
			}

			// Group agents by plugin
			const byPlugin: Record<string, typeof cache.agents> = {};
			for (const agent of cache.agents) {
				if (!byPlugin[agent.plugin]) {
					byPlugin[agent.plugin] = [];
				}
				byPlugin[agent.plugin].push(agent);
			}

			let output = `🤖 **Available Claude Code Agents** (${cache.agents.length} total)\n\n`;

			for (const [plugin, agents] of Object.entries(byPlugin)) {
				output += `📦 *${plugin}*\n`;
				for (const agent of agents) {
					const toolList = agent.tools
						? agent.tools.slice(0, 3).join(", ") +
							(agent.tools.length > 3 ? "..." : "")
						: "";
					output += `\n  \`/${agent.name}\` - ${agent.description.substring(0, 80)}${agent.description.length > 80 ? "..." : ""}`;
					if (toolList) {
						output += `\n  🔧 Tools: ${toolList}`;
					}
					output += "\n";
				}
				output += "\n";
			}

			output += `_Last updated: ${new Date(cache.lastUpdated).toLocaleDateString()}_`;

			await this.channel.sendMessage(message.chatId, output);
		} catch (error) {
			logger.error({ error }, "Failed to list agents");
			await this.channel.sendMessage(
				message.chatId,
				"❌ Failed to list agents. Try again later.",
			);
		}
	}

	/**
	 * Handle /commands command - list all available slash commands
	 */
	async handleListCommands(message: Message): Promise<void> {
		try {
			const cache = await discoveryCache.getCache();

			if (cache.commands.length === 0) {
				await this.channel.sendMessage(
					message.chatId,
					"📋 No commands found. Make sure plugins are installed.",
				);
				return;
			}

			// Group commands by plugin
			const byPlugin: Record<string, typeof cache.commands> = {};
			for (const command of cache.commands) {
				if (!byPlugin[command.plugin]) {
					byPlugin[command.plugin] = [];
				}
				byPlugin[command.plugin].push(command);
			}

			let output = `⚡ **Available Slash Commands** (${cache.commands.length} total)\n\n`;

			for (const [plugin, commands] of Object.entries(byPlugin)) {
				output += `📦 *${plugin}*\n`;
				for (const command of commands) {
					const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
					output += `\n  \`/${command.name}${hint}\`\n  ${command.description.substring(0, 100)}${command.description.length > 100 ? "..." : ""}\n`;
				}
				output += "\n";
			}

			output += `_Last updated: ${new Date(cache.lastUpdated).toLocaleDateString()}_`;

			// Split message if it exceeds Telegram's 4096 character limit
			const MAX_LENGTH = 4000;
			if (output.length > MAX_LENGTH) {
				let remaining = output;
				while (remaining.length > 0) {
					const chunk = remaining.substring(0, MAX_LENGTH);
					const lastNewline = chunk.lastIndexOf('\n');
					const splitAt = lastNewline > 0 ? lastNewline : MAX_LENGTH;

					await this.channel.sendMessage(message.chatId, chunk.substring(0, splitAt));
					remaining = remaining.substring(splitAt).trim();
				}
			} else {
				await this.channel.sendMessage(message.chatId, output);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const errorStack = error instanceof Error ? error.stack : undefined;
			logger.error(
				{ error: errorMsg, stack: errorStack, type: typeof error },
				"Failed to list commands",
			);
			await this.channel.sendMessage(
				message.chatId,
				"❌ Failed to list commands. Try again later.",
			);
		}
	}

	/**
	 * Handle /skills command - list all available agent skills
	 */
	async handleListSkills(message: Message): Promise<void> {
		try {
			const cache = await discoveryCache.getCache();

			if (cache.skills.length === 0) {
				await this.channel.sendMessage(
					message.chatId,
					"📋 No skills found. Make sure plugins are installed.",
				);
				return;
			}

			// Group skills by plugin
			const byPlugin: Record<string, typeof cache.skills> = {};
			for (const skill of cache.skills) {
				if (!byPlugin[skill.plugin]) {
					byPlugin[skill.plugin] = [];
				}
				byPlugin[skill.plugin].push(skill);
			}

			let output = `🎯 **Available Agent Skills** (${cache.skills.length} total)\n\n`;

			for (const [plugin, skills] of Object.entries(byPlugin)) {
				output += `📦 *${plugin}*\n`;
				for (const skill of skills) {
					output += `\n  \`rd2:${skill.name}\`\n  ${skill.description.substring(0, 100)}${skill.description.length > 100 ? "..." : ""}\n`;
				}
				output += "\n";
			}

			output += `_Last updated: ${new Date(cache.lastUpdated).toLocaleDateString()}_`;

			// Split message if it exceeds Telegram's 4096 character limit
			const MAX_LENGTH = 4000;
			if (output.length > MAX_LENGTH) {
				let remaining = output;
				while (remaining.length > 0) {
					const chunk = remaining.substring(0, MAX_LENGTH);
					const lastNewline = chunk.lastIndexOf('\n');
					const splitAt = lastNewline > 0 ? lastNewline : MAX_LENGTH;

					await this.channel.sendMessage(message.chatId, chunk.substring(0, splitAt));
					remaining = remaining.substring(splitAt).trim();
				}
			} else {
				await this.channel.sendMessage(message.chatId, output);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const errorStack = error instanceof Error ? error.stack : undefined;
			logger.error(
				{ error: errorMsg, stack: errorStack, type: typeof error },
				"Failed to list skills",
			);
			await this.channel.sendMessage(
				message.chatId,
				"❌ Failed to list skills. Try again later.",
			);
		}
	}
}
