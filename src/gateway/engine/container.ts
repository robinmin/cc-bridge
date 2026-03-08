/**
 * Container Execution Engine
 *
 * Docker container execution via tmux persistent sessions.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { ResponseFileReader } from "@/gateway/services/ResponseFileReader";
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
	private responseFileReader: ResponseFileReader | null = null;

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
			sync: options.sync ?? false,
			ephemeralSession: options.ephemeralSession ?? false,
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
			sync: boolean;
			ephemeralSession: boolean;
		},
	): Promise<ExecutionResult> {
		const requestId = crypto.randomUUID();
		let sessionName: string | null = null;

		try {
			const manager = this.getTmuxManager();

			// Get or create tmux session
			sessionName = await manager.getOrCreateSession(containerId, params.workspace, params.chatId);

			// Send prompt to session
			await manager.sendToSession(containerId, sessionName, prompt, {
				requestId,
				chatId: params.chatId,
				workspace: params.workspace,
				sync: params.sync,
			});

			logger.info(
				{ requestId, containerId, instanceName, sessionName, promptLength: prompt.length },
				"Prompt sent via tmux",
			);

			if (params.sync) {
				const result = await this.waitForResponseFile(params.workspace, requestId, params.timeout);
				if (params.ephemeralSession && sessionName) {
					await manager.killSession(containerId, sessionName);
				}
				return result;
			}

			// Return async result - response comes via callback
			return {
				status: "running",
				requestId,
				mode: "tmux",
			};
		} catch (error) {
			if (params.ephemeralSession && sessionName) {
				await this.getTmuxManager()
					.killSession(containerId, sessionName)
					.catch((cleanupError) => {
						logger.warn(
							{ containerId, sessionName, cleanupError: String(cleanupError) },
							"Failed to clean up ephemeral container tmux session",
						);
					});
			}
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

	private getResponseFileReader(): ResponseFileReader {
		if (!this.responseFileReader) {
			this.responseFileReader = new ResponseFileReader({
				ipcBasePath: GATEWAY_CONSTANTS.FILESYSTEM_IPC.BASE_DIR,
				maxFileSize: GATEWAY_CONSTANTS.FILESYSTEM_IPC.MAX_FILE_SIZE_MB * 1024 * 1024,
				maxReadRetries: 3,
				readRetryDelayMs: 100,
			});
		}
		return this.responseFileReader;
	}

	private async waitForResponseFile(workspace: string, requestId: string, timeout: number): Promise<ExecutionResult> {
		const reader = this.getResponseFileReader();
		const startedAt = Date.now();
		const pollIntervalMs = 500;

		while (Date.now() - startedAt < timeout) {
			if (await reader.exists(workspace, requestId)) {
				try {
					const response = await reader.readResponseFile(workspace, requestId);
					await this.deleteResponseFile(workspace, requestId);

					if (response.exitCode === 0) {
						return {
							status: "completed",
							output: response.output,
							exitCode: response.exitCode,
							retryable: false,
						};
					}

					return {
						status: "failed",
						output: response.output,
						exitCode: response.exitCode,
						error: response.error || `Container execution failed with exit code ${response.exitCode}`,
						retryable: false,
					};
				} catch (error) {
					logger.debug({ workspace, requestId, error: String(error) }, "Response file not ready yet");
				}
			}

			await this.sleep(pollIntervalMs);
		}

		return {
			status: "timeout",
			error: `Container response timed out after ${timeout}ms`,
			retryable: true,
			isTimeout: true,
		};
	}

	private async deleteResponseFile(workspace: string, requestId: string): Promise<void> {
		const filePath = path.join(GATEWAY_CONSTANTS.FILESYSTEM_IPC.BASE_DIR, workspace, "responses", `${requestId}.json`);
		await fs.unlink(filePath).catch(() => {});
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Wrapper for TmuxManager to provide a cleaner interface
 */
// TmuxManager type interface
interface TmuxManagerType {
	getOrCreateSession(containerId: string, workspace: string, chatId: string): Promise<string>;
	killSession(containerId: string, sessionName: string): Promise<void>;
	sendToSession(
		containerId: string,
		sessionName: string,
		prompt: string,
		metadata: { requestId: string; chatId: string; workspace: string; sync?: boolean },
	): Promise<void>;
}
export class TmuxManagerWrapper {
	constructor(private manager: TmuxManagerType) {}

	async getOrCreateSession(containerId: string, workspace: string, chatId: string): Promise<string> {
		return this.manager.getOrCreateSession(containerId, workspace, chatId);
	}

	async killSession(containerId: string, sessionName: string): Promise<void> {
		return this.manager.killSession(containerId, sessionName);
	}

	async sendToSession(
		containerId: string,
		sessionName: string,
		prompt: string,
		metadata: { requestId: string; chatId: string; workspace: string; sync?: boolean },
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
