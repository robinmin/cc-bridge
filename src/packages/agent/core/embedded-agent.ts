/**
 * EmbeddedAgent - Standalone Agent Wrapper
 *
 * Wraps pi-agent-core's Agent class with workspace file injection,
 * event collection, session management, and maxIterations guard.
 *
 * This is a standalone, reusable component independent of the execution engine layer.
 *
 * Key design corrections applied (from architect review):
 * 1. Agent.prompt() returns Promise<void> - results collected via subscribe()
 * 2. steer() takes AgentMessage, not string - wrapped into UserMessage
 * 3. Agent uses setter methods (setSystemPrompt, setModel, setTools), not constructor config
 * 4. clearHistory() -> clearMessages()
 * 5. No built-in maxIterations - implemented via turn_end event counting + abort()
 */

import { Agent, type AgentEvent, type AgentOptions, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model, UserMessage } from "@mariozechner/pi-ai";
import { logger } from "@/packages/logger";
import { type AgentResult, EventCollector } from "./event-bridge";
import { loadWorkspaceBootstrap, WorkspaceWatcher } from "./workspace";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Provider configuration for API key resolution
 */
export interface ProviderConfig {
	getApiKey: () => string | undefined;
	baseUrl?: string;
	api: Api;
}

/**
 * Known provider configurations.
 * getApiKey is a function to read env vars at runtime (for testability).
 */
export const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
	anthropic: {
		getApiKey: () => process.env.ANTHROPIC_API_KEY,
		api: "anthropic-messages",
	},
	openai: {
		getApiKey: () => process.env.OPENAI_API_KEY,
		api: "openai-completions",
	},
	google: {
		getApiKey: () => process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
		api: "google-generative-ai",
	},
	gemini: {
		getApiKey: () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
		api: "google-generative-ai",
	},
	openrouter: {
		getApiKey: () => process.env.OPENROUTER_API_KEY,
		baseUrl: "https://openrouter.ai/api/v1",
		api: "openai-completions",
	},
};

/**
 * Resolve API key for a given provider using PROVIDER_CONFIGS.
 * Returns undefined if no key is found.
 */
export function resolveProviderApiKey(provider: string): string | undefined {
	const config = PROVIDER_CONFIGS[provider];
	if (config) {
		return config.getApiKey();
	}
	// Generic fallback
	return process.env.LLM_API_KEY || process.env.API_KEY;
}

/**
 * Configuration for creating an EmbeddedAgent (session-level settings).
 * Per-request settings (onEvent, maxIterations, timeoutMs) are passed to prompt().
 */
export interface EmbeddedAgentConfig {
	/** Unique session identifier */
	sessionId: string;
	/** Absolute path to workspace directory containing bootstrap files */
	workspaceDir: string;
	/** LLM provider name (e.g., "anthropic", "openai", "google") */
	provider: string;
	/** LLM model identifier (e.g., "claude-sonnet-4-6") */
	model: string;
	/** Tools to register on the agent */
	tools?: AgentTool<unknown>[];
}

/**
 * Per-request options for prompt().
 * These are not session-level because they may change between calls
 * (e.g., different onEvent callbacks, different timeouts).
 */
export interface PromptOptions {
	/** Maximum agent loop iterations before abort (default: 50) */
	maxIterations?: number;
	/** Request timeout in milliseconds (default: 120000) */
	timeoutMs?: number;
	/** Optional callback for streaming events (fires after collection) */
	onEvent?: (event: AgentEvent) => void;
	/** Optional callback for immediate streaming (fires during collection) */
	onImmediate?: (event: AgentEvent) => void;
}

// =============================================================================
// EmbeddedAgent
// =============================================================================

/**
 * EmbeddedAgent wraps pi-agent-core's Agent with:
 * - Workspace bootstrap file injection as system prompt
 * - Event collection into AgentResult
 * - maxIterations guard via turn_end counting
 * - Timeout handling via AbortController
 * - Provider-aware API key resolution
 */
