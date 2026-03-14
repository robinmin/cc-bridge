import crypto from "node:crypto";
import path from "node:path";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { Channel } from "@/gateway/channels";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import {
	type ClaudeAsyncExecutionResult,
	type ClaudeExecutionConfigExtended,
	type ClaudeExecutionResultOrAsync,
	isAsyncResult,
	validateAndSanitizePrompt,
} from "@/gateway/engine";
import type { ExecutionRequest, ExecutionResult } from "@/gateway/engine/contracts";
import { InProcessEngine } from "@/gateway/engine/in-process";
import { getExecutionOrchestrator } from "@/gateway/engine/orchestrator";
import { instanceManager } from "@/gateway/instance-manager";
import { buildMemoryBootstrapContext, persistConversationMemory, resolveMemoryConfig } from "@/gateway/memory/manager";
import { inferGroupContext } from "@/gateway/memory/policy";
import { persistence } from "@/gateway/persistence";
import { discoveryCache } from "@/gateway/services/discovery-cache";
import { SessionPoolService } from "@/gateway/services/SessionPoolService";
import { TmuxManager } from "@/gateway/services/tmux-manager";
import { logger } from "@/packages/logger";
import { renderTemplate } from "@/packages/template";
import type { Bot, Message } from "./index";

// =============================================================================
// Streaming Support
// =============================================================================

/** Streaming state for a single execution */
interface StreamingState {
	chatId: string | number;
	messageId?: string | number; // For edits
	pendingText: string;
	debounceTimer?: ReturnType<typeof setTimeout>;
	lastUpdateMs: number;
}

// Default streaming config
const STREAMING_DEBOUNCE_MS = 300; // Batch updates every 300ms
const STREAMING_ENABLED = process.env.ENABLE_STREAMING === "true";

export class AgentBot implements Bot {
	name = "AgentBot";
	static readonly MENU_COMMANDS = [
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
		{ command: "clear", description: "Hard reset - kill session entirely" },
		{ command: "compact", description: "Soft reset - reduce context, keep session" },
		{ command: "context_status", description: "Show session context metadata" },
	];

	// Per-container session pools (key: containerId)
	private sessionPools: Map<string, SessionPoolService> = new Map();
	private tmuxManager = new TmuxManager();
	private memoryConfig = resolveMemoryConfig(GATEWAY_CONSTANTS.DEFAULT_CONFIG.memory);
	private projectsRoot = GATEWAY_CONSTANTS.CONFIG.PROJECTS_ROOT;

	// Streaming state per chat (for real-time updates)
	private streamingStates: Map<string, StreamingState> = new Map();

	constructor(
		private channel: Channel,
		private persistenceManager = persistence,
		options?: { projectsRoot?: string; memory?: unknown },
	) {
		if (options?.projectsRoot) {
			this.projectsRoot = options.projectsRoot;
		}
		if (options?.memory) {
			this.memoryConfig = resolveMemoryConfig(options.memory);
		}
	}

	// =============================================================================
	// Streaming Methods
	// =============================================================================

	/**
	 * Create a streaming event handler for real-time updates to Telegram/Feishu.
	 * Returns an onImmediate callback that can be passed to the execution engine.
	 */
	private createStreamingCallback(chatId: string | number): (event: AgentEvent) => void {
		const key = String(chatId);
		const state: StreamingState = {
			chatId,
			pendingText: "",
			lastUpdateMs: Date.now(),
		};
		this.streamingStates.set(key, state);

		return (event: AgentEvent) => {
			switch (event.type) {
				case "message_start": {
					// Start a new message - send initial "thinking" message
					this.sendInitialStreamingMessage(state);
					break;
				}

				case "message_update": {
					// Accumulate text delta for incremental updates
					if (event.delta && "text" in event.delta && typeof event.delta.text === "string") {
						state.pendingText += event.delta.text;
						this.scheduleStreamingUpdate(state);
					}
					break;
				}

				case "message_end": {
					// Final message - flush any pending text
					this.flushStreamingMessage(state);
					break;
				}

				case "tool_execution_start": {
					// Tool execution started - show status
					this.sendToolStatusMessage(state, event.toolName, "start");
					break;
				}

				case "tool_execution_end": {
					// Tool execution ended - show result summary
					this.sendToolStatusMessage(state, event.toolName, event.isError ? "error" : "end");
					break;
				}

				case "turn_end": {
					// Turn completed - flush any pending text
					this.flushStreamingMessage(state);
					break;
				}

				// agent_start, agent_end: handled by message_end
				// tool_execution_update: ignore for now
			}
		};
	}

