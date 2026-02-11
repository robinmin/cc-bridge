import type { Channel } from "@/gateway/channels";
import { instanceManager } from "@/gateway/instance-manager";
import { persistence } from "@/gateway/persistence";
import { discoveryCache } from "@/gateway/services/discovery-cache";
import { SessionPoolService } from "@/gateway/services/SessionPoolService";
import { TmuxManager } from "@/gateway/services/tmux-manager";
import { logger } from "@/packages/logger";
import {
	type ClaudeExecutionConfigExtended,
	type ClaudeExecutionResultOrAsync,
	executeClaude,
	isAsyncResult,
	validateAndSanitizePrompt,
} from "../services/claude-executor";
import type { Bot, Message } from "./index";

export class AgentBot implements Bot {
	name = "AgentBot";

	// Per-container session pools (key: containerId)
	private sessionPools: Map<string, SessionPoolService> = new Map();
	private tmuxManager = new TmuxManager();

	constructor(
		private channel: Channel,
		private persistenceManager = persistence,
	) {}

	getMenus() {
		return [
			{ command: "agents", description: "List all Claude Code agents" },
			{ command: "commands", description: "List all slash commands" },
			{ command: "skills", description: "List all agent skills" },
			{ command: "ws_list", description: "List all active workspaces" },
			{ command: "ws_current", description: "Show current workspace" },
			{ command: "ws_switch", description: "Switch to different workspace" },
			{
				command: "ws_create",
				description: "Explicitly create workspace session",
			},
			{ command: "ws_delete", description: "Delete workspace session" },
		];
	}

	async handle(message: Message): Promise<boolean> {
		// 1. Session Tracking: Try to find a sticky instance
		const instanceName = await this.persistenceManager.getSession(message.chatId);
		let instance = instanceName ? instanceManager.getInstance(instanceName) : undefined;

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
			logger.debug({ chatId: message.chatId, instance: instance.name }, "Sticky session hit");
		}

		if (!instance) {
			// Retry with a short backoff in case the cache is stale or the container is starting
			const retryDelaysMs = [500, 1500];
			for (const delayMs of retryDelaysMs) {
				const refreshed = await instanceManager.refresh();
				instance = refreshed.find((i) => i.status === "running");
				if (instance) {
					logger.info(
						{ chatId: message.chatId, instance: instance.name, delayMs },
						"Instance found after refresh retry",
					);
					await this.persistenceManager.setSession(message.chatId, instance.name);
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}

			if (!instance) {
				logger.warn({ chatId: message.chatId }, "No running instances available for message");
				await this.channel.sendMessage(
					message.chatId,
					"⚠️ No running Claude instance found. Use `/list` to check status.",
				);
				return true;
			}
		}

		// 2. Get user's current workspace for context isolation
		const workspace = await this.persistenceManager.getWorkspace(message.chatId);

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

		// Handle workspace commands
		if (text.startsWith("/ws_list")) {
			await this.handleWorkspaceList(message, instance);
			return true;
		}
		if (text.startsWith("/ws_current")) {
			await this.handleWorkspaceCurrent(message, instance);
			return true;
		}
		if (text.startsWith("/ws_switch ")) {
			const match = text.match(/^\/ws_switch\s+(.+)$/);
			if (match) {
				await this.handleWorkspaceSwitch(message, instance, match[1].trim());
			}
			return true;
		}
		if (text.startsWith("/ws_create ")) {
			const match = text.match(/^\/ws_create\s+(.+)$/);
			if (match) {
				await this.handleWorkspaceCreate(message, instance, match[1].trim());
			}
			return true;
		}
		if (text.startsWith("/ws_delete ")) {
			const match = text.match(/^\/ws_delete\s+(.+)$/);
			if (match) {
				await this.handleWorkspaceDelete(message, instance, match[1].trim());
			}
			return true;
		}

		// 4. Send immediate progress feedback before expensive operations (disabled in production)
		// await this.channel.sendMessage(message.chatId, "🤔 Thinking...");

		// 5. Validate user input before processing
		const validationResult = validateAndSanitizePrompt(message.text);
		if (!validationResult.valid) {
			logger.warn({ chatId: message.chatId, reason: validationResult.reason }, "Message validation failed");
			await this.channel.sendMessage(message.chatId, `⚠️ Invalid message: ${validationResult.reason}`);
			return true;
		}

		// 6. Get message history for context (workspace-specific)
		const history = await this.persistenceManager.getHistory(message.chatId, 11, workspace); // latest 10 + current

		// 7. Execute Claude request with retry logic
		const result = await this.executeWithRetry(instance, message, history, workspace);

		// 6. Handle result
		if (isAsyncResult(result)) {
			// Async mode: response will arrive via callback endpoint
			logger.info({ requestId: result.requestId, chatId: message.chatId }, "Async request submitted to Claude");

			// Store user message (workspace-specific) - response will be stored via callback
			await this.persistenceManager.storeMessage(message.chatId, "user", message.text, workspace);

			return true;
		}

		// Sync mode: handle result immediately
		if (result.success && result.output) {
			await this.channel.sendMessage(message.chatId, result.output);

			// Store agent response (workspace-specific)
			await this.persistenceManager.storeMessage(message.chatId, "agent", result.output, workspace);
			return true;
		}

		// 7. Handle error case
		const errorMsg = result.error || "Unknown error";
		await this.channel.sendMessage(message.chatId, `❌ Error: ${errorMsg}`);

		return true;
	}

