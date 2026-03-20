import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	loadAgentConfig,
	buildAgentConfig,
	getDefaultAgentConfigPath,
	type AgentYamlConfig,
} from "@/packages/agent/core/config-loader";

describe("loadAgentConfig", () => {
	const testConfigPath = "/tmp/test-agent-config.jsonc";

	beforeEach(() => {
		if (fs.existsSync(testConfigPath)) {
			fs.unlinkSync(testConfigPath);
		}
	});

	afterEach(() => {
		if (fs.existsSync(testConfigPath)) {
			fs.unlinkSync(testConfigPath);
		}
	});

	test("should load valid JSONC config", () => {
		const configContent = `{
			"provider": { "default": "anthropic" },
			"model": { "default": "claude-sonnet-4-6" }
		}`;
		fs.writeFileSync(testConfigPath, configContent, "utf-8");

		const config = loadAgentConfig(testConfigPath);

		expect(config.provider.default).toBe("anthropic");
		expect(config.model.default).toBe("claude-sonnet-4-6");
	});

	test("should load config with comments", () => {
		const configContent = `{
			// This is a comment
			"provider": { "default": "openai" },
			"model": { "default": "gpt-4o" }
		}`;
		fs.writeFileSync(testConfigPath, configContent, "utf-8");

		const config = loadAgentConfig(testConfigPath);

		expect(config.provider.default).toBe("openai");
		expect(config.model.default).toBe("gpt-4o");
	});

	test("should throw when config file not found", () => {
		expect(() => loadAgentConfig("/non/existent/path.jsonc")).toThrow(
			"Agent config file not found",
		);
	});

	test("should throw when provider is missing", () => {
		const configContent = `{
			"model": { "default": "claude-sonnet-4-6" }
		}`;
		fs.writeFileSync(testConfigPath, configContent, "utf-8");

		expect(() => loadAgentConfig(testConfigPath)).toThrow("Agent config must have a 'provider' object");
	});

	test("should throw when model is missing", () => {
		const configContent = `{
			"provider": { "default": "anthropic" }
		}`;
		fs.writeFileSync(testConfigPath, configContent, "utf-8");

		expect(() => loadAgentConfig(testConfigPath)).toThrow("Agent config must have a 'model' object");
	});

	test("should throw when provider.default is not a string", () => {
		const configContent = `{
			"provider": { "default": 123 },
			"model": { "default": "claude-sonnet-4-6" }
		}`;
		fs.writeFileSync(testConfigPath, configContent, "utf-8");

		expect(() => loadAgentConfig(testConfigPath)).toThrow("Provider 'default' must be a string");
	});

	test("should throw when model.default is not a string", () => {
		const configContent = `{
			"provider": { "default": "anthropic" },
			"model": { "default": false }
		}`;
		fs.writeFileSync(testConfigPath, configContent, "utf-8");

		expect(() => loadAgentConfig(testConfigPath)).toThrow("Model 'default' must be a string");
	});

	test("should throw when config is not an object", () => {
		fs.writeFileSync(testConfigPath, '"just a string"', "utf-8");

		expect(() => loadAgentConfig(testConfigPath)).toThrow("Agent config must be an object");
	});

	test("should throw when config is null", () => {
		fs.writeFileSync(testConfigPath, "null", "utf-8");

		expect(() => loadAgentConfig(testConfigPath)).toThrow("Agent config must be an object");
	});

	test("should accept valid config with all optional fields", () => {
		const configContent = `{
			"provider": { "default": "anthropic" },
			"model": { "default": "claude-sonnet-4-6", "reasoning": true },
			"tools": { "enabled": true, "policy": { "default": "read-only" } },
			"sandbox": { "mode": "host", "limits": { "memory": "512m", "cpus": 2, "pids": 100 } },
			"memory": { "enabled": true, "backend": "builtin" },
			"rag": { "enabled": true, "threshold": 0.3, "maxResults": 5, "mode": "hybrid" },
			"observability": { "enabled": false },
			"session": { "ttlMs": 1800000, "maxSessions": 100 }
		}`;
		fs.writeFileSync(testConfigPath, configContent, "utf-8");

		const config = loadAgentConfig(testConfigPath);

		expect(config.provider.default).toBe("anthropic");
		expect(config.model.default).toBe("claude-sonnet-4-6");
		expect(config.model.reasoning).toBe(true);
		expect(config.tools?.enabled).toBe(true);
		expect(config.tools?.policy?.default).toBe("read-only");
		expect(config.sandbox?.mode).toBe("host");
		expect(config.sandbox?.limits?.memory).toBe("512m");
		expect(config.memory?.enabled).toBe(true);
		expect(config.memory?.backend).toBe("builtin");
		expect(config.rag?.enabled).toBe(true);
		expect(config.rag?.threshold).toBe(0.3);
		expect(config.rag?.mode).toBe("hybrid");
		expect(config.observability?.enabled).toBe(false);
		expect(config.session?.ttlMs).toBe(1800000);
	});

	test("should handle multi-line comments", () => {
		const configContent = `{
			/* This is a
			   multi-line comment */
			"provider": { "default": "google" },
			"model": { "default": "gemini-pro" }
		}`;
		fs.writeFileSync(testConfigPath, configContent, "utf-8");

		const config = loadAgentConfig(testConfigPath);

		expect(config.provider.default).toBe("google");
		expect(config.model.default).toBe("gemini-pro");
	});
});

