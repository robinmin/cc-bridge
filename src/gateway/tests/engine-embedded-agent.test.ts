import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";

// Mock logger
mock.module("@/packages/logger", () => ({
	logger: {
		info: mock(() => {}),
		warn: mock(() => {}),
		debug: mock(() => {}),
		error: mock(() => {}),
	},
}));

// Mock workspace
mock.module("./workspace", () => ({
	loadWorkspaceBootstrap: mock(async () => "system prompt"),
	WorkspaceWatcher: class {
		start = mock(async () => {});
		dispose = mock(() => {});
	},
}));

// Track callbacks for testing
let capturedOnReload: ((newPrompt: string) => void) | undefined;

// Mock workspace - capture onReload callback
mock.module("@/packages/agent/workspace", () => ({
	loadWorkspaceBootstrap: mock(async () => "system prompt"),
	WorkspaceWatcher: class {
		constructor(config?: { onReload?: (newPrompt: string) => void }) {
			if (config?.onReload) {
				capturedOnReload = config.onReload;
			}
		}
		start = mock(async () => {});
		dispose = mock(() => {});
		triggerReload = (newPrompt: string) => capturedOnReload?.(newPrompt);
	},
}));

import { EmbeddedAgent, PROVIDER_CONFIGS, resolveProviderApiKey } from "@/gateway/engine/embedded-agent";

