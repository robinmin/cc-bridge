/**
 * Configuration Utilities
 *
 * Re-exports types from embedded-agent.ts and provides helpers.
 */

// Re-export the main AgentConfig and types from embedded-agent
export type {
	AgentConfig,
	MemoryConfig,
	MultiProviderConfig,
	RagConfig,
	SelectionPolicy,
	SingleProviderConfig,
} from "./embedded-agent";

/**
 * Provider metadata for selection decisions.
 * Used by selection policies to make informed decisions.
 */
export interface ProviderMetadata {
	/** Cost per 1K tokens in USD */
	costPer1kTokens?: number;
	/** Average latency in milliseconds */
	avgLatencyMs?: number;
	/** Maximum context length in tokens */
	maxTokens?: number;
	/** Supported model IDs by this provider */
	supportedModels?: string[];
}

/**
 * Selection context passed to selection policies.
 */
export interface SelectionContext {
	/** Task type for routing decisions */
	taskType?: string;
	/** Required capabilities */
	requiredCapabilities?: string[];
	/** User preferences */
	preferences?: {
		preferSpeed?: boolean;
		preferCost?: boolean;
		preferQuality?: boolean;
	};
}

/**
 * Selection result with provider and reasoning.
 */
export interface SelectionResult {
	/** Selected provider configuration */
	provider: SingleProviderConfig;
	/** Human-readable reason for selection */
	reason: string;
}

/**
 * Provider selector interface.
 * Implement this to create custom selection strategies.
 */
export interface ProviderSelector {
	/**
	 * Select a provider based on context and selection policy.
	 */
	select(providers: SingleProviderConfig[], policy: SelectionPolicy, context?: SelectionContext): SelectionResult;
}
