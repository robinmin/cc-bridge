/**
 * In-Process Execution Engine
 *
 * TRUE in-process LLM execution using @mariozechner/pi-ai.
 * Executes prompts directly within the same Node.js process via completeSimple API.
 * No subprocess spawning - this is real in-process execution with ~0ms latency.
 */

import { completeSimple, type Api, type Model, type TextContent } from "@mariozechner/pi-ai";
import { logger } from "@/packages/logger";
import type { ExecutionRequest, ExecutionResult, IExecutionEngine, LayerHealth } from "./contracts";

/**
 * Check if a content block is a text block
 * Exported for testing
 */
export function isTextContentBlock(block: unknown): block is TextContent {
	return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
}

/**
 * Provider configuration
 */
interface ProviderConfig {
	getApiKey: () => string | undefined;
	baseUrl?: string;
	api: Api;
}

/**
 * Known provider configurations
 * Note: getApiKey is a function to read env vars at runtime (for testability)
 */
const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
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
 * In-process execution engine
 *
 * Uses @mariozechner/pi-ai's completeSimple for direct LLM API calls.
 * No subprocess spawning - true in-process execution.
 */
export class InProcessEngine implements IExecutionEngine {
	private readonly enabled: boolean;
	private readonly defaultProvider: string;
	private readonly defaultModel: string;

	constructor(enabled: boolean = false, defaultProvider?: string, defaultModel?: string) {
		this.enabled = enabled;
		this.defaultProvider = defaultProvider || process.env.LLM_PROVIDER || "anthropic";
		this.defaultModel = defaultModel || process.env.LLM_MODEL || "claude-sonnet-4-6";
	}

	getLayer(): "in-process" {
		return "in-process";
	}

	async isAvailable(): Promise<boolean> {
		if (!this.enabled) {
			return false;
		}

		// Check if API key is available for the default provider
		const config = this.getProviderConfig();
		const apiKey = config.getApiKey();
		if (!apiKey) {
			logger.warn(
				{ provider: this.defaultProvider },
				"In-process engine: No API key configured for provider",
			);
			return false;
		}

		logger.debug(
			{ provider: this.defaultProvider, model: this.defaultModel },
			"In-process engine available",
		);
		return true;
	}

	/**
	 * Get provider configuration including API key getter and API type
	 */
	private getProviderConfig(): ProviderConfig {
		// Check known providers first
		const knownConfig = PROVIDER_CONFIGS[this.defaultProvider];
		if (knownConfig) {
			return knownConfig;
		}

		// Generic fallback - try LLM_API_KEY or API_KEY env vars
		return {
			getApiKey: () => process.env.LLM_API_KEY || process.env.API_KEY,
			api: "openai-completions", // Default to OpenAI-compatible API
			baseUrl: process.env.LLM_BASE_URL,
		};
	}

	/**
	 * Build a Model object for completeSimple
	 * Note: API key is NOT part of the Model object - it's passed separately in options
	 */
	private buildModel(): Model {
		const config = this.getProviderConfig();
		const apiKey = config.getApiKey();
		if (!apiKey) {
			throw new Error(`No API key configured for provider: ${this.defaultProvider}`);
		}

		// Create a properly typed Model object
		const model: Model = {
			id: this.defaultModel,
			name: this.defaultModel, // Use model ID as name
			provider: this.defaultProvider,
			api: config.api,
			baseUrl: config.baseUrl || "",
			reasoning: false, // Default - can be overridden if needed
			input: ["text"], // Default to text input
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 200000, // Default 200k context
			maxTokens: 8192, // Default max output tokens
		};

		return model;
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
		const requestId = request.options?.chatId || `in-process-${Date.now()}`;

		logger.info(
			{ requestId, promptLength: request.prompt.length, timeoutMs, provider: this.defaultProvider, model: this.defaultModel },
			"Executing via in-process engine (TRUE in-process, no subprocess)",
		);

		const startTime = Date.now();

		try {
			// Get provider config for API key
			const config = this.getProviderConfig();
			const apiKey = config.getApiKey();
			if (!apiKey) {
				throw new Error(`No API key configured for provider: ${this.defaultProvider}`);
			}

			// Build the model configuration
			const model = this.buildModel();

			// Create abort controller for timeout
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);

			try {
				// Execute prompt directly in-process using completeSimple
				// API key is passed in options, not in model object
				const res = await completeSimple(
					model,
					{
						messages: [
							{
								role: "user",
								content: request.prompt,
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey,
						maxTokens: request.options?.maxTokens || 4096,
						temperature: 0.7,
						signal: controller.signal,
					},
				);

				// Extract text content from response
				const output = res.content
					.filter(isTextContentBlock)
					.map((block) => block.text.trim())
					.filter(Boolean)
					.join("\n");

				const durationMs = Date.now() - startTime;
				logger.info(
					{ requestId, outputLength: output.length, durationMs, stopReason: res.stopReason },
					"In-process execution completed",
				);

				return {
					status: "completed",
					output,
					exitCode: 0,
					retryable: false,
				};
			} finally {
				clearTimeout(timeout);
			}
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
				logger.warn({ requestId, timeoutMs, durationMs }, "In-process execution timed out");
				return {
					status: "failed",
					error: `In-process execution timed out after ${timeoutMs}ms`,
					retryable: true,
					isTimeout: true,
				};
			}

			logger.error({ requestId, error: errorMessage, durationMs }, "In-process execution failed");
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
}