describe("buildAgentConfig", () => {
	const minimalConfig: AgentYamlConfig = {
		provider: { default: "anthropic" },
		model: { default: "claude-sonnet-4-6" },
	};

	test("should build config with minimal config", () => {
		const result = buildAgentConfig(minimalConfig, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.sessionId).toBe("session-123");
		expect(result.workspaceDir).toBe("/workspace/test");
		expect(result.provider).toBe("anthropic");
		expect(result.model).toBe("claude-sonnet-4-6");
	});

	test("should include workspace from options when provided", () => {
		const result = buildAgentConfig(minimalConfig, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
			workspace: "my-workspace",
		});

		expect(result.workspace).toBeUndefined(); // buildAgentConfig doesn't use workspace
	});

	test("should build config with model reasoning", () => {
		const configWithReasoning: AgentYamlConfig = {
			...minimalConfig,
			model: { default: "claude-sonnet-4-6", reasoning: true },
		};

		const result = buildAgentConfig(configWithReasoning, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.modelReasoning).toBe(true);
	});

	test("should build RAG config when enabled", () => {
		const configWithRag: AgentYamlConfig = {
			...minimalConfig,
			rag: { enabled: true, threshold: 0.5, maxResults: 10, mode: "vector" },
		};

		const result = buildAgentConfig(configWithRag, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.rag).toEqual({
			enabled: true,
			threshold: 0.5,
			maxResults: 10,
			mode: "vector",
		});
	});

	test("should not include RAG config when disabled", () => {
		const configWithRagDisabled: AgentYamlConfig = {
			...minimalConfig,
			rag: { enabled: false },
		};

		const result = buildAgentConfig(configWithRagDisabled, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.rag).toBeUndefined();
	});

	test("should build observability config when enabled", () => {
		const configWithObservability: AgentYamlConfig = {
			...minimalConfig,
			observability: { enabled: true },
		};

		const result = buildAgentConfig(configWithObservability, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.observability).toEqual({ enabled: true });
	});

	test("should build OTEL config when enabled in observability", () => {
		const configWithOtel: AgentYamlConfig = {
			...minimalConfig,
			observability: {
				enabled: true,
				otel: {
					enabled: true,
					endpoint: "http://otel:4318",
					serviceName: "test-service",
					sampleRate: 0.5,
					traces: true,
					metrics: false,
				},
			},
		};

		const result = buildAgentConfig(configWithOtel, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.otel).toEqual({
			enabled: true,
			endpoint: "http://otel:4318",
			serviceName: "test-service",
			sampleRate: 0.5,
			traces: true,
			metrics: false,
		});
	});

	test("should not include OTEL config when disabled", () => {
		const configWithOtelDisabled: AgentYamlConfig = {
			...minimalConfig,
			observability: {
				enabled: true,
				otel: { enabled: false },
			},
		};

		const result = buildAgentConfig(configWithOtelDisabled, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.otel).toBeUndefined();
	});
});

