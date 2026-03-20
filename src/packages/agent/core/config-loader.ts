/**
 * Agent Configuration Loader
 *
 * Loads agent configuration from JSONC files (JSON with comments), separating agent concerns
 * from gateway/application configuration.
 */

import fs from "node:fs";
import path from "node:path";
import { parse } from "jsonc-parser";

import type {
	AgentConfig,
	EmbeddedAgentObservabilityConfig,
	MultiProviderConfig,
	RagConfig,
	SingleProviderConfig,
} from "./embedded-agent";
import type { AgentOtelConfig } from "./otel";
import type { ToolPolicyConfig } from "../tools/policy";

/**
 * Agent configuration loaded from YAML
 */
export interface AgentYamlConfig {
	provider: {
		default: string;
		multiProvider?: {
			strategy: "cost-optimized" | "latency-optimized" | "quality-optimized" | "fallback" | "smart";
			maxBudgetPer1kTokens?: number;
			maxLatencyMs?: number;
			preferredProviders?: string[];
			weights?: { cost: number; latency: number; quality: number };
			order?: string[];
		};
	};
	model: {
		default: string;
		reasoning?: boolean;
		models?: Record<string, string>;
	};
	tools?: {
		enabled?: boolean;
		policy?: ToolPolicyConfig;
	};
	sandbox?: {
		mode?: "host" | "docker";
		docker?: {
			image?: string;
			network?: string;
		};
		limits?: {
			memory?: string;
			cpus?: number;
			pids?: number;
		};
	};
	memory?: {
		enabled?: boolean;
		backend?: "builtin" | "external" | "none";
		compaction?: {
			enabled?: boolean;
			reserveTokens?: number;
			keepRecentTokens?: number;
		};
		indexing?: {
			enabled?: boolean;
			vector?: boolean;
			provider?: "openai" | "gemini" | "voyage" | "mistral";
		};
	};
	rag?: {
		enabled?: boolean;
		threshold?: number;
		maxResults?: number;
		mode?: "keyword" | "vector" | "hybrid";
	};
	observability?: {
		enabled?: boolean;
		otel?: AgentOtelConfig;
	};
	session?: {
		ttlMs?: number;
		maxSessions?: number;
		maxMessagesPerSession?: number;
		cleanupIntervalMs?: number;
	};
}

/**
 * Load agent configuration from a JSONC file.
 *
 * @param configPath - Path to the agent JSONC config file
 * @returns Parsed agent configuration object
 * @throws Error if file cannot be read or parsed
 */
export function loadAgentConfig(configPath: string): AgentYamlConfig {
	if (!fs.existsSync(configPath)) {
		throw new Error(`Agent config file not found: ${configPath}`);
	}

	const content = fs.readFileSync(configPath, "utf-8");
	const errors: import("jsonc-parser").ParseError[] = [];
	const config = parse(content, errors) as AgentYamlConfig;

	// jsonc-parser reports non-fatal errors (e.g., trailing commas) - check if parse succeeded
	if (errors.length > 0 && !config) {
		throw new Error(`Failed to parse agent config at offset ${errors[0].offset}`);
	}

	validateAgentConfig(config);

	return config;
}

/**
 * Validate agent configuration structure
 */
function validateAgentConfig(config: unknown): asserts config is AgentYamlConfig {
	if (!config || typeof config !== "object") {
		throw new Error("Agent config must be an object");
	}

	const cfg = config as Record<string, unknown>;

	if (!cfg.provider || typeof cfg.provider !== "object") {
		throw new Error("Agent config must have a 'provider' object");
	}

	const provider = cfg.provider as Record<string, unknown>;
	if (typeof provider.default !== "string") {
		throw new Error("Provider 'default' must be a string");
	}

	if (!cfg.model || typeof cfg.model !== "object") {
		throw new Error("Agent config must have a 'model' object");
	}

	const model = cfg.model as Record<string, unknown>;
	if (typeof model.default !== "string") {
		throw new Error("Model 'default' must be a string");
	}
}

