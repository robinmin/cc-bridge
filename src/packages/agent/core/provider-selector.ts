/**
 * Provider Selector
 *
 * Implements selection logic for multi-provider configurations.
 * Supports extensible selection policies via discriminated union.
 */

import { logger } from "@/packages/logger";
import type {
	MultiProviderConfig,
	ProviderSelector,
	SelectionContext,
	SelectionPolicy,
	SelectionResult,
	SingleProviderConfig,
} from "./config";

/**
 * Default provider selector implementation.
 * Supports all built-in selection policies.
 */
export class DefaultProviderSelector implements ProviderSelector {
	select(providers: SingleProviderConfig[], policy: SelectionPolicy, _context?: SelectionContext): SelectionResult {
		switch (policy.type) {
			case "cost-optimized":
				return this.selectCostOptimized(providers, policy.maxBudgetPer1kTokens);
			case "latency-optimized":
				return this.selectLatencyOptimized(providers, policy.maxLatencyMs);
			case "quality-optimized":
				return this.selectQualityOptimized(providers, policy.preferredProviders);
			case "fallback":
				return this.selectFallback(providers, policy.order);
			case "smart":
				return this.selectSmart(providers, policy.weights);
			default:
				logger.warn({ policy }, "Unknown selection policy, using first provider");
				return {
					provider: providers[0],
					reason: "Default to first provider due to unknown policy",
				};
		}
	}

	private selectCostOptimized(providers: SingleProviderConfig[], maxBudget?: number): SelectionResult {
		// Sort by cost
		const sorted = [...providers].sort((a, b) => {
			const costA = a.metadata?.costPer1kTokens ?? Infinity;
			const costB = b.metadata?.costPer1kTokens ?? Infinity;
			return costA - costB;
		});

		const selected = sorted.find((p) => {
			if (maxBudget === undefined) return true;
			const cost = p.metadata?.costPer1kTokens ?? Infinity;
			return cost <= maxBudget;
		});

		if (!selected) {
			logger.warn("No provider within budget for cost-optimized selection");
			return { provider: providers[0], reason: "No cost-compliant provider found, using first" };
		}

		return {
			provider: selected,
			reason: `Selected ${selected.name} ($${selected.metadata?.costPer1kTokens}/1K tokens) for cost optimization`,
		};
	}

	private selectLatencyOptimized(providers: SingleProviderConfig[], maxLatency?: number): SelectionResult {
		// Sort by latency
		const sorted = [...providers].sort((a, b) => {
			const latencyA = a.metadata?.avgLatencyMs ?? Infinity;
			const latencyB = b.metadata?.avgLatencyMs ?? Infinity;
			return latencyA - latencyB;
		});

		const selected = sorted.find((p) => {
			if (maxLatency === undefined) return true;
			const latency = p.metadata?.avgLatencyMs ?? Infinity;
			return latency <= maxLatency;
		});

		if (!selected) {
			logger.warn("No provider within latency limit for latency-optimized selection");
			return { provider: providers[0], reason: "No latency-compliant provider found, using first" };
		}

		return {
			provider: selected,
			reason: `Selected ${selected.name} (${selected.metadata?.avgLatencyMs}ms avg latency) for latency optimization`,
		};
	}

	private selectQualityOptimized(providers: SingleProviderConfig[], preferred?: string[]): SelectionResult {
		// Prefer providers in the preferred list, then by metadata quality signals
		if (preferred && preferred.length > 0) {
			const preferredProvider = providers.find((p) => preferred.includes(p.name));
			if (preferredProvider) {
				return {
					provider: preferredProvider,
					reason: `Selected ${preferredProvider.name} from quality-preferred providers`,
				};
			}
		}

		// Fall back to first provider with quality metadata
		const withQuality = providers.find((p) => p.metadata && Object.keys(p.metadata).length > 0);
		if (withQuality) {
			return { provider: withQuality, reason: `Selected ${withQuality.name} based on quality metadata` };
		}

		return { provider: providers[0], reason: "No quality signals, using first provider" };
	}