	/**
	 * Send initial "thinking" message to start streaming
	 */
	private async sendInitialStreamingMessage(state: StreamingState): Promise<void> {
		try {
			await this.channel.sendMessage(state.chatId, "🤔 Thinking...");
			// Note: In a real implementation, we'd capture the messageId for editing
			// For now, we'll just send new messages
			logger.debug({ chatId: state.chatId }, "Sent initial streaming message");
		} catch (error) {
			logger.error({ chatId: state.chatId, error }, "Failed to send initial streaming message");
		}
	}

	/**
	 * Schedule a debounced streaming update
	 */
	private scheduleStreamingUpdate(state: StreamingState): void {
		// Clear existing timer
		if (state.debounceTimer) {
			clearTimeout(state.debounceTimer);
		}

		// Schedule new update
		state.debounceTimer = setTimeout(() => {
			this.flushStreamingMessage(state);
		}, STREAMING_DEBOUNCE_MS);
	}

	/**
	 * Flush pending streaming text to the channel
	 */
	private async flushStreamingMessage(state: StreamingState): Promise<void> {
		if (!state.pendingText.trim()) return;

		// Try to edit existing message first, otherwise send new
		if (state.messageId && this.channel.editMessage) {
			try {
				await this.channel.editMessage(state.chatId, state.messageId, state.pendingText);
			} catch (error) {
				// Fall back to sending new message if edit fails
				logger.debug({ chatId: state.chatId, error }, "Edit failed, sending new message");
				await this.channel.sendMessage(state.chatId, state.pendingText);
			}
		} else {
			await this.channel.sendMessage(state.chatId, state.pendingText);
		}

		state.pendingText = "";
		state.lastUpdateMs = Date.now();
	}

	/**
	 * Send tool execution status message
	 */
	private async sendToolStatusMessage(
		state: StreamingState,
		toolName: string,
		status: "start" | "end" | "error",
	): Promise<void> {
		const emoji = status === "start" ? "🔧" : status === "error" ? "❌" : "✅";
		const text =
			status === "start"
				? `${emoji} Running ${toolName}...`
				: status === "error"
					? `${emoji} ${toolName} failed`
					: `${emoji} ${toolName} completed`;

		await this.channel.sendMessage(state.chatId, text);
	}

	/**
	 * Clean up streaming state for a chat
	 */
	private cleanupStreamingState(chatId: string | number): void {
		const key = String(chatId);
		const state = this.streamingStates.get(key);
		if (state?.debounceTimer) {
			clearTimeout(state.debounceTimer);
		}
		this.streamingStates.delete(key);
	}

