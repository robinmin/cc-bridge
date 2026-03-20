/**
 * In-Process Execution Engine
 *
 * Thin adapter that implements IExecutionEngine using EmbeddedAgent.
 * Uses AgentSessionManager to maintain per-chat agent instances with
 * multi-turn conversation support via pi-agent-core's agent loop.
 *
 * This replaces the previous completeSimple-based implementation with
 * a full-featured agent that supports tool calling, workspace injection,
 * and streaming events.
 */

import path from "node:path";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import type { MemoryIndexer } from "@/packages/agent/memory/indexer/indexer";
import {
	buildAgentConfig,
	type AgentYamlConfig,
	createDefaultTools,
	type PromptOptions,
	resolveProviderApiKey,
	type ToolPolicyConfig,
} from "@/packages/agent";
import { logger } from "@/packages/logger";
import { AgentSessionManager, type AgentSessionManagerConfig } from "./agent-sessions";
import type { ExecutionRequest, ExecutionResult, IExecutionEngine, LayerHealth } from "./contracts";

/**
 * In-process execution engine using EmbeddedAgent.
 *
 * Implements IExecutionEngine with backward-compatible interface.
 * All new agent capabilities (tools, streaming, maxIterations) are
 * accessed via optional fields on ExecutionOptions.
 */
export class InProcessEngine implements IExecutionEngine {
	private readonly enabled: boolean;
	private readonly agentConfig: AgentYamlConfig;
	private readonly sessionManager: AgentSessionManager;

	constructor(
		enabled: boolean = false,
		agentConfigOrProvider?: AgentYamlConfig | string,
		sessionConfigOrModel?: AgentSessionManagerConfig | string,
		memoryIndexer?: MemoryIndexer,
	) {
		this.enabled = enabled;

		// Detect signature: backward-compatible overload
		// Old signature: (enabled, defaultProvider, defaultModel, sessionConfig, memoryIndexer)
		// New signature: (enabled, agentConfig, sessionConfig, memoryIndexer)
		if (typeof agentConfigOrProvider === "string") {
			// Old signature: second arg is provider string, third is model string
			const defaultProvider = agentConfigOrProvider;
			const defaultModel = typeof sessionConfigOrModel === "string" ? sessionConfigOrModel : undefined;
			const sessionConfig = typeof sessionConfigOrModel === "object" ? sessionConfigOrModel : undefined;

			this.agentConfig = {
				provider: { default: defaultProvider || process.env.LLM_PROVIDER || "anthropic" },
				model: { default: defaultModel || process.env.LLM_MODEL || "claude-sonnet-4-6" },
				tools: { enabled: true, policy: { default: "read-only" } },
				memory: { enabled: true, backend: "builtin" },
				rag: { enabled: false },
			};

			// Inject memoryIndexer into session config if provided
			const effectiveSessionConfig: AgentSessionManagerConfig = memoryIndexer
				? { ...sessionConfig, memoryIndexer }
				: sessionConfig;
			this.sessionManager = new AgentSessionManager(effectiveSessionConfig);
		} else {
			// New signature: second arg is AgentYamlConfig
			const agentConfig = agentConfigOrProvider;

			// Use provided config or defaults
			this.agentConfig =
				agentConfig ||
				({
					provider: { default: process.env.LLM_PROVIDER || "anthropic" },
					model: { default: process.env.LLM_MODEL || "claude-sonnet-4-6" },
					tools: { enabled: true, policy: { default: "read-only" } },
					memory: { enabled: true, backend: "builtin" },
					rag: { enabled: false },
				} as AgentYamlConfig);

			// Inject memoryIndexer into session config if provided
			const effectiveSessionConfig: AgentSessionManagerConfig = memoryIndexer
				? { ...sessionConfigOrModel, memoryIndexer }
				: sessionConfigOrModel;
			this.sessionManager = new AgentSessionManager(effectiveSessionConfig);
		}
	}

	getLayer(): "in-process" {
		return "in-process";
	}

	async isAvailable(): Promise<boolean> {
		if (!this.enabled) {
			return false;
		}

		// Check if API key is available for the default provider (M5: use shared resolver)
		const apiKey = resolveProviderApiKey(this.agentConfig.provider.default);
		if (!apiKey) {
			logger.warn({ provider: this.agentConfig.provider.default }, "In-process engine: No API key configured for provider");
			return false;
		}

		logger.debug({ provider: this.agentConfig.provider.default, model: this.agentConfig.model.default }, "In-process engine available");
		return true;
	}

