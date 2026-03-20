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
import type { MemoryIndexer } from "@/packages/agent/memory/indexer/indexer";
import { logger } from "@/packages/logger";
import { type AgentResult, EventCollector } from "./event-bridge";
import {
	categorizeAgentError,
	createObservabilitySnapshot,
	type EmbeddedAgentObservabilityConfig,
	type EmbeddedAgentObservabilitySnapshot,
	finishObservabilityRun,
	recordSpanEvent,
	startObservabilityRun,
} from "./observability";
import { type AgentOtelConfig, type AgentOtelService, createAgentOtelService } from "./otel";
import { RagContextCache } from "./rag-cache";
import { buildRagPrompt } from "./rag-context";
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
 * Agent Configuration
 *
 * Unified configuration for creating an EmbeddedAgent.
 * Supports single provider (string) or multi-provider with selection strategy.
 */
export interface AgentConfig {
	/** Unique session identifier */
	sessionId?: string;
	/** Absolute path to workspace directory containing bootstrap files */
	workspaceDir: string;
	/** LLM provider - string for single provider, or config object for multi-provider */
	provider: string | SingleProviderConfig | MultiProviderConfig;
	/** LLM model identifier (e.g., "claude-sonnet-4-6", "gpt-4o") */
	model: string;
	/** Enable extended thinking/reasoning (provider-specific, e.g., Anthropic's extended) */
	modelReasoning?: boolean;
	/** Tools to register on the agent */
	tools?: AgentTool<unknown>[];
	/** Optional memory configuration (recommended way) */
	memory?: MemoryConfig;
	/** @deprecated Optional memory indexer instance (for backward compatibility) */
	memoryIndexer?: MemoryIndexer;
	/** Optional RAG configuration */
	rag?: RagConfig;
	/** Optional observability hooks and tracing adapter */
	observability?: EmbeddedAgentObservabilityConfig;
	/** OpenTelemetry configuration */
	otel?: AgentOtelConfig;
}

/**
 * Memory configuration for the agent.
 * When provided, the agent will manage memory with the specified backend.
 */
export interface MemoryConfig {
	/** Enable memory system (default: true if memory is provided) */
	enabled?: boolean;
	/** Memory storage slot (default: "builtin") */
	slot?: "builtin" | "none" | "external";
	/** Citation mode for context (default: "auto") */
	citations?: "auto" | "on" | "off";
	/** Compaction settings for context management */
	compaction?: {
		enabled?: boolean;
		reserveTokens?: number;
		keepRecentTokens?: number;
	};
	/** Indexing settings for RAG */
	indexing?: {
		enabled?: boolean;
		vector?: boolean;
		provider?: "openai" | "gemini" | "voyage" | "mistral";
	};
}

/**
 * Single provider configuration.
 */
export interface SingleProviderConfig {
	/** Provider name (e.g., "anthropic", "openai", "gemini") */
	name: string;
	/** API key - resolves from env if not provided */
	apiKey?: string;
	/** Custom base URL for API */
	baseUrl?: string;
}

/**
 * Provider selection policy types.
 * Extensible via discriminated union - add new policies by adding new type branches.
 */
export type SelectionPolicy =
	| { type: "cost-optimized"; maxBudgetPer1kTokens?: number }
	| { type: "latency-optimized"; maxLatencyMs?: number }
	| { type: "quality-optimized"; preferredProviders?: string[] }
	| { type: "fallback"; order: string[] }
	| { type: "smart"; weights: { cost: number; latency: number; quality: number } };

/**
 * Multi-provider configuration with selection strategy.
 */
export interface MultiProviderConfig {
	/** List of providers to choose from */
	providers: SingleProviderConfig[];
	/** Selection policy */
	selection: SelectionPolicy;
}

/**
 * RAG (Retrieval-Augmented Generation) configuration for selective context injection.
 */
export interface RagConfig {
	/** Enable or disable RAG context retrieval (default: true) */
	enabled?: boolean;
	/** Minimum score threshold for including results (default: 0.3, range: 0-1) */
	threshold?: number;
	/** Maximum number of results to retrieve (default: 5) */
	maxResults?: number;
	/** Search mode for retrieval (default: "hybrid") */
	mode?: "keyword" | "vector" | "hybrid";
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
	private readonly config: AgentConfig;
	private systemPrompt = "";
	private initialized = false;
	private promptRunning = false;
	private followUpQueue: string[] = [];
	private watcher: WorkspaceWatcher | null = null;
	private readonly observabilityConfig: EmbeddedAgentObservabilityConfig;
	private readonly observability: EmbeddedAgentObservabilitySnapshot;
	private readonly otelService: AgentOtelService | null;
	private readonly memoryIndexer: MemoryIndexer | null;
	private readonly ragCache: RagContextCache;
	private readonly ragEnabled: boolean;
	private readonly ragThreshold: number;
	private readonly ragMaxResults: number;
	private readonly ragMode: "keyword" | "vector" | "hybrid";