	private selectFallback(providers: SingleProviderConfig[], order: string[]): SelectionResult {
		// Find providers in order
		for (const name of order) {
			const provider = providers.find((p) => p.name === name);
			if (provider) {
				return { provider, reason: `Selected ${provider.name} from fallback order` };
			}
		}

		logger.warn("No providers found in fallback order, using first");
		return { provider: providers[0], reason: "Fallback order not matched, using first provider" };
	}

	private selectSmart(
		providers: SingleProviderConfig[],
		weights: { cost: number; latency: number; quality: number },
	): SelectionResult {
		// Calculate composite score for each provider
		const scored = providers.map((p) => {
			const costScore = p.metadata?.costPer1kTokens ? 1 - p.metadata.costPer1kTokens / 1 : 0.5;
			const latencyScore = p.metadata?.avgLatencyMs ? 1 - p.metadata.avgLatencyMs / 10000 : 0.5;
			const qualityScore = 0.5; // Would need more sophisticated quality signals

			const compositeScore = weights.cost * costScore + weights.latency * latencyScore + weights.quality * qualityScore;

			return { provider: p, score: compositeScore };
		});

		scored.sort((a, b) => b.score - a.score);
		const selected = scored[0].provider;

		return {
			provider: selected,
			reason: `Selected ${selected.name} via smart scoring (cost:${weights.cost}, latency:${weights.latency}, quality:${weights.quality})`,
		};
	}
}

/**
 * Create a multi-provider config with a single provider.
 * Convenience helper for simple configurations.
 */
export function singleProvider(
	name: string,
	apiKey?: string,
	metadata?: SingleProviderConfig["metadata"],
): MultiProviderConfig {
	return {
		providers: [{ name, apiKey, metadata }],
		selection: { type: "fallback", order: [name] },
	};
}

/**
 * Create a multi-provider config with fallback order.
 */
export function fallbackProviders(order: string[]): MultiProviderConfig {
	return {
		providers: order.map((name) => ({ name })),
		selection: { type: "fallback", order },
	};
}

/**
 * Create a multi-provider config with cost optimization.
 */
export function costOptimizedProviders(
	providers: Array<{ name: string; costPer1kTokens: number }>,
	maxBudget?: number,
): MultiProviderConfig {
	return {
		providers: providers.map((p) => ({ name: p.name, metadata: { costPer1kTokens: p.costPer1kTokens } })),
		selection: { type: "cost-optimized", maxBudgetPer1kTokens: maxBudget },
	};
}

/**
 * Resolve API key for a provider.
 * Checks provided apiKey first, then environment variables.
 */
export function resolveApiKey(provider: SingleProviderConfig): string | undefined {
	if (provider.apiKey) {
		return provider.apiKey;
	}

	// Environment variable resolution based on provider name
	const envVarMap: Record<string, string> = {
		anthropic: "ANTHROPIC_API_KEY",
		openai: "OPENAI_API_KEY",
		google: "GOOGLE_API_KEY",
		gemini: "GEMINI_API_KEY",
		ollama: "OLLAMA_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		minimax: "MINIMAX_API_KEY",
		zai: "ZAI_API_KEY",
	};

	const envVar = envVarMap[provider.name];
	if (envVar && process.env[envVar]) {
		return process.env[envVar];
	}

	// Generic fallback
	return process.env.LLM_API_KEY || process.env.API_KEY;
}

/**
 * Get the API type for a provider.
 */
export function getProviderApiType(providerName: string): string {
	switch (providerName) {
		case "anthropic":
			return "anthropic-messages";
		case "openai":
		case "openrouter":
			return "openai-completions";
		case "google":
		case "gemini":
			return "google-generative-ai";
		default:
			return "openai-completions";
	}
}