	getMenus() {
		return AgentBot.MENU_COMMANDS;
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
		if (text === "/compact") {
			await this.handleCompact(message, instance, workspace);
			return true;
		}
		if (text === "/context_status") {
			await this.handleContextStatus(message, instance, workspace);
			return true;
		}
		if (text.startsWith("/scheduler_add ")) {
			const match = text.match(/^\/scheduler_add\s+(\S+)\s+(once|recurring|cron)\s+(.+)$/);
			if (match) {
				const instanceName = match[1];
				const scheduleType = match[2];
				const remainder = match[3].trim();

				if (scheduleType === "cron") {
					const cronParts = remainder.split(/\s+/);
					if (cronParts.length >= 6) {
						const scheduleValue = cronParts.slice(0, 5).join(" ");
						const prompt = cronParts.slice(5).join(" ").trim();
						if (prompt) {
							await this.handleSchedulerAdd(message, instanceName, scheduleType, scheduleValue, prompt);
						} else {
							await this.channel.sendMessage(
								message.chatId,
								'Usage: /scheduler_add <instance> <once|recurring|cron> <schedule> <prompt>\nExamples:\n/scheduler_add cc-bridge recurring 1h "Daily summary"\n/scheduler_add cc-bridge cron 0 9 * * 1-5 "Weekday report"',
							);
						}
					} else {
						await this.channel.sendMessage(
							message.chatId,
							'Usage: /scheduler_add <instance> <once|recurring|cron> <schedule> <prompt>\nExamples:\n/scheduler_add cc-bridge recurring 1h "Daily summary"\n/scheduler_add cc-bridge cron 0 9 * * 1-5 "Weekday report"',
						);
					}
				} else {
					const intervalMatch = remainder.match(/^(\S+)\s+(.+)$/);
					if (intervalMatch) {
						await this.handleSchedulerAdd(
							message,
							instanceName,
							scheduleType,
							intervalMatch[1],
							intervalMatch[2].trim(),
						);
					} else {
						await this.channel.sendMessage(
							message.chatId,
							'Usage: /scheduler_add <instance> <once|recurring|cron> <schedule> <prompt>\nExamples:\n/scheduler_add cc-bridge recurring 1h "Daily summary"\n/scheduler_add cc-bridge cron 0 9 * * 1-5 "Weekday report"',
						);
					}
				}
			} else {
				await this.channel.sendMessage(
					message.chatId,
					'Usage: /scheduler_add <instance> <once|recurring|cron> <schedule> <prompt>\nExamples:\n/scheduler_add cc-bridge recurring 1h "Daily summary"\n/scheduler_add cc-bridge cron 0 9 * * 1-5 "Weekday report"',
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

		// 5b. Check if in-process agent is already running for this chat — steer or queue
		const orchestrator = getExecutionOrchestrator();
		const inProcessEngine = orchestrator.getEngine("in-process");
		if (inProcessEngine && inProcessEngine instanceof InProcessEngine) {
			const sessionManager = inProcessEngine.getSessionManager();
			if (sessionManager.isRunning(message.chatId)) {
				const action = sessionManager.steerOrQueue(message.chatId, validationResult.sanitized);
				logger.info({ chatId: message.chatId, action }, "Message steered/queued during active execution");
				if (action === "steered") {
					await this.channel.sendMessage(message.chatId, "Message injected into active execution.");
				} else {
					await this.channel.sendMessage(message.chatId, "Message queued for after current execution.");
				}
				await this.persistenceManager.storeMessage(message.chatId, "user", message.text, workspace);
				return true;
			}
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
			await this.persistMemoryForMessage(message, workspace, history);

			return true;
		}

		// Sync mode: handle result immediately
		if (result.success && result.output) {
			await this.channel.sendMessage(message.chatId, result.output);

			// Store agent response (workspace-specific)
			await this.persistenceManager.storeMessage(message.chatId, "agent", result.output, workspace);
			await this.persistMemoryForMessage(message, workspace, history, result.output);
			return true;
		}

		// 7. Handle error case
		const errorMsg = result.error || "Unknown error";
		await this.channel.sendMessage(message.chatId, `❌ Error: ${errorMsg}`);

		return true;
	}

	private async persistMemoryForMessage(
		message: Message,
		workspace: string,
		history: Array<{ sender: string; text: string; timestamp: string }>,
		assistantText?: string,
	): Promise<void> {
		try {
			const workspacePath = path.join(this.projectsRoot, workspace);
			const stats = await persistConversationMemory({
				config: this.memoryConfig,
				workspaceRoot: workspacePath,
				userText: message.text,
				assistantText,
				historyForFlush: history,
			});
			logger.debug(
				{
					chatId: message.chatId,
					workspace,
					memory: stats,
				},
				"Conversation memory persistence processed",
			);
		} catch (error) {
			logger.warn(
				{
					chatId: message.chatId,
					workspace,
					error: error instanceof Error ? error.message : String(error),
				},
				"Conversation memory persistence failed (non-fatal)",
			);
		}
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
				prompt: task.prompt && task.prompt.length > 80 ? `${task.prompt.substring(0, 80)}...` : task.prompt || "",
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

	/**
	 * Handle /compact command - soft reset (preserves session, reduces context)
	 */
	private async handleCompact(
		message: Message,
		instance: { name: string; containerId: string; status: string },
		workspace: string,
	): Promise<void> {
		try {
			const compacted = await this.tmuxManager.softReset(instance.containerId, workspace, message.chatId);
			if (compacted) {
				await this.channel.sendMessage(
					message.chatId,
					"✅ Compacted session context. The AI will respond with reduced context.",
				);
			} else {
				await this.channel.sendMessage(message.chatId, "ℹ️ No active session to compact.");
			}
		} catch (error) {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to compact session");
			await this.channel.sendMessage(message.chatId, "⚠️ Failed to compact session.");
		}
	}

	/**
	 * Handle /context_status command - show session context metadata
	 */
	private async handleContextStatus(
		message: Message,
		instance: { name: string; containerId: string; status: string },
		workspace: string,
	): Promise<void> {
		try {
			const sessionName = `claude-${workspace}-${message.chatId}`;
			const metadata = this.tmuxManager.getSessionMetadata(sessionName, instance.containerId);

			const createdAt = new Date(metadata.createdAt);
			const lastActivity = new Date(metadata.lastActivityAt);
			const lastReset = new Date(metadata.lastResetAt);
			const now = new Date();

			const sessionAge = this.formatDuration(now.getTime() - createdAt.getTime());
			const idleTime = this.formatDuration(now.getTime() - lastActivity.getTime());
			const timeSinceReset = this.formatDuration(now.getTime() - lastReset.getTime());

			const statusMessage = [
				"📊 **Session Context Status**",
				``,
				`• **Turns**: ${metadata.turnCount}`,
				`• **Est. Context Size**: ~${Math.round(metadata.estimatedContextSize / 1000)}k tokens`,
				`• **Session Age**: ${sessionAge}`,
				`• **Idle Time**: ${idleTime}`,
				`• **Last Reset**: ${timeSinceReset} ago`,
				``,
				`💡 Use \`/compact\` to reduce context without losing session`,
				`💡 Use \`/clear\` to hard reset (kills session)`,
			].join("\n");

			await this.channel.sendMessage(message.chatId, statusMessage);
		} catch (error) {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to get context status");
			await this.channel.sendMessage(message.chatId, "⚠️ Failed to get context status.");
		}
	}

	/**
	 * Format duration in human-readable form
	 */
	private formatDuration(ms: number): string {
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);

		if (days > 0) return `${days}d ${hours % 24}h`;
		if (hours > 0) return `${hours}h ${minutes % 60}m`;
		if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
		return `${seconds}s`;
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
		const workspacePath = path.join(this.projectsRoot, workspace);
		const isGroupContext = inferGroupContext(message.channelId, message.chatId);
		const memoryContext = await buildMemoryBootstrapContext({
			config: this.memoryConfig,
			workspaceRoot: workspacePath,
			isGroupContext,
		});
		const effectivePrompt = memoryContext ? `${memoryContext}\n\nUser request:\n${message.text}` : message.text;

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

		// Create streaming callback if enabled
		const onImmediate = STREAMING_ENABLED ? this.createStreamingCallback(message.chatId) : undefined;

		// Execute via unified orchestrator
		const request: ExecutionRequest = {
			prompt: effectivePrompt,
			options: {
				timeout: config.timeout,
				workspace: config.workspace,
				chatId: config.chatId,
				history: config.history,
				allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
				allowedTools: config.allowedTools,
				streaming: STREAMING_ENABLED,
				onImmediate,
			},
			containerId: instance.containerId,
		};

		let orchestratorResult: ExecutionResult;

		try {
			orchestratorResult = await getExecutionOrchestrator().execute(request);
		} finally {
			// Clean up streaming state after execution completes
			if (onImmediate) {
				this.cleanupStreamingState(message.chatId);
			}
		}

		// Convert ExecutionResult to ClaudeExecutionResult format
		let result: ClaudeExecutionResultOrAsync = {
			success: orchestratorResult.status === "completed",
			output: orchestratorResult.output,
			error: orchestratorResult.error,
			exitCode: orchestratorResult.exitCode,
			retryable: orchestratorResult.retryable,
			isTimeout: orchestratorResult.isTimeout,
			requestId: orchestratorResult.requestId,
		};

		// For tmux async mode, return in async format
		if (orchestratorResult.mode === "tmux") {
			const asyncResult = result as ClaudeAsyncExecutionResult;
			asyncResult.requestId = orchestratorResult.requestId || crypto.randomUUID();
			asyncResult.mode = "tmux";
			logger.info(
				{ requestId: asyncResult.requestId, chatId: message.chatId },
				"Async request submitted, waiting for callback",
			);
			return asyncResult;
		}

		// Sync mode: handle retry logic for stale containers
		// If retryable error (stale container), refresh and retry once
		if (!result.success && result.retryable) {
			logger.info({ instance: instance.name }, "Refreshing instances and retrying Claude execution");

			const instances = await instanceManager.refresh();
			const refreshedInstance = instances.find((i) => i.name === instance.name);

			if (refreshedInstance && refreshedInstance.status === "running") {
				request.containerId = refreshedInstance.containerId;
				orchestratorResult = await getExecutionOrchestrator().execute(request);
				result = {
					success: orchestratorResult.status === "completed",
					output: orchestratorResult.output,
					error: orchestratorResult.error,
					exitCode: orchestratorResult.exitCode,
					retryable: orchestratorResult.retryable,
					isTimeout: orchestratorResult.isTimeout,
				};
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
					description: agent.description.length > 80 ? `${agent.description.substring(0, 80)}...` : agent.description,
					tools: agent.tools ? agent.tools.slice(0, 3).join(", ") + (agent.tools.length > 3 ? "..." : "") : "",
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
						command.description.length > 100 ? `${command.description.substring(0, 100)}...` : command.description,
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
					description: skill.description.length > 100 ? `${skill.description.substring(0, 100)}...` : skill.description,
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
	"  `/{{this.name}}` - {{this.description}}",
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
	"  `/{{this.name}}{{this.hint}}`",
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