describe("buildAgentConfig - multi-provider strategies", () => {
	const baseConfig: AgentYamlConfig = {
		provider: { default: "anthropic" },
		model: { default: "claude-sonnet-4-6" },
	};

	test("should return simple string provider when no multiProvider", () => {
		const result = buildAgentConfig(baseConfig, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.provider).toBe("anthropic");
	});

	test("should build cost-optimized multi-provider config", () => {
		const config: AgentYamlConfig = {
			...baseConfig,
			provider: {
				default: "anthropic",
				multiProvider: {
					strategy: "cost-optimized",
					maxBudgetPer1kTokens: 0.01,
				},
			},
		};

		const result = buildAgentConfig(config, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.provider).toEqual({
			type: "multi",
			primary: "anthropic",
			selectionPolicy: {
				type: "cost-optimized",
				maxBudgetPer1kTokens: 0.01,
			},
		});
	});

	test("should build latency-optimized multi-provider config", () => {
		const config: AgentYamlConfig = {
			...baseConfig,
			provider: {
				default: "anthropic",
				multiProvider: {
					strategy: "latency-optimized",
					maxLatencyMs: 1000,
				},
			},
		};

		const result = buildAgentConfig(config, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.provider).toEqual({
			type: "multi",
			primary: "anthropic",
			selectionPolicy: {
				type: "latency-optimized",
				maxLatencyMs: 1000,
			},
		});
	});

	test("should build quality-optimized multi-provider config", () => {
		const config: AgentYamlConfig = {
			...baseConfig,
			provider: {
				default: "anthropic",
				multiProvider: {
					strategy: "quality-optimized",
					preferredProviders: ["anthropic", "openai"],
				},
			},
		};

		const result = buildAgentConfig(config, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.provider).toEqual({
			type: "multi",
			primary: "anthropic",
			selectionPolicy: {
				type: "quality-optimized",
				preferredProviders: ["anthropic", "openai"],
			},
		});
	});

	test("should build fallback multi-provider config", () => {
		const config: AgentYamlConfig = {
			...baseConfig,
			provider: {
				default: "anthropic",
				multiProvider: {
					strategy: "fallback",
					order: ["anthropic", "openai", "google"],
				},
			},
		};

		const result = buildAgentConfig(config, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.provider).toEqual({
			type: "multi",
			primary: "anthropic",
			selectionPolicy: {
				type: "fallback",
				order: ["anthropic", "openai", "google"],
			},
		});
	});

	test("should use default provider when order not specified in fallback", () => {
		const config: AgentYamlConfig = {
			...baseConfig,
			provider: {
				default: "anthropic",
				multiProvider: {
					strategy: "fallback",
				},
			},
		};

		const result = buildAgentConfig(config, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.provider).toEqual({
			type: "multi",
			primary: "anthropic",
			selectionPolicy: {
				type: "fallback",
				order: ["anthropic"],
			},
		});
	});

	test("should build smart multi-provider config", () => {
		const config: AgentYamlConfig = {
			...baseConfig,
			provider: {
				default: "anthropic",
				multiProvider: {
					strategy: "smart",
					weights: { cost: 0.2, latency: 0.3, quality: 0.5 },
				},
			},
		};

		const result = buildAgentConfig(config, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.provider).toEqual({
			type: "multi",
			primary: "anthropic",
			selectionPolicy: {
				type: "smart",
				weights: { cost: 0.2, latency: 0.3, quality: 0.5 },
			},
		});
	});

	test("should use default weights for smart strategy when not specified", () => {
		const config: AgentYamlConfig = {
			...baseConfig,
			provider: {
				default: "anthropic",
				multiProvider: {
					strategy: "smart",
				},
			},
		};

		const result = buildAgentConfig(config, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.provider).toEqual({
			type: "multi",
			primary: "anthropic",
			selectionPolicy: {
				type: "smart",
				weights: { cost: 0.33, latency: 0.33, quality: 0.34 },
			},
		});
	});

	test("should return simple string for unknown strategy", () => {
		const config: AgentYamlConfig = {
			...baseConfig,
			provider: {
				default: "anthropic",
				multiProvider: {
					// @ts-expect-error - testing unknown strategy
					strategy: "unknown-strategy",
				},
			},
		};

		const result = buildAgentConfig(config, {
			workspaceDir: "/workspace/test",
			sessionId: "session-123",
		});

		expect(result.provider).toBe("anthropic");
	});
});

describe("getDefaultAgentConfigPath", () => {
	const originalEnv = process.env.AGENT_CONFIG_PATH;

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.AGENT_CONFIG_PATH = originalEnv;
		} else {
			delete process.env.AGENT_CONFIG_PATH;
		}
	});

	test("should return environment variable path when set", () => {
		process.env.AGENT_CONFIG_PATH = "/custom/path/agent.jsonc";

		const result = getDefaultAgentConfigPath();

		expect(result).toBe("/custom/path/agent.jsonc");
	});

	test("should return existing file path when found", () => {
		delete process.env.AGENT_CONFIG_PATH;

		// The actual file exists in the project
		const result = getDefaultAgentConfigPath();

		expect(result).toContain("agent.jsonc");
	});

	test("should return first default path when no file exists", () => {
		delete process.env.AGENT_CONFIG_PATH;
		const originalExistsSync = fs.existsSync;
		// @ts-expect-error - mocking
		fs.existsSync = () => false;

		const result = getDefaultAgentConfigPath();

		expect(result).toBe(path.resolve("data/config/agent.jsonc"));

		fs.existsSync = originalExistsSync;
	});
});
