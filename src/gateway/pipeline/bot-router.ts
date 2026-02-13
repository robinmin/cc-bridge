import { logger } from "@/packages/logger";
import type { Bot, Message } from "./index";

/**
 * BotRouter - Pattern-based instant routing to eliminate sequential bot processing
 *
 * Performance improvement:
 * - Before: Sequential processing with 120s timeout per bot (worst case: 360s)
 * - After: Instant pattern matching (<1ms) to correct bot
 *
 * Routing Strategy:
 * 1. MenuBot: /start, /help, /status, /ws_* workspace commands
 * 2. HostBot: /host_* host commands
 * 3. AgentBot: Everything else (natural language + /agents, /commands, /skills)
 */
export class BotRouter {
	private menuBot?: Bot;
	private hostBot?: Bot;
	private agentBot?: Bot;

	constructor(bots: Bot[]) {
		// Identify bots by name
		this.menuBot = bots.find((b) => b.name === "MenuBot");
		this.hostBot = bots.find((b) => b.name === "HostBot");
		this.agentBot = bots.find((b) => b.name === "AgentBot");

		// Validate required bots are present
		if (!this.agentBot) {
			logger.warn("BotRouter: AgentBot not found in bot list - fallback routing may fail");
		}
	}

	/**
	 * Route message to appropriate bot based on pattern matching
	 * Returns the bot that should handle this message
	 */
	route(message: Message): Bot | null {
		const text = message.text.trim();

		// Non-command messages always go to AgentBot
		if (!text.startsWith("/")) {
			logger.debug({ chatId: message.chatId }, "BotRouter: Natural language → AgentBot");
			return this.agentBot || null;
		}

		const command = text.split(" ")[0].toLowerCase();

		// MenuBot patterns
		if (this.isMenuBotCommand(command)) {
			logger.debug({ chatId: message.chatId, command }, "BotRouter: Menu command → MenuBot");
			return this.menuBot || null;
		}

		// HostBot patterns
		if (this.isHostBotCommand(command)) {
			logger.debug({ chatId: message.chatId, command }, "BotRouter: Host command → HostBot");
			return this.hostBot || null;
		}

		// AgentBot patterns (slash commands for agents/commands/skills)
		if (this.isAgentBotCommand(command)) {
			logger.debug({ chatId: message.chatId, command }, "BotRouter: Agent command → AgentBot");
			return this.agentBot || null;
		}

		// Default fallback: AgentBot handles unknown commands
		logger.debug({ chatId: message.chatId, command }, "BotRouter: Unknown command → AgentBot (fallback)");
		return this.agentBot || null;
	}

	/**
	 * Check if command belongs to MenuBot
	 */
	private isMenuBotCommand(command: string): boolean {
		const menuCommands = [
			"/start",
			"/help",
			"/status",
			"/bridge_status",
			"/ws_list",
			"/list", // Alias for /ws_list
			"/ws_status",
		];

		return menuCommands.includes(command);
	}

	/**
	 * Check if command belongs to HostBot
	 */
	private isHostBotCommand(command: string): boolean {
		// HostBot handles all /host_* commands
		return command.startsWith("/host_");
	}

	/**
	 * Check if command belongs to AgentBot
	 */
	private isAgentBotCommand(command: string): boolean {
		const agentCommands = ["/agents", "/commands", "/skills", "/ws_add", "/ws_switch", "/ws_current", "/ws_del"];

		return agentCommands.includes(command);
	}

	/**
	 * Get routing statistics for monitoring
	 */
	getStats(): { menuBot: boolean; hostBot: boolean; agentBot: boolean } {
		return {
			menuBot: !!this.menuBot,
			hostBot: !!this.hostBot,
			agentBot: !!this.agentBot,
		};
	}
}