	/**
	 * Executes Claude with retry logic for stale containers
	 * Supports both sync (stdio) and async (tmux) modes
	 */
	private async executeWithRetry(
		instance: { name: string; containerId: string; status: string },
		message: Message,
		history: Array<{ sender: string; text: string; timestamp: string }>,
		workspace: string,
	): Promise<ClaudeExecutionResultOrAsync> {
		const config: ClaudeExecutionConfigExtended = {
			allowDangerouslySkipPermissions: true,
			allowedTools: "*",
			timeout: 120000, // 2 minutes
			workspace,
			chatId: message.chatId, // For session identification
			history, // Include conversation history for both sync and async modes
		};

		logger.debug(
			{ chatId: message.chatId, workspace, historyLength: history.length },
			"Using workspace for Claude execution",
		);

		// Execute Claude (sync or async mode based on ENABLE_TMUX)
		let result = await executeClaude(instance.containerId, instance.name, message.text, config);

		// For async mode, return immediately (no retry logic needed)
		if (isAsyncResult(result)) {
			logger.info(
				{ requestId: result.requestId, chatId: message.chatId },
				"Async request submitted, waiting for callback",
			);
			return result;
		}

		// Sync mode: handle retry logic for stale containers
		// If retryable error (stale container), refresh and retry once
		if (!result.success && result.retryable) {
			logger.info({ instance: instance.name }, "Refreshing instances and retrying Claude execution");

			const instances = await instanceManager.refresh();
			const refreshedInstance = instances.find((i) => i.name === instance.name);

			if (refreshedInstance && refreshedInstance.status === "running") {
				result = await executeClaude(refreshedInstance.containerId, refreshedInstance.name, message.text, config);
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
				await this.channel.sendMessage(message.chatId, "📋 No agents found. Make sure plugins are installed.");
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
						? agent.tools.slice(0, 3).join(", ") + (agent.tools.length > 3 ? "..." : "")
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
			await this.channel.sendMessage(message.chatId, "❌ Failed to list agents. Try again later.");
		}
	}

	/**
	 * Handle /commands command - list all available slash commands
	 */
	async handleListCommands(message: Message): Promise<void> {
		try {
			const cache = await discoveryCache.getCache();

			if (cache.commands.length === 0) {
				await this.channel.sendMessage(message.chatId, "📋 No commands found. Make sure plugins are installed.");
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
					const lastNewline = chunk.lastIndexOf("\n");
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
			logger.error({ error: errorMsg, stack: errorStack, type: typeof error }, "Failed to list commands");
			await this.channel.sendMessage(message.chatId, "❌ Failed to list commands. Try again later.");
		}
	}

	/**
	 * Handle /skills command - list all available agent skills
	 */
	async handleListSkills(message: Message): Promise<void> {
		try {
			const cache = await discoveryCache.getCache();

			if (cache.skills.length === 0) {
				await this.channel.sendMessage(message.chatId, "📋 No skills found. Make sure plugins are installed.");
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
					const lastNewline = chunk.lastIndexOf("\n");
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
			logger.error({ error: errorMsg, stack: errorStack, type: typeof error }, "Failed to list skills");
			await this.channel.sendMessage(message.chatId, "❌ Failed to list skills. Try again later.");
		}
	}

	/**
	 * Handle /ws_list command - list all active workspaces
	 */
	async handleWorkspaceList(
		message: Message,
		instance: { name: string; containerId: string; status: string },
	): Promise<void> {
		try {
			const sessionPool = await this.getSessionPool(instance.containerId);
			const sessions = sessionPool.listSessions();
			const stats = sessionPool.getStats();

			if (sessions.length === 0) {
				await this.channel.sendMessage(message.chatId, "📋 No active workspace sessions.");
				return;
			}

			let output = `🗂️ **Active Workspaces** (${stats.totalSessions}/${stats.maxSessions})\n\n`;

			for (const session of sessions) {
				const age = Math.round((Date.now() - session.createdAt) / 1000 / 60);
				const lastActive = Math.round((Date.now() - session.lastActivityAt) / 1000 / 60);
				const statusEmoji = session.status === "active" ? "🟢" : session.status === "idle" ? "💤" : "🔴";

				output += `${statusEmoji} **${session.workspace}**\n`;
				output += `   Status: ${session.status} | Active: ${session.activeRequests} | Total: ${session.totalRequests}\n`;
				output += `   Age: ${age}m | Last active: ${lastActive}m ago\n\n`;
			}

			await this.channel.sendMessage(message.chatId, output);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error({ error: errorMsg }, "Failed to list workspaces");
			await this.channel.sendMessage(message.chatId, "❌ Failed to list workspaces.");
		}
	}

	/**
	 * Handle /ws_current command - show current workspace
	 */
	async handleWorkspaceCurrent(
		message: Message,
		instance: { name: string; containerId: string; status: string },
	): Promise<void> {
		try {
			const workspace = await this.persistenceManager.getWorkspace(message.chatId);
			const sessionPool = await this.getSessionPool(instance.containerId);
			const session = sessionPool.getSession(workspace);

			let output = `📍 **Current Workspace:** ${workspace}\n`;

			if (session) {
				const age = Math.round((Date.now() - session.createdAt) / 1000 / 60);
				const lastActive = Math.round((Date.now() - session.lastActivityAt) / 1000 / 60);
				const statusEmoji = session.status === "active" ? "🟢" : session.status === "idle" ? "💤" : "🔴";

				output += `\n${statusEmoji} Status: ${session.status}\n`;
				output += `🔄 Active requests: ${session.activeRequests}\n`;
				output += `📊 Total requests: ${session.totalRequests}\n`;
				output += `⏱️ Age: ${age} minutes\n`;
				output += `🕐 Last active: ${lastActive} minutes ago`;
			} else {
				output += `\nℹ️ No active session for this workspace.\n`;
				output += `Use \`/ws_create ${workspace}\` to create one.`;
			}

			await this.channel.sendMessage(message.chatId, output);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error({ error: errorMsg }, "Failed to get current workspace");
			await this.channel.sendMessage(message.chatId, "❌ Failed to get workspace info.");
		}
	}

	/**
	 * Handle /ws_switch command - switch to different workspace
	 */
	async handleWorkspaceSwitch(
		message: Message,
		instance: { name: string; containerId: string; status: string },
		targetWorkspace: string,
	): Promise<void> {
		try {
			// Validate workspace name
			if (!/^[a-zA-Z0-9_-]+$/.test(targetWorkspace) || targetWorkspace.length > 64) {
				await this.channel.sendMessage(
					message.chatId,
					"❌ Invalid workspace name. Use alphanumeric, hyphens, underscores only (max 64 chars).",
				);
				return;
			}

			const currentWorkspace = await this.persistenceManager.getWorkspace(message.chatId);
			const sessionPool = await this.getSessionPool(instance.containerId);

			// Get or create target session
			const targetSession = await sessionPool.getOrCreateSession(targetWorkspace);

			// Update user's current workspace in persistence
			await this.persistenceManager.setWorkspace(message.chatId, targetWorkspace);

			let output = `✅ **Switched to workspace:** ${targetWorkspace}\n\n`;
			output += `Session: \`${targetSession.sessionName}\`\n`;
			output += `Status: ${targetSession.status}\n`;

			if (currentWorkspace !== targetWorkspace) {
				output += `\nPreviously: ${currentWorkspace}`;
			}

			await this.channel.sendMessage(message.chatId, output);

			logger.info({ chatId: message.chatId, from: currentWorkspace, to: targetWorkspace }, "Workspace switched");
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error({ error: errorMsg, targetWorkspace }, "Workspace switch failed");

			if (errorMsg.includes("Session limit reached")) {
				await this.channel.sendMessage(message.chatId, "❌ Cannot switch workspace: Maximum session limit reached.");
			} else {
				await this.channel.sendMessage(message.chatId, `❌ Failed to switch workspace: ${errorMsg}`);
			}
		}
	}

	/**
	 * Handle /ws_create command - explicitly create workspace session
	 */
	async handleWorkspaceCreate(
		message: Message,
		instance: { name: string; containerId: string; status: string },
		workspace: string,
	): Promise<void> {
		try {
			// Validate workspace name
			if (!/^[a-zA-Z0-9_-]+$/.test(workspace) || workspace.length > 64) {
				await this.channel.sendMessage(
					message.chatId,
					"❌ Invalid workspace name. Use alphanumeric, hyphens, underscores only (max 64 chars).",
				);
				return;
			}

			const sessionPool = await this.getSessionPool(instance.containerId);
			const session = await sessionPool.getOrCreateSession(workspace);

			let output = `✅ **Workspace session created:** ${workspace}\n\n`;
			output += `Session: \`${session.sessionName}\`\n`;
			output += `Status: ${session.status}\n`;

			await this.channel.sendMessage(message.chatId, output);

			logger.info({ chatId: message.chatId, workspace }, "Workspace created");
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error({ error: errorMsg, workspace }, "Workspace creation failed");

			if (errorMsg.includes("Session limit reached")) {
				await this.channel.sendMessage(message.chatId, "❌ Cannot create workspace: Maximum session limit reached.");
			} else {
				await this.channel.sendMessage(message.chatId, `❌ Failed to create workspace: ${errorMsg}`);
			}
		}
	}

	/**
	 * Handle /ws_delete command - delete workspace session
	 */
	async handleWorkspaceDelete(
		message: Message,
		instance: { name: string; containerId: string; status: string },
		workspace: string,
	): Promise<void> {
		try {
			const sessionPool = await this.getSessionPool(instance.containerId);

			// Check if session exists
			const session = sessionPool.getSession(workspace);
			if (!session) {
				await this.channel.sendMessage(message.chatId, `❌ Workspace "${workspace}" not found.`);
				return;
			}

			// Check for active requests
			if (session.activeRequests > 0) {
				await this.channel.sendMessage(
					message.chatId,
					`❌ Cannot delete workspace: ${session.activeRequests} active request(s) pending.`,
				);
				return;
			}

			await sessionPool.deleteSession(workspace);

			await this.channel.sendMessage(message.chatId, `✅ **Workspace deleted:** ${workspace}`);

			logger.info({ chatId: message.chatId, workspace }, "Workspace deleted");
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error({ error: errorMsg, workspace }, "Workspace deletion failed");
			await this.channel.sendMessage(message.chatId, `❌ Failed to delete workspace: ${errorMsg}`);
		}
	}

	/**
	 * Get or create session pool for a container
	 */
	private async getSessionPool(containerId: string): Promise<SessionPoolService> {
		let pool = this.sessionPools.get(containerId);

		if (!pool) {
			pool = new SessionPoolService(this.tmuxManager, {
				containerId,
				maxSessions: 50,
				inactivityTimeoutMs: 3600000, // 1 hour
				cleanupIntervalMs: 300000, // 5 minutes
				enableAutoCleanup: true,
			});

			// Start the pool (discover existing sessions) before adding to map
			try {
				await pool.start();
			} catch (err) {
				logger.error({ err, containerId }, "Failed to start session pool");
				throw err; // Propagate error to caller
			}

			this.sessionPools.set(containerId, pool);
			logger.info({ containerId }, "Created new session pool for container");
		}

		return pool;
	}
}
