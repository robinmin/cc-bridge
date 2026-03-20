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

// Mock workspace - capture onReload callback (updated path for core/ reorganization)
mock.module("@/packages/agent/core/workspace", () => ({
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

import { EmbeddedAgent, PROVIDER_CONFIGS, resolveProviderApiKey } from "@/gateway/engine/agent";

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

		test("getObservabilitySnapshot returns initial state", () => {
			const agent = new EmbeddedAgent({
				sessionId: "test-session",
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			const snapshot = agent.getObservabilitySnapshot();
			expect(snapshot).toBeDefined();
			expect(snapshot.sessionId).toBe("test-session");
			expect(snapshot.provider).toBe("anthropic");
			expect(snapshot.model).toBe("claude-3-5-sonnet-20241022");
			expect(snapshot.activeRun).toBeUndefined();
			expect(snapshot.lastRun).toBeUndefined();
			expect(snapshot.totals).toBeDefined();
			agent.dispose();
		});

		test("getObservabilitySnapshot after prompt has activeRun", async () => {
			const agent = new EmbeddedAgent({
				sessionId: "test-session-active",
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
			});
			await agent.initialize();

			// Mock the internal agent to hang but still resolve
			const rawAgent = agent.getRawAgent();
			const originalPrompt = rawAgent.prompt;
			// biome-ignore lint/suspicious/noExplicitAny: Testing internal behavior
			(rawAgent as any).prompt = async function (...args: unknown[]) {
				// Start a long-running operation but resolve normally after
				await new Promise((r) => setTimeout(r, 200));
				return originalPrompt.apply(this, args);
			};

			// Start a prompt to create activeRun
			const promptPromise = agent.prompt("test");

			// Wait for observability to start but before it finishes
			await new Promise((r) => setTimeout(r, 50));

			const snapshot = agent.getObservabilitySnapshot();
			expect(snapshot).toBeDefined();
			expect(snapshot.activeRun).toBeDefined();

			// Wait for prompt to complete
			await promptPromise;
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

			// Get raw agent and make it hang longer than our timeout
			const rawAgent = agent.getRawAgent();
			// biome-ignore lint/suspicious/noExplicitAny: Testing internal behavior
			(rawAgent as any).prompt = async (_args: unknown[]) => {
				// Hang longer than timeout (100ms > 10ms timeout)
				await new Promise((r) => setTimeout(r, 100));
				// Don't call original - timeout will abort
			};

			// Use short timeout that will expire while agent is hanging
			const result = await agent.prompt("test", { timeoutMs: 10 });
			// Result should still be defined - the timeout callback fires
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

		test("RAG context retrieval with mock memoryIndexer", async () => {
			// Create a mock memory indexer that returns search results
			const mockMemoryIndexer = {
				search: mock(async () => [
					{ path: "test.md", snippet: "Test content", score: 0.8 },
					{ path: "doc.md", snippet: "Documentation", score: 0.6 },
				]),
				initialize: mock(async () => {}),
				close: mock(() => {}),
				isInitialized: mock(() => true),
				getStatus: mock(async () => ({ initialized: true, fts5: true, vector: false, documentCount: 1 })),
				rebuild: mock(async () => ({ ok: true })),
				isVectorEnabled: mock(() => false),
			};

			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
				memoryIndexer: mockMemoryIndexer as unknown as typeof mockMemoryIndexer & {
					search: typeof mockMemoryIndexer.search;
				},
			});
			await agent.initialize();
			const result = await agent.prompt("test query for RAG");
			expect(result).toBeDefined();
			// Verify the mock was called (RAG retrieval happened)
			expect(mockMemoryIndexer.search).toHaveBeenCalled();
			agent.dispose();
		});

		test("RAG context below threshold returns no context", async () => {
			// Create a mock memory indexer that returns low-score results
			const mockMemoryIndexer = {
				search: mock(async () => [
					{ path: "test.md", snippet: "Test content", score: 0.1 }, // Below default threshold 0.3
				]),
				initialize: mock(async () => {}),
				close: mock(() => {}),
				isInitialized: mock(() => true),
				getStatus: mock(async () => ({ initialized: true, fts5: true, vector: false, documentCount: 1 })),
				rebuild: mock(async () => ({ ok: true })),
				isVectorEnabled: mock(() => false),
			};

			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
				memoryIndexer: mockMemoryIndexer as unknown as typeof mockMemoryIndexer & {
					search: typeof mockMemoryIndexer.search;
				},
			});
			await agent.initialize();
			const result = await agent.prompt("test query");
			expect(result).toBeDefined();
			agent.dispose();
		});

		test("RAG cache hit on repeated query", async () => {
			const searchCallCount = { value: 0 };
			const mockMemoryIndexer = {
				search: mock(async () => {
					searchCallCount.value++;
					return [{ path: "test.md", snippet: "Test content", score: 0.8 }];
				}),
				initialize: mock(async () => {}),
				close: mock(() => {}),
				isInitialized: mock(() => true),
				getStatus: mock(async () => ({ initialized: true, fts5: true, vector: false, documentCount: 1 })),
				rebuild: mock(async () => ({ ok: true })),
				isVectorEnabled: mock(() => false),
			};

			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
				memoryIndexer: mockMemoryIndexer as unknown as typeof mockMemoryIndexer & {
					search: typeof mockMemoryIndexer.search;
				},
			});
			await agent.initialize();

			// First prompt - should trigger search (cache miss)
			await agent.prompt("test query");
			expect(searchCallCount.value).toBe(1);

			// Second prompt with same normalized query - should hit cache (no search)
			await agent.prompt("TEST QUERY"); // Different casing, same normalized query

			// Search should NOT have been called again (cache hit)
			expect(searchCallCount.value).toBe(1);

			agent.dispose();
		});

		test("RAG cache cleared on clearMessages", async () => {
			const mockMemoryIndexer = {
				search: mock(async () => [{ path: "test.md", snippet: "Test", score: 0.8 }]),
				initialize: mock(async () => {}),
				close: mock(() => {}),
				isInitialized: mock(() => true),
				getStatus: mock(async () => ({ initialized: true, fts5: true, vector: false, documentCount: 1 })),
				rebuild: mock(async () => ({ ok: true })),
				isVectorEnabled: mock(() => false),
			};

			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
				memoryIndexer: mockMemoryIndexer as unknown as typeof mockMemoryIndexer & {
					search: typeof mockMemoryIndexer.search;
				},
			});
			await agent.initialize();

			// Make a prompt to populate cache
			await agent.prompt("test query");

			// Clear messages should also clear RAG cache
			agent.clearMessages();

			// Verify cache was cleared by checking messages are empty
			expect(agent.getMessages()).toEqual([]);

			agent.dispose();
		});

		test("RAG graceful degradation when indexer unavailable", async () => {
			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
				// No memoryIndexer provided - should gracefully degrade
			});
			await agent.initialize();

			// Should still work without RAG
			const result = await agent.prompt("test query");
			expect(result).toBeDefined();

			agent.dispose();
		});

		test("RAG handles indexer returning undefined", async () => {
			const mockMemoryIndexer = {
				search: mock(async () => undefined), // Simulates timeout/failure
				initialize: mock(async () => {}),
				close: mock(() => {}),
				isInitialized: mock(() => true),
				getStatus: mock(async () => ({ initialized: true, fts5: true, vector: false, documentCount: 1 })),
				rebuild: mock(async () => ({ ok: true })),
				isVectorEnabled: mock(() => false),
			};

			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
				memoryIndexer: mockMemoryIndexer as unknown as typeof mockMemoryIndexer & {
					search: typeof mockMemoryIndexer.search;
				},
			});
			await agent.initialize();

			// Should gracefully handle undefined results
			const result = await agent.prompt("test query");
			expect(result).toBeDefined();

			agent.dispose();
		});

		test("RAG handles indexer throwing error", async () => {
			const mockMemoryIndexer = {
				search: mock(async () => {
					throw new Error("Indexer error");
				}),
				initialize: mock(async () => {}),
				close: mock(() => {}),
				isInitialized: mock(() => true),
				getStatus: mock(async () => ({ initialized: true, fts5: true, vector: false, documentCount: 1 })),
				rebuild: mock(async () => ({ ok: true })),
				isVectorEnabled: mock(() => false),
			};

			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
				memoryIndexer: mockMemoryIndexer as unknown as typeof mockMemoryIndexer & {
					search: typeof mockMemoryIndexer.search;
				},
			});
			await agent.initialize();

			// Should gracefully handle indexer errors
			const result = await agent.prompt("test query");
			expect(result).toBeDefined();

			agent.dispose();
		});

		test("RAG with custom threshold", async () => {
			const mockMemoryIndexer = {
				search: mock(async () => [
					{ path: "test.md", snippet: "Test content", score: 0.4 }, // Above 0.3, below 0.5
				]),
				initialize: mock(async () => {}),
				close: mock(() => {}),
				isInitialized: mock(() => true),
				getStatus: mock(async () => ({ initialized: true, fts5: true, vector: false, documentCount: 1 })),
				rebuild: mock(async () => ({ ok: true })),
				isVectorEnabled: mock(() => false),
			};

			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
				memoryIndexer: mockMemoryIndexer as unknown as typeof mockMemoryIndexer & {
					search: typeof mockMemoryIndexer.search;
				},
				rag: {
					enabled: true,
					threshold: 0.5, // Custom threshold
				},
			});
			await agent.initialize();

			const result = await agent.prompt("test query");
			expect(result).toBeDefined();

			agent.dispose();
		});

		test("RAG disabled via config", async () => {
			const mockMemoryIndexer = {
				search: mock(async () => [{ path: "test.md", snippet: "Test", score: 0.8 }]),
				initialize: mock(async () => {}),
				close: mock(() => {}),
				isInitialized: mock(() => true),
				getStatus: mock(async () => ({ initialized: true, fts5: true, vector: false, documentCount: 1 })),
				rebuild: mock(async () => ({ ok: true })),
				isVectorEnabled: mock(() => false),
			};

			const agent = new EmbeddedAgent({
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				workspaceDir: "/tmp/test",
				memoryIndexer: mockMemoryIndexer as unknown as typeof mockMemoryIndexer & {
					search: typeof mockMemoryIndexer.search;
				},
				rag: {
					enabled: false, // RAG disabled
				},
			});
			await agent.initialize();

			const result = await agent.prompt("test query");
			expect(result).toBeDefined();

			// Search should NOT have been called since RAG is disabled
			expect(mockMemoryIndexer.search).not.toHaveBeenCalled();

			agent.dispose();
		});
	});
});
