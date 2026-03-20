import { beforeEach, describe, expect, test } from "bun:test";
import {
	DefaultProviderSelector,
	costOptimizedProviders,
	fallbackProviders,
	getProviderApiType,
	resolveApiKey,
	singleProvider,
} from "../agent/core/provider-selector";
import type { SelectionPolicy, SingleProviderConfig } from "../agent/core/config";

describe("provider-selector", () => {
	let selector: DefaultProviderSelector;

	beforeEach(() => {
		selector = new DefaultProviderSelector();
	});

	// =============================================================================
	// DefaultProviderSelector.select()
	// =============================================================================

	describe("DefaultProviderSelector.select()", () => {
		const providers: SingleProviderConfig[] = [
			{ name: "expensive", metadata: { costPer1kTokens: 0.01, avgLatencyMs: 100 } },
			{ name: "cheap", metadata: { costPer1kTokens: 0.005, avgLatencyMs: 200 } },
			{ name: "fast", metadata: { costPer1kTokens: 0.02, avgLatencyMs: 50 } },
		];

		test("selects cost-optimized provider", () => {
			const policy: SelectionPolicy = { type: "cost-optimized" };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("cheap");
			expect(result.reason).toContain("cost optimization");
		});

		test("selects cost-optimized within budget", () => {
			const policy: SelectionPolicy = { type: "cost-optimized", maxBudgetPer1kTokens: 0.015 };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("cheap");
		});

		test("falls back to first when no provider within budget", () => {
			const policy: SelectionPolicy = { type: "cost-optimized", maxBudgetPer1kTokens: 0.001 };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("expensive");
			expect(result.reason).toContain("No cost-compliant provider");
		});

		test("selects latency-optimized provider", () => {
			const policy: SelectionPolicy = { type: "latency-optimized" };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("fast");
			expect(result.reason).toContain("latency optimization");
		});

		test("selects latency-optimized within max latency", () => {
			const policy: SelectionPolicy = { type: "latency-optimized", maxLatencyMs: 150 };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("fast");
		});

		test("falls back to first when no provider within latency limit", () => {
			const policy: SelectionPolicy = { type: "latency-optimized", maxLatencyMs: 10 };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("expensive");
			expect(result.reason).toContain("No latency-compliant provider");
		});

		test("selects quality-optimized from preferred providers", () => {
			const policy: SelectionPolicy = { type: "quality-optimized", preferredProviders: ["fast"] };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("fast");
			expect(result.reason).toContain("quality-preferred");
		});

		test("selects quality-optimized by metadata when no preferred match", () => {
			const policy: SelectionPolicy = { type: "quality-optimized", preferredProviders: ["nonexistent"] };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("expensive");
			expect(result.reason).toContain("quality metadata");
		});

		test("selects first provider when no quality signals", () => {
			const noMetadataProviders: SingleProviderConfig[] = [
				{ name: "first" },
				{ name: "second" },
			];
			const policy: SelectionPolicy = { type: "quality-optimized" };
			const result = selector.select(noMetadataProviders, policy);
			expect(result.provider.name).toBe("first");
			expect(result.reason).toContain("No quality signals");
		});

		test("selects fallback provider in order", () => {
			const policy: SelectionPolicy = { type: "fallback", order: ["fast", "cheap"] };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("fast");
			expect(result.reason).toContain("fallback order");
		});

		test("selects first matching fallback when some not found", () => {
			const policy: SelectionPolicy = { type: "fallback", order: ["nonexistent", "cheap", "fast"] };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("cheap");
		});

		test("falls back to first when no fallback match", () => {
			const policy: SelectionPolicy = { type: "fallback", order: ["nonexistent1", "nonexistent2"] };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("expensive");
			expect(result.reason).toContain("Fallback order not matched");
		});

		test("selects smart provider by composite score", () => {
			const policy: SelectionPolicy = {
				type: "smart",
				weights: { cost: 1, latency: 0, quality: 0 },
			};
			const result = selector.select(providers, policy);
			// With only cost weight, cheap provider should win
			expect(result.provider.name).toBe("cheap");
			expect(result.reason).toContain("smart scoring");
		});

		test("selects smart provider with latency weight", () => {
			const policy: SelectionPolicy = {
				type: "smart",
				weights: { cost: 0, latency: 1, quality: 0 },
			};
			const result = selector.select(providers, policy);
			// With only latency weight, fast provider should win
			expect(result.provider.name).toBe("fast");
		});

		test("handles empty preferred list in quality-optimized", () => {
			const policy: SelectionPolicy = { type: "quality-optimized", preferredProviders: [] };
			const result = selector.select(providers, policy);
			// Should fall through to metadata check
			expect(result.provider.name).toBe("expensive");
		});

		test("handles undefined maxBudget in cost-optimized", () => {
			const policy: SelectionPolicy = { type: "cost-optimized", maxBudgetPer1kTokens: undefined };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("cheap");
		});

		test("handles undefined maxLatency in latency-optimized", () => {
			const policy: SelectionPolicy = { type: "latency-optimized", maxLatencyMs: undefined };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("fast");
		});

		test("handles undefined weights in smart selection", () => {
			const policy: SelectionPolicy = {
				type: "smart",
				weights: { cost: 0.33, latency: 0.33, quality: 0.34 },
			};
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBeTruthy();
		});
	});

	// =============================================================================
	// Helper functions
	// =============================================================================

	describe("singleProvider()", () => {
		test("creates config with single provider", () => {
			const config = singleProvider("anthropic");
			expect(config.providers).toHaveLength(1);
			expect(config.providers[0].name).toBe("anthropic");
			expect(config.selection.type).toBe("fallback");
			expect(config.selection.order).toEqual(["anthropic"]);
		});

		test("creates config with apiKey", () => {
			const config = singleProvider("openai", "sk-test");
			expect(config.providers[0].apiKey).toBe("sk-test");
		});

		test("creates config with metadata", () => {
			const config = singleProvider("gemini", undefined, { costPer1kTokens: 0.001 });
			expect(config.providers[0].metadata?.costPer1kTokens).toBe(0.001);
		});
	});

	describe("fallbackProviders()", () => {
		test("creates config with fallback order", () => {
			const config = fallbackProviders(["anthropic", "openai", "gemini"]);
			expect(config.providers).toHaveLength(3);
			expect(config.providers[0].name).toBe("anthropic");
			expect(config.providers[1].name).toBe("openai");
			expect(config.providers[2].name).toBe("gemini");
			expect(config.selection.type).toBe("fallback");
			expect(config.selection.order).toEqual(["anthropic", "openai", "gemini"]);
		});
	});

	describe("costOptimizedProviders()", () => {
		test("creates cost-optimized config", () => {
			const config = costOptimizedProviders([
				{ name: "cheap", costPer1kTokens: 0.001 },
				{ name: "expensive", costPer1kTokens: 0.01 },
			]);
			expect(config.providers).toHaveLength(2);
			expect(config.providers[0].metadata?.costPer1kTokens).toBe(0.001);
			expect(config.selection.type).toBe("cost-optimized");
		});

		test("creates cost-optimized config with max budget", () => {
			const config = costOptimizedProviders(
				[
					{ name: "cheap", costPer1kTokens: 0.001 },
					{ name: "expensive", costPer1kTokens: 0.01 },
				],
				0.005,
			);
			expect(config.selection.maxBudgetPer1kTokens).toBe(0.005);
		});

		test("handles empty array", () => {
			const config = costOptimizedProviders([]);
			expect(config.providers).toHaveLength(0);
		});
	});

	describe("resolveApiKey()", () => {
		test("returns apiKey if provided", () => {
			const provider: SingleProviderConfig = { name: "anthropic", apiKey: "sk-direct" };
			expect(resolveApiKey(provider)).toBe("sk-direct");
		});

		test("returns undefined if no apiKey and no env var", () => {
			const provider: SingleProviderConfig = { name: "anthropic" };
			delete process.env.ANTHROPIC_API_KEY;
			expect(resolveApiKey(provider)).toBeUndefined();
		});

		test("resolves anthropic from env", () => {
			const provider: SingleProviderConfig = { name: "anthropic" };
			process.env.ANTHROPIC_API_KEY = "sk-anthropic";
			try {
				expect(resolveApiKey(provider)).toBe("sk-anthropic");
			} finally {
				delete process.env.ANTHROPIC_API_KEY;
			}
		});

		test("resolves openai from env", () => {
			const provider: SingleProviderConfig = { name: "openai" };
			process.env.OPENAI_API_KEY = "sk-openai";
			try {
				expect(resolveApiKey(provider)).toBe("sk-openai");
			} finally {
				delete process.env.OPENAI_API_KEY;
			}
		});

		test("resolves google from GOOGLE_API_KEY env", () => {
			const provider: SingleProviderConfig = { name: "google" };
			process.env.GOOGLE_API_KEY = "sk-google";
			try {
				expect(resolveApiKey(provider)).toBe("sk-google");
			} finally {
				delete process.env.GOOGLE_API_KEY;
			}
		});

		test("resolves gemini from GEMINI_API_KEY env", () => {
			const provider: SingleProviderConfig = { name: "gemini" };
			process.env.GEMINI_API_KEY = "sk-gemini";
			try {
				expect(resolveApiKey(provider)).toBe("sk-gemini");
			} finally {
				delete process.env.GEMINI_API_KEY;
			}
		});

		test("resolves ollama from env", () => {
			const provider: SingleProviderConfig = { name: "ollama" };
			process.env.OLLAMA_API_KEY = "sk-ollama";
			try {
				expect(resolveApiKey(provider)).toBe("sk-ollama");
			} finally {
				delete process.env.OLLAMA_API_KEY;
			}
		});

		test("resolves openrouter from env", () => {
			const provider: SingleProviderConfig = { name: "openrouter" };
			process.env.OPENROUTER_API_KEY = "sk-openrouter";
			try {
				expect(resolveApiKey(provider)).toBe("sk-openrouter");
			} finally {
				delete process.env.OPENROUTER_API_KEY;
			}
		});

		test("falls back to LLM_API_KEY for unknown provider", () => {
			const provider: SingleProviderConfig = { name: "unknown" };
			process.env.LLM_API_KEY = "sk-llm";
			try {
				expect(resolveApiKey(provider)).toBe("sk-llm");
			} finally {
				delete process.env.LLM_API_KEY;
			}
		});

		test("falls back to API_KEY for unknown provider", () => {
			const provider: SingleProviderConfig = { name: "unknown" };
			delete process.env.LLM_API_KEY;
			process.env.API_KEY = "sk-api";
			try {
				expect(resolveApiKey(provider)).toBe("sk-api");
			} finally {
				delete process.env.API_KEY;
			}
		});
	});

	describe("getProviderApiType()", () => {
		test("returns anthropic-messages for anthropic", () => {
			expect(getProviderApiType("anthropic")).toBe("anthropic-messages");
		});

		test("returns openai-completions for openai", () => {
			expect(getProviderApiType("openai")).toBe("openai-completions");
		});

		test("returns openai-completions for openrouter", () => {
			expect(getProviderApiType("openrouter")).toBe("openai-completions");
		});

		test("returns google-generative-ai for google", () => {
			expect(getProviderApiType("google")).toBe("google-generative-ai");
		});

		test("returns google-generative-ai for gemini", () => {
			expect(getProviderApiType("gemini")).toBe("google-generative-ai");
		});

		test("returns openai-completions for unknown provider", () => {
			expect(getProviderApiType("unknown")).toBe("openai-completions");
		});
	});

	// =============================================================================
	// Edge cases
	// =============================================================================

	describe("edge cases", () => {
		test("handles single provider array", () => {
			const providers: SingleProviderConfig[] = [{ name: "only" }];
			const policy: SelectionPolicy = { type: "cost-optimized" };
			const result = selector.select(providers, policy);
			expect(result.provider.name).toBe("only");
		});

		test("handles providers with undefined metadata", () => {
			const providers: SingleProviderConfig[] = [
				{ name: "no-metadata" },
				{ name: "with-metadata", metadata: { costPer1kTokens: 0.001 } },
			];
			const policy: SelectionPolicy = { type: "cost-optimized" };
			const result = selector.select(providers, policy);
			// Provider with metadata and lower cost should win
			expect(result.provider.name).toBe("with-metadata");
		});

		test("handles all providers with same cost", () => {
			const providers: SingleProviderConfig[] = [
				{ name: "first", metadata: { costPer1kTokens: 0.01 } },
				{ name: "second", metadata: { costPer1kTokens: 0.01 } },
			];
			const policy: SelectionPolicy = { type: "cost-optimized" };
			const result = selector.select(providers, policy);
			// First in sorted order should win (stable sort behavior)
			expect(["first", "second"]).toContain(result.provider.name);
		});

		test("handles empty providers array with fallback", () => {
			const providers: SingleProviderConfig[] = [];
			const policy: SelectionPolicy = { type: "fallback", order: [] };
			// Returns a result with undefined provider when array is empty
			const result = selector.select(providers, policy);
			expect(result.provider).toBeUndefined();
			expect(result.reason).toContain("Fallback order not matched");
		});

		test("handles unknown policy type with default case", () => {
			const providers: SingleProviderConfig[] = [{ name: "test" }];
			// Cast to bypass TypeScript's type checking - tests the default case
			const unknownPolicy = { type: "invalid-type" as unknown as SelectionPolicy };
			const result = selector.select(providers, unknownPolicy);
			expect(result.provider.name).toBe("test");
			expect(result.reason).toContain("unknown policy");
		});
	});
});
