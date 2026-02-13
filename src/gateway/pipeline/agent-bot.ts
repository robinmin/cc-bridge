import type { Channel } from "@/gateway/channels";
import { instanceManager } from "@/gateway/instance-manager";
import { persistence } from "@/gateway/persistence";
import { discoveryCache } from "@/gateway/services/discovery-cache";
import { SessionPoolService } from "@/gateway/services/SessionPoolService";
import { TmuxManager } from "@/gateway/services/tmux-manager";
import { logger } from "@/packages/logger";
import { renderTemplate } from "@/packages/template";
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
				command: "ws_add",
				description: "Explicitly create workspace session",
			},
			{ command: "ws_del", description: "Delete workspace session" },
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
		if (text.startsWith("/schedulers")) {
			await this.handleSchedulers(message);
			return true;
		}
		if (text === "/clear") {
			await this.handleClear(message, instance, workspace);
			return true;
		}
		if (text.startsWith("/scheduler_add ")) {
			const match = text.match(/^\/scheduler_add\s+(\S+)\s+(once|recurring)\s+(\S+)\s+(.+)$/);
			if (match) {
				await this.handleSchedulerAdd(message, match[1], match[2], match[3], match[4]);
			} else {
				await this.channel.sendMessage(
					message.chatId,
					"Usage: /scheduler_add <instance> <once|recurring> <schedule> <prompt>\nExample: /scheduler_add cc-bridge recurring 1h \"Daily summary\"",
				);
			}
			return true;
		}
		if (text.startsWith("/scheduler_del ")) {
			const match = text.match(/^\/scheduler_del\s+(\S+)$/);
			if (match) {
				await this.handleSchedulerDel(message, match[1]);
			} else {
				await this.channel.sendMessage(message.chatId, "Usage: /scheduler_del <task_id>");
			}
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
		if (text.startsWith("/ws_add ")) {
			const match = text.match(/^\/ws_add\s+(.+)$/);
			if (match) {
				await this.handleWorkspaceCreate(message, instance, match[1].trim());
			}
			return true;
		}
		if (text.startsWith("/ws_del ")) {
			const match = text.match(/^\/ws_del\s+(.+)$/);
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
	 * Handle /schedulers command - list all scheduled tasks
	 */
	private async handleSchedulers(message: Message): Promise<void> {
		try {
			const tasks = (await this.persistenceManager.getAllTasks()) as Array<{
				id: string;
				instance_name: string;
				chat_id: string;
				prompt: string;
				schedule_type: string;
				schedule_value: string;
				next_run: string;
				status: string;
			}>;

			if (!tasks || tasks.length === 0) {
				const output = renderTemplate(SCHEDULERS_TEMPLATE, {
					systemTasks: [
						{
							id: "uploads_cleanup",
							schedule: "every 1m",
							source: "TaskScheduler",
						},
					],
					userTasks: [],
					userTaskCount: 0,
					noUserTasks: true,
				});
				await this.channel.sendMessage(message.chatId, sanitizeForTelegramMarkdown(output), { parse_mode: "Markdown" });
				return;
			}

			const userTasks = tasks.map((task) => ({
				id: task.id,
				instance: task.instance_name,
				schedule: `${task.schedule_type}:${task.schedule_value}`,
				next: task.next_run || "n/a",
				status: task.status,
				prompt:
					task.prompt && task.prompt.length > 80 ? `${task.prompt.substring(0, 80)}...` : task.prompt || "",
			}));

			const output = renderTemplate(SCHEDULERS_TEMPLATE, {
				systemTasks: [
					{
						id: "uploads_cleanup",
						schedule: "every 1m",
						source: "TaskScheduler",
					},
				],
				userTasks,
				userTaskCount: userTasks.length,
				noUserTasks: userTasks.length === 0,
			});

			await this.channel.sendMessage(message.chatId, sanitizeForTelegramMarkdown(output), { parse_mode: "Markdown" });
		} catch (error) {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to list schedulers");
			await this.channel.sendMessage(message.chatId, "⚠️ Failed to list scheduled tasks.");
		}
	}

	private async handleSchedulerAdd(
		message: Message,
		instanceName: string,
		scheduleType: string,
		scheduleValue: string,
		prompt: string,
	): Promise<void> {
		try {
			const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			const nextRun = new Date().toISOString().replace("T", " ").substring(0, 19);

			await this.persistenceManager.saveTask({
				id,
				instance_name: instanceName,
				chat_id: String(message.chatId),
				prompt,
				schedule_type: scheduleType as "once" | "recurring",
				schedule_value: scheduleValue,
				next_run: nextRun,
				status: "active",
			});

			await this.channel.sendMessage(
				message.chatId,
				`✅ Scheduled task created.\nID: ${id}\nInstance: ${instanceName}\nSchedule: ${scheduleType}:${scheduleValue}`,
			);
		} catch (error) {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to add scheduler");
			await this.channel.sendMessage(message.chatId, "⚠️ Failed to create scheduled task.");
		}
	}

	private async handleSchedulerDel(message: Message, taskId: string): Promise<void> {
		try {
			await this.persistenceManager.deleteTask(taskId);
			await this.channel.sendMessage(message.chatId, `✅ Scheduled task deleted: ${taskId}`);
		} catch (error) {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to delete scheduler");
			await this.channel.sendMessage(message.chatId, "⚠️ Failed to delete scheduled task.");
		}
	}

	private async handleClear(
		message: Message,
		instance: { name: string; containerId: string; status: string },
		workspace: string,
	): Promise<void> {
		try {
			const cleared = await this.tmuxManager.clearSession(instance.containerId, workspace, message.chatId);
			if (cleared) {
				await this.channel.sendMessage(message.chatId, "✅ Cleared session context for this workspace.");
			} else {
				await this.channel.sendMessage(message.chatId, "ℹ️ No active session to clear.");
			}
		} catch (error) {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to clear session");
			await this.channel.sendMessage(message.chatId, "⚠️ Failed to clear session.");
		}
	}

	private sanitizeForTelegramMarkdown(input: string): string {
		return sanitizeForTelegramMarkdown(input);
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

			const byPlugin: Record<string, typeof cache.agents> = {};
			for (const agent of cache.agents) {
				if (!byPlugin[agent.plugin]) {
					byPlugin[agent.plugin] = [];
				}
				byPlugin[agent.plugin].push(agent);
			}

			const plugins = Object.entries(byPlugin).map(([plugin, agents]) => ({
				name: plugin,
				items: agents.map((agent) => ({
					name: agent.name,
					description:
						agent.description.length > 80 ? `${agent.description.substring(0, 80)}...` : agent.description,
					tools: agent.tools
						? agent.tools.slice(0, 3).join(", ") + (agent.tools.length > 3 ? "..." : "")
						: "",
				})),
			}));

			const output = renderTemplate(AGENTS_TEMPLATE, {
				total: cache.agents.length,
				lastUpdated: new Date(cache.lastUpdated).toLocaleDateString(),
				plugins,
			});

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

			const byPlugin: Record<string, typeof cache.commands> = {};
			for (const command of cache.commands) {
				if (!byPlugin[command.plugin]) {
					byPlugin[command.plugin] = [];
				}
				byPlugin[command.plugin].push(command);
			}

			const plugins = Object.entries(byPlugin).map(([plugin, commands]) => ({
				name: plugin,
				items: commands.map((command) => ({
					name: command.name,
					hint: command.argumentHint ? ` ${command.argumentHint}` : "",
					description:
						command.description.length > 100
							? `${command.description.substring(0, 100)}...`
							: command.description,
				})),
			}));

			const output = renderTemplate(COMMANDS_TEMPLATE, {
				total: cache.commands.length,
				lastUpdated: new Date(cache.lastUpdated).toLocaleDateString(),
				plugins,
			});

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

			const byPlugin: Record<string, typeof cache.skills> = {};
			for (const skill of cache.skills) {
				if (!byPlugin[skill.plugin]) {
					byPlugin[skill.plugin] = [];
				}
				byPlugin[skill.plugin].push(skill);
			}

			const plugins = Object.entries(byPlugin).map(([plugin, skills]) => ({
				name: plugin,
				items: skills.map((skill) => ({
					name: skill.name,
					description:
						skill.description.length > 100 ? `${skill.description.substring(0, 100)}...` : skill.description,
				})),
			}));

			const output = renderTemplate(SKILLS_TEMPLATE, {
				total: cache.skills.length,
				lastUpdated: new Date(cache.lastUpdated).toLocaleDateString(),
				plugins,
			});

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
				output += `Use \`/ws_add ${workspace}\` to create one.`;
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
	 * Handle /ws_add command - explicitly create workspace session
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
	 * Handle /ws_del command - delete workspace session
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

function sanitizeForTelegramMarkdown(input: string): string {
	return input.replace(/_/g, "\\_").replace(/\*/g, "").replace(/`/g, "");
}

const AGENTS_TEMPLATE = [
	"🤖 **Available Claude Code Agents** ({{total}} total)",
	"",
	"{{#each plugins}}",
	"📦 *{{this.name}}*",
	"{{#each this.items}}",
	"",
	"  `\/{{this.name}}` - {{this.description}}",
	"{{#if this.tools}}",
	"  🔧 Tools: {{this.tools}}",
	"{{/if}}",
	"{{/each}}",
	"",
	"{{/each}}",
	"_Last updated: {{lastUpdated}}_",
].join("\n");

const COMMANDS_TEMPLATE = [
	"⚡ **Available Slash Commands** ({{total}} total)",
	"",
	"{{#each plugins}}",
	"📦 *{{this.name}}*",
	"{{#each this.items}}",
	"",
	"  `\/{{this.name}}{{this.hint}}`",
	"  {{this.description}}",
	"{{/each}}",
	"",
	"{{/each}}",
	"_Last updated: {{lastUpdated}}_",
].join("\n");

const SKILLS_TEMPLATE = [
	"🎯 **Available Agent Skills** ({{total}} total)",
	"",
	"{{#each plugins}}",
	"📦 *{{this.name}}*",
	"{{#each this.items}}",
	"",
	"  `rd2:{{this.name}}`",
	"  {{this.description}}",
	"{{/each}}",
	"",
	"{{/each}}",
	"_Last updated: {{lastUpdated}}_",
].join("\n");

const SCHEDULERS_TEMPLATE = [
	"## System Tasks",
	"",
	"{{#each systemTasks}}",
	"• {{this.id}}",
	"  - Schedule: {{this.schedule}}",
	"  - Source: {{this.source}}",
	"",
	"{{/each}}",
	"## User Tasks ({{userTaskCount}})",
	"",
	"{{#if noUserTasks}}",
	"No user-created scheduled tasks found.",
	"{{/if}}",
	"{{#each userTasks}}",
	"• {{this.id}}",
	"  - ID: {{this.id}}",
	"  - Instance: {{this.instance}}",
	"  - Schedule: {{this.schedule}}",
	"  - Next: {{this.next}}",
	"  - Status: {{this.status}}",
	"{{#if this.prompt}}",
	"  - Prompt: {{this.prompt}}",
	"{{/if}}",
	"",
	"{{/each}}",
].join("\n");