export class EmbeddedAgent {
	private readonly agent: Agent;
	private readonly config: EmbeddedAgentConfig;
	private systemPrompt = "";
	private initialized = false;
	private promptRunning = false;
	private followUpQueue: string[] = [];
	private watcher: WorkspaceWatcher | null = null;

	constructor(config: EmbeddedAgentConfig) {
		this.config = config;

		// Resolve provider config for getApiKey
		const providerConfig = this.getProviderConfig();

		// Create Agent with options that require constructor injection
		const agentOptions: AgentOptions = {
			sessionId: config.sessionId,
			getApiKey: (provider: string) => {
				// Try the specific provider config first
				const specific = PROVIDER_CONFIGS[provider];
				if (specific) {
					return specific.getApiKey();
				}
				// Fall back to the configured provider
				return providerConfig.getApiKey();
			},
		};

		this.agent = new Agent(agentOptions);

		// Configure via setter methods
		const model = this.buildModel();
		this.agent.setModel(model);

		if (config.tools && config.tools.length > 0) {
			this.agent.setTools(config.tools);
		}
	}

	/**
	 * Initialize the agent by loading workspace bootstrap files.
	 * Must be called before first prompt. Idempotent.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		// Validate API key is available
		const apiKey = resolveProviderApiKey(this.config.provider);
		if (!apiKey) {
			throw new Error(
				`No API key configured for provider "${this.config.provider}". ` +
					`Set the appropriate environment variable (e.g., ANTHROPIC_API_KEY, OPENAI_API_KEY).`,
			);
		}

		// Load workspace bootstrap files and set as system prompt
		this.systemPrompt = await loadWorkspaceBootstrap(this.config.workspaceDir);
		this.agent.setSystemPrompt(this.systemPrompt);
		this.initialized = true;

		// Start workspace file watching for hot reload
		this.watcher = new WorkspaceWatcher({
			workspaceDir: this.config.workspaceDir,
			onReload: (newPrompt) => {
				this.systemPrompt = newPrompt;
				this.agent.setSystemPrompt(newPrompt);
				logger.info({ sessionId: this.config.sessionId }, "System prompt updated via hot reload");
			},
		});
		await this.watcher.start();

		logger.debug(
			{
				sessionId: this.config.sessionId,
				provider: this.config.provider,
				model: this.config.model,
				systemPromptLength: this.systemPrompt.length,
			},
			"EmbeddedAgent initialized",
		);
	}

	/**
	 * Send a prompt to the agent and collect the result.
	 *
	 * @param message - User message text
	 * @param options - Per-request options (maxIterations, timeoutMs, onEvent)
	 * @returns Collected agent result with output text, turn count, and tool calls
	 * @throws Error if prompt() is already running (use steer() instead)
	 */
	async prompt(message: string, options?: PromptOptions): Promise<AgentResult> {
		// Guard against concurrent prompt() calls
		if (this.promptRunning) {
			throw new Error(
				"prompt() is already running on this EmbeddedAgent. " +
					"Use steer() to inject messages during execution, or wait for the current prompt to complete.",
			);
		}

		if (!this.initialized) {
			await this.initialize();
		}

		const maxIterations = options?.maxIterations ?? 50;
		const timeoutMs = options?.timeoutMs ?? 120000;
		const onEvent = options?.onEvent;
		const onImmediate = options?.onImmediate;

		this.promptRunning = true;

		// Set up event collector with maxIterations guard
		const collector = new EventCollector({
			maxIterations,
			onMaxIterations: () => {
				logger.warn({ sessionId: this.config.sessionId, maxIterations }, "Agent reached max iterations, aborting");
				this.agent.abort();
			},
			onImmediate,
		});

		// Subscribe to events BEFORE calling prompt
		const unsub = this.agent.subscribe((event: AgentEvent) => {
			collector.handleEvent(event);
			onEvent?.(event);
		});

		// Set up timeout via AbortController
		const timeoutHandle = setTimeout(() => {
			logger.warn({ sessionId: this.config.sessionId, timeoutMs }, "Agent prompt timed out, aborting");
			this.agent.abort();
		}, timeoutMs);

		try {
			// Agent.prompt() returns Promise<void> - loop runs internally
			await this.agent.prompt(message);
			return collector.toResult();
		} finally {
			clearTimeout(timeoutHandle);
			unsub();
			this.promptRunning = false;
		}
	}