	constructor(config: AgentConfig) {
		this.config = config;

		// Create OTEL service if configured
		this.otelService = config.otel ? createAgentOtelService(config.otel) : null;

		// Build observability config with OTEL service
		this.observabilityConfig = {
			...config.observability,
			otelService: this.otelService ?? config.observability?.otelService,
		};

		this.observability = createObservabilitySnapshot(config.sessionId, config.provider, config.model);

		// Initialize RAG fields with config or defaults
		this.memoryIndexer = config.memoryIndexer ?? null;
		this.ragCache = new RagContextCache();
		this.ragEnabled = config.rag?.enabled ?? true;
		this.ragThreshold = config.rag?.threshold ?? 0.3;
		this.ragMaxResults = config.rag?.maxResults ?? 5;
		this.ragMode = config.rag?.mode ?? "hybrid";

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
		const runContext = startObservabilityRun(this.observability, message.length, this.observabilityConfig);
		let timedOut = false;

		// Retrieve RAG context before prompt execution
		let ragContext: string | undefined;
		let originalSystemPrompt: string | undefined;
		let ragCacheHit = false;
		let ragRetrievalDurationMs: number | undefined;
		let ragResultsCount = 0;

		// Evict cache entries older than 5 minutes (per task spec)
		this.ragCache.evictOlderThan(5 * 60 * 1000);

		try {
			const ragStartTime = Date.now();
			const ragResult = await this.retrieveRagContext(message);
			ragRetrievalDurationMs = Date.now() - ragStartTime;
			ragContext = ragResult.context;
			ragCacheHit = ragResult.cacheHit;
			ragResultsCount = ragResult.resultsCount;

			if (ragContext) {
				originalSystemPrompt = this.systemPrompt;
				const effectiveSystemPrompt = `${ragContext}\n\n${this.systemPrompt}`;
				this.agent.setSystemPrompt(effectiveSystemPrompt);
				logger.debug(
					{ ragContextLength: ragContext.length, ragResultsCount },
					"RAG context prepended to system prompt",
				);
			}
		} catch (error) {
			// RAG retrieval is best-effort - log and continue without RAG
			logger.warn({ error }, "RAG context retrieval failed, continuing without RAG");
		}

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
			recordSpanEvent(runContext.span, event);
			onEvent?.(event);
		});

		// Set up timeout via AbortController
		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			logger.warn({ sessionId: this.config.sessionId, timeoutMs }, "Agent prompt timed out, aborting");
			this.agent.abort();
		}, timeoutMs);

		try {
			// Agent.prompt() returns Promise<void> - loop runs internally
			await this.agent.prompt(message);
			const result = collector.toResult();
			const run = finishObservabilityRun({
				snapshot: this.observability,
				context: runContext,
				outputLength: result.output.length,
				turnCount: result.turnCount,
				toolCallCount: result.toolCalls.length,
				toolErrorCount: result.toolCalls.filter((toolCall) => toolCall.isError).length,
				aborted: result.aborted,
				usage: collector.getUsageTotals(),
				errorCategory: result.aborted ? (timedOut ? "timeout" : "max_iterations") : undefined,
				config: this.observabilityConfig,
				rag: ragContext
					? {
							resultsCount: ragResultsCount,
							cacheHit: ragCacheHit,
							threshold: this.ragThreshold,
							retrievalDurationMs: ragRetrievalDurationMs,
						}
					: undefined,
			});
			logger.info(
				{
					sessionId: this.config.sessionId,
					runId: run.runId,
					durationMs: run.durationMs,
					turnCount: run.turnCount,
					toolCallCount: run.toolCallCount,
					toolErrorCount: run.toolErrorCount,
					totalTokens: run.usage.totalTokens,
					totalCost: run.usage.cost.total,
				},
				"EmbeddedAgent prompt completed",
			);
			return {
				...result,
				observability: run,
			};
		} catch (error) {
			runContext.span.recordException?.(error);
			const category = categorizeAgentError(error);
			finishObservabilityRun({
				snapshot: this.observability,
				context: runContext,
				outputLength: 0,
				turnCount: collector.toResult().turnCount,
				toolCallCount: collector.toResult().toolCalls.length,
				toolErrorCount: collector.toResult().toolCalls.filter((toolCall) => toolCall.isError).length,
				aborted: category === "timeout" || category === "aborted" || category === "max_iterations",
				usage: collector.getUsageTotals(),
				errorCategory: category,
				config: this.observabilityConfig,
				rag: ragContext
					? {
							resultsCount: ragResultsCount,
							cacheHit: ragCacheHit,
							threshold: this.ragThreshold,
							retrievalDurationMs: ragRetrievalDurationMs,
						}
					: undefined,
			});
			throw error;
		} finally {
			clearTimeout(timeoutHandle);
			unsub();
			this.promptRunning = false;

			// Restore original system prompt if RAG context was prepended
			if (originalSystemPrompt !== undefined) {
				this.agent.setSystemPrompt(originalSystemPrompt);
				logger.debug("RAG context removed from system prompt");
			}
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

	/** Clean up resources (watchers, OTEL service, etc.) */
	async dispose(): Promise<void> {
		this.watcher?.dispose();
		this.watcher = null;
		await this.otelService?.shutdown();
		this.ragCache.clear();
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
	 * Get cumulative per-session observability metrics.
	 */
	getObservabilitySnapshot(): EmbeddedAgentObservabilitySnapshot {
		return {
			...this.observability,
			activeRun: this.observability.activeRun ? { ...this.observability.activeRun } : undefined,
			lastRun: this.observability.lastRun
				? {
						...this.observability.lastRun,
						usage: {
							...this.observability.lastRun.usage,
							cost: { ...this.observability.lastRun.usage.cost },
						},
					}
				: undefined,
			totals: {
				...this.observability.totals,
				usage: {
					...this.observability.totals.usage,
					cost: { ...this.observability.totals.usage.cost },
				},
				errorsByCategory: { ...this.observability.totals.errorsByCategory },
			},
		};
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
	 * Also clears the RAG cache as per task spec.
	 */
	clearMessages(): void {
		this.agent.clearMessages();
		this.ragCache.clear();
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

	/**
	 * Retrieve RAG context for a given message.
	 * Returns undefined if RAG is disabled, indexer unavailable, or no results above threshold.
	 *
	 * @param message - The user message to retrieve context for
	 * @returns Formatted RAG context string, cache hit flag, and results count
	 */
	private async retrieveRagContext(
		message: string,
	): Promise<{ context: string | undefined; cacheHit: boolean; resultsCount: number }> {
		// Check if RAG is disabled
		if (!this.ragEnabled) {
			logger.debug("RAG disabled, skipping retrieval");
			return { context: undefined, cacheHit: false, resultsCount: 0 };
		}

		// Check if memory indexer is available
		if (!this.memoryIndexer) {
			logger.debug("RAG indexer not available, skipping retrieval");
			return { context: undefined, cacheHit: false, resultsCount: 0 };
		}

		// Check cache first
		const cached = this.ragCache.get(message);
		if (cached !== undefined) {
			logger.debug("RAG cache hit");
			// For cache hits, we don't have the exact count, but context exists
			return { context: cached, cacheHit: true, resultsCount: 1 };
		}

		logger.debug("RAG cache miss, performing search");

		// Perform search with timeout
		const searchResults = await withTimeout(
			this.memoryIndexer.search(message, { mode: this.ragMode, limit: this.ragMaxResults }),
			5000,
			"memoryIndexer.search",
		);

		// If search timed out or returned nothing
		if (searchResults === undefined || searchResults.length === 0) {
			logger.debug("RAG search returned no results");
			return { context: undefined, cacheHit: false, resultsCount: 0 };
		}

		// Filter results by threshold
		const aboveThreshold = searchResults.filter((result) => {
			const score = result.score ?? 0;
			return score >= this.ragThreshold;
		});

		if (aboveThreshold.length === 0) {
			logger.debug({ threshold: this.ragThreshold }, "All RAG results below threshold");
			return { context: undefined, cacheHit: false, resultsCount: 0 };
		}

		// Format and cache results
		const context = buildRagPrompt(message, aboveThreshold);
		this.ragCache.set(message, context);

		logger.debug({ resultsCount: aboveThreshold.length, threshold: this.ragThreshold }, "RAG retrieval successful");

		return { context, cacheHit: false, resultsCount: aboveThreshold.length };
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

/**
 * Wrap a promise with a timeout.
 * Returns undefined if timeout expires before promise resolves.
 * Logs a warning if timeout occurs.
 *
 * @param promise - The promise to wrap
 * @param ms - Timeout in milliseconds
 * @param label - Label for logging
 * @returns The promise result or undefined if timeout
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> {
	let timeoutId: ReturnType<typeof setTimeout>;
	let timedOut = false;

	const timeout = new Promise<undefined>((resolve) => {
		timeoutId = setTimeout(() => {
			timedOut = true;
			logger.warn({ ms, label }, "RAG search timed out");
			resolve(undefined);
		}, ms);
	});

	try {
		const result = await Promise.race([promise, timeout]);
		return timedOut ? undefined : result;
	} finally {
		clearTimeout(timeoutId);
	}
}