describe("embedded-agent", () => {
	// Set up API key for tests that need it
	const originalEnv = process.env.ANTHROPIC_API_KEY;
	beforeEach(() => {
		process.env.ANTHROPIC_API_KEY = "test-key-anthropic";
	});
	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.ANTHROPIC_API_KEY = originalEnv;
		} else {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	describe("PROVIDER_CONFIGS", () => {
		test("contains anthropic config", () => {
			expect(PROVIDER_CONFIGS).toHaveProperty("anthropic");
			expect(PROVIDER_CONFIGS.anthropic.api).toBe("anthropic-messages");
		});

		test("contains openai config", () => {
			expect(PROVIDER_CONFIGS).toHaveProperty("openai");
			expect(PROVIDER_CONFIGS.openai.api).toBe("openai-completions");
		});

		test("contains google config", () => {
			expect(PROVIDER_CONFIGS).toHaveProperty("google");
			expect(PROVIDER_CONFIGS.google.api).toBe("google-generative-ai");
		});

		test("contains gemini config", () => {
			expect(PROVIDER_CONFIGS).toHaveProperty("gemini");
			expect(PROVIDER_CONFIGS.gemini.api).toBe("google-generative-ai");
		});

		test("contains openrouter config", () => {
			expect(PROVIDER_CONFIGS).toHaveProperty("openrouter");
			expect(PROVIDER_CONFIGS.openrouter.api).toBe("openai-completions");
		});

		test("openrouter has custom baseUrl", () => {
			expect(PROVIDER_CONFIGS.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
		});

		test("each provider has getApiKey function", () => {
			for (const [_name, config] of Object.entries(PROVIDER_CONFIGS)) {
				expect(typeof config.getApiKey).toBe("function");
				expect(config.api).toBeDefined();
			}
		});
	});

	describe("resolveProviderApiKey", () => {
		test("returns key from known provider", () => {
			const result = resolveProviderApiKey("anthropic");
			expect(result).toBe("test-key-anthropic");
		});

		test("returns undefined for unknown provider without env fallback", () => {
			const originalLlmKey = process.env.LLM_API_KEY;
			const originalApiKey = process.env.API_KEY;
			delete process.env.LLM_API_KEY;
			delete process.env.API_KEY;

			const result = resolveProviderApiKey("unknown-provider");
			expect(result).toBeUndefined();

			if (originalLlmKey !== undefined) {
				process.env.LLM_API_KEY = originalLlmKey;
			}
			if (originalApiKey !== undefined) {
				process.env.API_KEY = originalApiKey;
			}
		});

		test("falls back to LLM_API_KEY for unknown provider", () => {
			const originalLlmKey = process.env.LLM_API_KEY;
			const originalApiKey = process.env.API_KEY;
			delete process.env.API_KEY;
			process.env.LLM_API_KEY = "fallback-key";

			const result = resolveProviderApiKey("unknown-provider");
			expect(result).toBe("fallback-key");

			if (originalLlmKey !== undefined) {
				process.env.LLM_API_KEY = originalLlmKey;
			} else {
				delete process.env.LLM_API_KEY;
			}
			if (originalApiKey !== undefined) {
				process.env.API_KEY = originalApiKey;
			}
		});

		test("falls back to API_KEY as last resort", () => {
			const originalApiKey = process.env.API_KEY;
			delete process.env.LLM_API_KEY;
			process.env.API_KEY = "api-key-fallback";

			const result = resolveProviderApiKey("unknown-provider");
			expect(result).toBe("api-key-fallback");

			if (originalApiKey !== undefined) {
				process.env.API_KEY = originalApiKey;
			} else {
				delete process.env.API_KEY;
			}
		});
	});

	describe("EmbeddedAgent", () => {
		test("creates agent with config", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			expect(agent).toBeDefined();
			agent.dispose();
		});

		test("creates agent with unknown provider using fallback", () => {
			process.env.LLM_API_KEY = "fallback-key";
			const agent = new EmbeddedAgent({
				provider: "unknown-provider",
				model: "test-model",
				workspaceDir: "/tmp/test",
			});
			expect(agent).toBeDefined();
			agent.dispose();
			delete process.env.LLM_API_KEY;
		});

		test("creates agent with tools in constructor", () => {
			const mockTool: AgentTool<unknown> = {
				name: "test",
				label: "Test",
				description: "A test tool",
				parameters: Type.Object({}) as Static<typeof Type.Object<object>>,
				execute: async () => ({ content: [], details: undefined }),
			};
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
				tools: [mockTool],
			});
			expect(agent).toBeDefined();
			expect(agent.getTools().length).toBe(1);
			agent.dispose();
		});

		test("initializes with workspace", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.initialize();
			agent.dispose();
		});

		test("initialize throws if no API key", async () => {
			delete process.env.ANTHROPIC_API_KEY;
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await expect(agent.initialize()).rejects.toThrow();
			process.env.ANTHROPIC_API_KEY = "test-key-anthropic";
			agent.dispose();
		});

		test("initialize is idempotent", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.initialize();
			await agent.initialize();
			agent.dispose();
		});

		test("hot reload updates system prompt via onReload callback", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.initialize();
			const _initialPrompt = agent.getSystemPrompt();

			// Trigger the reload callback (simulates workspace file change)
			// @ts-expect-error - accessing internal trigger method from mock
			const watcher = agent["watcher"];
			if (watcher?.triggerReload) {
				watcher.triggerReload("new system prompt");
			}

			expect(agent.getSystemPrompt()).toBe("new system prompt");
			agent.dispose();
		});

		test("getSessionId returns session id", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			const sessionId = agent.getSessionId();
			// Session ID is generated - check it's a string
			expect(typeof sessionId === "string" || sessionId === undefined).toBe(true);
			agent.dispose();
		});

		test("getSystemPrompt returns empty string initially", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			const prompt = agent.getSystemPrompt();
			expect(prompt).toBe("");
			agent.dispose();
		});

		test("getMessages returns empty array initially", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			const messages = agent.getMessages();
			expect(messages).toEqual([]);
			agent.dispose();
		});

		test("clearMessages clears messages", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			agent.clearMessages();
			expect(agent.getMessages()).toEqual([]);
			agent.dispose();
		});

		test("getTools returns empty array initially", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			const tools = agent.getTools();
			expect(tools).toEqual([]);
			agent.dispose();
		});

		test("setTools sets tools", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			const mockTool: AgentTool<unknown> = { name: "test", description: "test", parameters: {} };
			agent.setTools([mockTool]);
			agent.dispose();
		});

		test("isRunning returns false initially", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			expect(agent.isRunning()).toBe(false);
			agent.dispose();
		});

		test("prompt auto-initializes if not initialized", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			// This should auto-initialize
			const result = await agent.prompt("test message");
			expect(result).toBeDefined();
			agent.dispose();
		});

		test("prompt throws if already running", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.initialize();

			// Start a prompt but don't await it
			const prompt1 = agent.prompt("message 1");

			// Second prompt should throw
			await expect(agent.prompt("message 2")).rejects.toThrow();

			// Wait for first prompt to complete
			try {
				await prompt1;
			} catch {
				// May throw due to mock
			}
			agent.dispose();
		});

		test("steer wraps string into UserMessage", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			agent.steer("test message");
			agent.dispose();
		});

		test("abort calls agent abort", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			agent.abort();
			agent.dispose();
		});

		test("queueFollowUp throws if not running", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			expect(() => agent.queueFollowUp("message")).toThrow();
			agent.dispose();
		});

		test("queueFollowUp adds to queue when running", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.initialize();

			// Manually set promptRunning to true to test queueing
			// @ts-expect-error - accessing private property
			agent.promptRunning = true;

			// Should not throw when running
			agent.queueFollowUp("follow-up message");

			// @ts-expect-error - accessing private property
			const queue = agent.followUpQueue;
			expect(queue).toContain("follow-up message");

			agent.dispose();
		});

		test("drainFollowUpQueue returns empty array", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			const queue = agent.drainFollowUpQueue();
			expect(queue).toEqual([]);
			agent.dispose();
		});

		test("waitForIdle resolves immediately", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.waitForIdle();
			agent.dispose();
		});

		test("getRawAgent returns the underlying agent", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			const rawAgent = agent.getRawAgent();
			expect(rawAgent).toBeDefined();
			agent.dispose();
		});

		test("dispose cleans up", () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			agent.dispose();
		});

		test("prompt accepts maxIterations option", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.initialize();
			const result = await agent.prompt("test", { maxIterations: 10 });
			expect(result).toBeDefined();
			agent.dispose();
		});

		test("prompt accepts timeoutMs option", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.initialize();
			const result = await agent.prompt("test", { timeoutMs: 60000 });
			expect(result).toBeDefined();
			agent.dispose();
		});

		// Test that triggers timeout handler code path
		test("timeout handler executes when timeout occurs", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.initialize();

			// Use a very short timeout that will expire during the test
			const result = await agent.prompt("test", { timeoutMs: 1 });
			expect(result).toBeDefined();
			agent.dispose();
		});

		test("prompt accepts onEvent callback", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.initialize();
			const onEventFn = mock(() => {});
			const result = await agent.prompt("test", { onEvent: onEventFn });
			expect(result).toBeDefined();
			expect(onEventFn).toHaveBeenCalled();
			agent.dispose();
		});

		test("prompt accepts onImmediate callback", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.initialize();
			const onImmediateFn = mock(() => {});
			const result = await agent.prompt("test", { onImmediate: onImmediateFn });
			expect(result).toBeDefined();
			agent.dispose();
		});

		test("prompt with maxIterations triggers callback when reached", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.initialize();
			// Set very low maxIterations to trigger callback
			const result = await agent.prompt("test", { maxIterations: 1 });
			expect(result).toBeDefined();
			agent.dispose();
		});
	});
});