	/**
	 * Inject a steering message during execution.
	 * Wraps string into UserMessage format.
	 */
	steer(message: string): void {
		const userMessage: UserMessage = {
			role: "user",
			content: message,
			timestamp: Date.now(),
		};
		this.agent.steer(userMessage);
	}

	/**
	 * Abort the current agent execution.
	 */
	abort(): void {
		this.agent.abort();
	}

	/** Clean up resources (watchers, etc.) */
	dispose(): void {
		this.watcher?.dispose();
		this.watcher = null;
	}

	/** Check if a prompt is currently running */
	isRunning(): boolean {
		return this.promptRunning;
	}

	/**
	 * Queue a follow-up message to be delivered after current execution.
	 * If not running, throws - caller should use prompt() instead.
	 */
	queueFollowUp(message: string): void {
		if (!this.promptRunning) {
			throw new Error("No prompt is running. Use prompt() to start execution.");
		}
		this.followUpQueue.push(message);
		logger.debug(
			{ sessionId: this.config.sessionId, queueSize: this.followUpQueue.length },
			"Queued follow-up message",
		);
	}

	/**
	 * Drain queued follow-up messages after prompt completes.
	 * Returns queued messages and clears the queue.
	 */
	drainFollowUpQueue(): string[] {
		const messages = [...this.followUpQueue];
		this.followUpQueue = [];
		return messages;
	}

	/**
	 * Get the current session ID.
	 */
	getSessionId(): string {
		return this.config.sessionId;
	}

	/**
	 * Get the current system prompt (built from workspace files).
	 */
	getSystemPrompt(): string {
		return this.systemPrompt;
	}

	/**
	 * Get the agent's current message history.
	 */
	getMessages(): typeof this.agent.state.messages {
		return this.agent.state.messages;
	}

	/**
	 * Clear the agent's message history.
	 */
	clearMessages(): void {
		this.agent.clearMessages();
	}

	/**
	 * Get registered tools.
	 */
	getTools(): AgentTool<unknown>[] {
		return this.agent.state.tools;
	}

	/**
	 * Update tools on the agent.
	 */
	setTools(tools: AgentTool<unknown>[]): void {
		this.agent.setTools(tools);
	}

	/**
	 * Wait for the agent to become idle (no active prompt/tool execution).
	 */
	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
	}

	/**
	 * Get the underlying pi-agent-core Agent instance.
	 * Use with caution - this exposes the raw agent.
	 */
	getRawAgent(): Agent {
		return this.agent;
	}

	// =========================================================================
	// Private helpers
	// =========================================================================

	/**
	 * Get provider configuration including API key getter and API type
	 */
	private getProviderConfig(): ProviderConfig {
		const knownConfig = PROVIDER_CONFIGS[this.config.provider];
		if (knownConfig) {
			return knownConfig;
		}

		// Generic fallback - try LLM_API_KEY or API_KEY env vars
		return {
			getApiKey: () => process.env.LLM_API_KEY || process.env.API_KEY,
			api: "openai-completions",
			baseUrl: process.env.LLM_BASE_URL,
		};
	}

	/**
	 * Build a Model object for the agent.
	 */
	private buildModel(): Model<Api> {
		const config = this.getProviderConfig();

		return {
			id: this.config.model,
			name: this.config.model,
			provider: this.config.provider,
			api: config.api,
			baseUrl: config.baseUrl || "",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 200000,
			maxTokens: 8192,
		};
	}
}
