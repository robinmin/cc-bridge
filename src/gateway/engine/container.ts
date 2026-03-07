/**
 * Container Execution Engine
 *
 * Docker container execution via tmux persistent sessions.
 */

import crypto from "node:crypto";
import { logger } from "@/packages/logger";
import type { ExecutionRequest, ExecutionResult, IExecutionEngine, LayerHealth } from "./contracts";

/** Default timeout */
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Container execution engine
 * Uses tmux sessions for async execution in Docker containers
 */
export class ContainerEngine implements IExecutionEngine {
	private tmuxManager: TmuxManagerWrapper | null = null;
	private readonly injectedTmuxManager: TmuxManagerWrapper | null = null;

	constructor(tmuxManager?: TmuxManagerWrapper) {
		// Allow injection of mock TmuxManager for testing
		if (tmuxManager) {
			this.injectedTmuxManager = tmuxManager;
			this.tmuxManager = tmuxManager;
		}
	}

	getLayer(): "container" {
		return "container";
	}

	async isAvailable(): Promise<boolean> {
		// Check Docker availability
		try {
			const proc = Bun.spawn(["docker", "info"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
			return proc.exitCode === 0;
		} catch {
			return false;
		}
	}

	async execute(request: ExecutionRequest): Promise<ExecutionResult> {
		const options = request.options || {};

		// Always use tmux for container execution (async mode)
		if (!request.instance && !request.containerId) {
			return {
				status: "failed",
				error: "Container engine requires either instance or containerId",
				retryable: false,
			};
		}

		const containerId = request.containerId || request.instance?.containerId;
		const instanceName = request.instance?.name || "unknown";
		const workspace = options.workspace || "cc-bridge";
		const chatId = options.chatId;
		const timeout = options.timeout || DEFAULT_TIMEOUT_MS;

		// Build prompt with history if provided
		const { buildClaudePrompt } = require("./prompt-utils");
		const prompt =
			options.history && options.history.length > 0
				? buildClaudePrompt(request.prompt, options.history)
				: request.prompt;

		// Always use tmux for container execution (async mode)
		return this.executeViaTmux(containerId, instanceName, prompt, {
			workspace,
			chatId: String(chatId || "default"),
			timeout,
		});
	}

	async getHealth(): Promise<LayerHealth> {
		const available = await this.isAvailable();
		return {
			layer: "container",
			available,
			lastCheck: new Date(),
			error: available ? undefined : "Docker not available",
		};
	}

	// =============================================================================
	// Private Methods - Tmux Mode
	// =============================================================================

	private async executeViaTmux(
		containerId: string,
		instanceName: string,
		prompt: string,
		params: {
			workspace: string;
			chatId: string;
			timeout: number;
		},
	): Promise<ExecutionResult> {
		const requestId = crypto.randomUUID();

		try {
			const manager = this.getTmuxManager();

			// Get or create tmux session
			const sessionName = await manager.getOrCreateSession(containerId, params.workspace, params.chatId);

			// Send prompt to session
			await manager.sendToSession(containerId, sessionName, prompt, {
				requestId,
				chatId: params.chatId,
				workspace: params.workspace,
			});

			logger.info(
				{ requestId, containerId, instanceName, sessionName, promptLength: prompt.length },
				"Prompt sent via tmux",
			);

			// Return async result - response comes via callback
			return {
				status: "running",
				requestId,
				mode: "tmux",
			};
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				retryable: false,
			};
		}
	}

	private getTmuxManager(): TmuxManagerWrapper {
		// Use injected manager if available (for testing)
		if (this.injectedTmuxManager) {
			return this.injectedTmuxManager;
		}
		if (!this.tmuxManager) {
			// Dynamic import to avoid circular dependencies
			const { TmuxManager } = require("@/gateway/services/tmux-manager");
			this.tmuxManager = new TmuxManagerWrapper(new TmuxManager());
		}
		return this.tmuxManager;
	}
}

/**
 * Wrapper for TmuxManager to provide a cleaner interface
 */
// TmuxManager type interface
interface TmuxManagerType {
	getOrCreateSession(containerId: string, workspace: string, chatId: string): Promise<string>;
	sendToSession(
		containerId: string,
		sessionName: string,
		prompt: string,
		metadata: { requestId: string; chatId: string; workspace: string },
	): Promise<void>;
}
export class TmuxManagerWrapper {
	constructor(private manager: TmuxManagerType) {}

	async getOrCreateSession(containerId: string, workspace: string, chatId: string): Promise<string> {
		return this.manager.getOrCreateSession(containerId, workspace, chatId);
	}

	async sendToSession(
		containerId: string,
		sessionName: string,
		prompt: string,
		metadata: { requestId: string; chatId: string; workspace: string },
	): Promise<void> {
		return this.manager.sendToSession(containerId, sessionName, prompt, metadata);
	}
}

/**
 * Factory function to create container engine
 */
export function createContainerEngine(): ContainerEngine {
	return new ContainerEngine();
}