	async execute(request: ExecutionRequest): Promise<ExecutionResult> {
		if (!this.enabled) {
			return {
				status: "failed",
				error: "In-process engine is not enabled. Set ENABLE_IN_PROCESS=true environment variable.",
				retryable: false,
			};
		}

		const timeoutMs = request.options?.timeout || 120000;
		const chatId = request.options?.chatId || `in-process-${Date.now()}`;
		const maxIterations = request.options?.maxIterations ?? 50;

		// Resolve workspace directory
		const workspace = request.options?.workspace || "default";
		const workspaceDir = path.resolve(GATEWAY_CONSTANTS.CONFIG.PROJECTS_ROOT, workspace);

		// M3: Path traversal validation — ensure workspace is within PROJECTS_ROOT
		const projectsRoot = path.resolve(GATEWAY_CONSTANTS.CONFIG.PROJECTS_ROOT);
		if (!workspaceDir.startsWith(projectsRoot + path.sep) && workspaceDir !== projectsRoot) {
			return {
				status: "failed",
				error: `Workspace path "${workspace}" resolves outside of PROJECTS_ROOT. Possible path traversal attempt.`,
				retryable: false,
			};
		}

		logger.info(
			{
				chatId,
				promptLength: request.prompt.length,
				timeoutMs,
				maxIterations,
				provider: this.agentConfig.provider.default,
				model: this.agentConfig.model.default,
				workspace,
			},
			"Executing via in-process agent engine",
		);

		const startTime = Date.now();

		try {
			// Get tool policy from options
			const toolPolicy = request.options?.toolPolicy as ToolPolicyConfig | undefined;

			// Build session-level agent config using the YAML config as base
			// This separates agent config concerns from gateway code
			const effectiveAgentConfig = buildAgentConfig(this.agentConfig, {
				sessionId: String(chatId),
				workspaceDir,
				workspace,
			});

			// Override tools if explicitly configured or if toolPolicy is passed
			if (this.agentConfig.tools?.enabled !== false || toolPolicy) {
				effectiveAgentConfig.tools = createDefaultTools(workspaceDir, toolPolicy, String(chatId));
			}

			// Per-request options passed to prompt(), not stored on the session
			const promptOptions: PromptOptions = {
				maxIterations,
				timeoutMs,
				onEvent: request.options?.onEvent,
				onImmediate: request.options?.onImmediate,
			};

			// Get or create an agent for this chat session
			const agent = this.sessionManager.getOrCreate(chatId, effectiveAgentConfig);

			// Execute the prompt and collect results
			let result = await agent.prompt(request.prompt, promptOptions);

			// Process follow-up queue after prompt completes
			const followUps = agent.drainFollowUpQueue();
			if (followUps.length > 0) {
				logger.info({ chatId, followUpCount: followUps.length }, "Processing follow-up messages");
				for (const followUp of followUps) {
					try {
						const followUpResult = await agent.prompt(followUp, promptOptions);
						if (followUpResult.output) {
							result = {
								...result,
								output: result.output ? `${result.output}\n\n---\n\n${followUpResult.output}` : followUpResult.output,
							};
						}
					} catch (error) {
						logger.warn({ chatId, error }, "Follow-up message execution failed");
					}
				}
			}

			const durationMs = Date.now() - startTime;

			if (result.aborted) {
				logger.warn(
					{
						chatId,
						durationMs,
						turnCount: result.turnCount,
						maxIterations,
					},
					"Agent execution aborted (timeout or max iterations)",
				);

				// Still return whatever output was collected
				if (result.output) {
					return {
						status: "completed",
						output: result.output,
						exitCode: 0,
						retryable: false,
					};
				}

				return {
					status: "failed",
					error: `Agent execution aborted after ${result.turnCount} turns`,
					retryable: true,
					isTimeout: true,
				};
			}

			logger.info(
				{
					chatId,
					outputLength: result.output.length,
					durationMs,
					turnCount: result.turnCount,
					toolCalls: result.toolCalls.length,
				},
				"In-process agent execution completed",
			);

			// Phase 4: Persist session state after successful execution
			this.sessionManager.persistSession(chatId);

			return {
				status: "completed",
				output: result.output,
				exitCode: 0,
				retryable: false,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const durationMs = Date.now() - startTime;

			// Check for timeout/abort errors
			const isAbortError =
				error instanceof Error &&
				(error.name === "AbortError" ||
					error.message.includes("abort") ||
					error.message.includes("timeout") ||
					(error.cause instanceof Error && error.cause.name === "AbortError"));

			if (isAbortError) {
				logger.warn({ chatId, timeoutMs, durationMs }, "In-process agent execution timed out");
				return {
					status: "failed",
					error: `In-process execution timed out after ${timeoutMs}ms`,
					retryable: true,
					isTimeout: true,
				};
			}

			logger.error({ chatId, error: errorMessage, durationMs }, "In-process agent execution failed");
			return {
				status: "failed",
				error: `In-process execution failed: ${errorMessage}`,
				retryable: false,
			};
		}
	}

	async getHealth(): Promise<LayerHealth> {
		const available = await this.isAvailable();
		return {
			layer: "in-process",
			available,
			lastCheck: new Date(),
			error: available ? undefined : "Feature flag disabled or API key not configured",
		};
	}

	/**
	 * Get the session manager for external access (e.g., cleanup, metrics).
	 */
	getSessionManager(): AgentSessionManager {
		return this.sessionManager;
	}

	/**
	 * Stop the engine and clean up all sessions.
	 */
	dispose(): void {
		this.sessionManager.dispose();
	}
}