/**
 * Build AgentConfig from YAML config for a specific workspace/session.
 *
 * @param yamlConfig - The loaded YAML configuration
 * @param options - Runtime options (workspaceDir, sessionId, etc.)
 * @returns AgentConfig suitable for creating an EmbeddedAgent
 */
export function buildAgentConfig(
	yamlConfig: AgentYamlConfig,
	options: {
		workspaceDir: string;
		sessionId: string;
		workspace?: string;
	},
): AgentConfig {
	// Build provider config
	const providerConfig = buildProviderConfig(yamlConfig.provider);

	// Build RAG config
	const ragConfig: RagConfig | undefined = yamlConfig.rag?.enabled
		? {
				enabled: yamlConfig.rag.enabled,
				threshold: yamlConfig.rag.threshold,
				maxResults: yamlConfig.rag.maxResults,
				mode: yamlConfig.rag.mode,
			}
		: undefined;

	// Build observability config
	const observabilityConfig: EmbeddedAgentObservabilityConfig | undefined = yamlConfig.observability?.enabled
		? { enabled: true }
		: undefined;

	// Build OTEL config
	const otelConfig: AgentOtelConfig | undefined = yamlConfig.observability?.otel?.enabled
		? {
				enabled: true,
				endpoint: yamlConfig.observability.otel.endpoint,
				serviceName: yamlConfig.observability.otel.serviceName,
				sampleRate: yamlConfig.observability.otel.sampleRate,
				traces: yamlConfig.observability.otel.traces,
				metrics: yamlConfig.observability.otel.metrics,
			}
		: undefined;

	return {
		sessionId: options.sessionId,
		workspaceDir: options.workspaceDir,
		provider: providerConfig,
		model: yamlConfig.model.default,
		modelReasoning: yamlConfig.model.reasoning,
		rag: ragConfig,
		observability: observabilityConfig,
		otel: otelConfig,
	};
}

/**
 * Build provider config from YAML
 */
function buildProviderConfig(
	providerConfig: AgentYamlConfig["provider"],
): string | SingleProviderConfig | MultiProviderConfig {
	if (!providerConfig.multiProvider) {
		return providerConfig.default;
	}

	const { multiProvider } = providerConfig;
	const strategy = multiProvider.strategy;

	switch (strategy) {
		case "cost-optimized":
			return {
				type: "multi",
				primary: providerConfig.default,
				selectionPolicy: {
					type: "cost-optimized",
					maxBudgetPer1kTokens: multiProvider.maxBudgetPer1kTokens,
				},
			};

		case "latency-optimized":
			return {
				type: "multi",
				primary: providerConfig.default,
				selectionPolicy: {
					type: "latency-optimized",
					maxLatencyMs: multiProvider.maxLatencyMs,
				},
			};

		case "quality-optimized":
			return {
				type: "multi",
				primary: providerConfig.default,
				selectionPolicy: {
					type: "quality-optimized",
					preferredProviders: multiProvider.preferredProviders,
				},
			};

		case "fallback":
			return {
				type: "multi",
				primary: providerConfig.default,
				selectionPolicy: {
					type: "fallback",
					order: multiProvider.order || [providerConfig.default],
				},
			};

		case "smart":
			return {
				type: "multi",
				primary: providerConfig.default,
				selectionPolicy: {
					type: "smart",
					weights: multiProvider.weights || { cost: 0.33, latency: 0.33, quality: 0.34 },
				},
			};

		default:
			return providerConfig.default;
	}
}

/**
 * Get default agent config path
 */
export function getDefaultAgentConfigPath(): string {
	// Check environment variable first
	if (process.env.AGENT_CONFIG_PATH) {
		return process.env.AGENT_CONFIG_PATH;
	}

	// Default paths in order of preference
	const defaultPaths = [
		"data/config/agent.jsonc",
		"config/agent.jsonc",
		"agent.jsonc",
	];

	for (const p of defaultPaths) {
		if (fs.existsSync(p)) {
			return path.resolve(p);
		}
	}

	// Return the first default path (will fail with clear error if not found)
	return path.resolve(defaultPaths[0]);
}
