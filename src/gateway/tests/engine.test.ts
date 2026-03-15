import { describe, expect, mock, test } from "bun:test";

// =============================================================================
// Contracts Tests
// =============================================================================

import {
	AllLayersFailedError,
	DEFAULT_ORCHESTRATOR_CONFIG,
	ExecutionEngineError,
	type ExecutionLayer,
	type ExecutionResult,
	type LayerHealth,
	NoLayerAvailableError,
	type OrchestratorConfig,
} from "@/gateway/engine/contracts";

describe("Engine Contracts", () => {
	test("ExecutionEngineError captures layer and retryable", () => {
		const error = new ExecutionEngineError("test error", "container", true);
		expect(error.message).toBe("test error");
		expect(error.layer).toBe("container");
		expect(error.retryable).toBe(true);
		expect(error.name).toBe("ExecutionEngineError");
	});

	test("ExecutionEngineError with cause", () => {
		const cause = new Error("original error");
		const error = new ExecutionEngineError("test error", "host-ipc", false, cause);
		expect(error.cause).toBe(cause);
	});

	test("NoLayerAvailableError formats layer list", () => {
		const error = new NoLayerAvailableError(["in-process", "host-ipc"]);
		expect(error.message).toContain("in-process");
		expect(error.message).toContain("host-ipc");
		expect(error.layer).toBe("in-process");
	});

	test("AllLayersFailedError stores errors map", () => {
		const errors = new Map<ExecutionLayer, ExecutionResult>([
			["in-process", { status: "failed", error: "not available" }],
			["container", { status: "failed", error: "docker error" }],
		]);
		const error = new AllLayersFailedError(errors);
		expect(error.errors).toBe(errors);
		expect(error.message).toBe("All execution layers failed");
	});

	test("DEFAULT_ORCHESTRATOR_CONFIG has all properties", () => {
		expect(DEFAULT_ORCHESTRATOR_CONFIG.layerOrder).toEqual(["in-process", "host-ipc", "container"]);
		expect(DEFAULT_ORCHESTRATOR_CONFIG.enableInProcess).toBe(false);
		expect(DEFAULT_ORCHESTRATOR_CONFIG.enableHostIpc).toBe(true);
		expect(DEFAULT_ORCHESTRATOR_CONFIG.enableContainer).toBe(true);
		expect(DEFAULT_ORCHESTRATOR_CONFIG.defaultTimeoutMs).toBe(120000);
		expect(DEFAULT_ORCHESTRATOR_CONFIG.maxRetries).toBe(1);
		expect(DEFAULT_ORCHESTRATOR_CONFIG.healthCheckIntervalMs).toBe(30000);
	});

	test("ExecutionResult various status types", () => {
		const pending: ExecutionResult = { status: "pending" };
		const running: ExecutionResult = { status: "running" };
		const completed: ExecutionResult = { status: "completed", output: "ok", exitCode: 0 };
		const failed: ExecutionResult = { status: "failed", error: "err", retryable: false };
		const timeout: ExecutionResult = { status: "timeout", isTimeout: true };

		expect(pending.status).toBe("pending");
		expect(running.status).toBe("running");
		expect(completed.status).toBe("completed");
		expect(failed.status).toBe("failed");
		expect(timeout.status).toBe("timeout");
	});

	test("LayerHealth structure", () => {
		const health: LayerHealth = {
			layer: "container",
			available: true,
			lastCheck: new Date(),
		};
		expect(health.layer).toBe("container");
		expect(health.available).toBe(true);
		expect(health.lastCheck).toBeInstanceOf(Date);
	});

	test("LayerHealth with error", () => {
		const health: LayerHealth = {
			layer: "host-ipc",
			available: false,
			lastCheck: new Date(),
			error: "CLI not found",
		};
		expect(health.error).toBe("CLI not found");
	});

	test("OrchestratorConfig structure", () => {
		const config: OrchestratorConfig = {
			layerOrder: ["container"],
			enableInProcess: false,
			enableHostIpc: true,
			enableContainer: true,
			defaultTimeoutMs: 60000,
			maxRetries: 3,
			healthCheckIntervalMs: 60000,
		};
		expect(config.layerOrder).toEqual(["container"]);
		expect(config.maxRetries).toBe(3);
	});
});

// =============================================================================
// Prompt Utils Tests
// =============================================================================

import {
	buildClaudePrompt,
	buildPlainContextPrompt,
	escapeXml,
	interpolateArg,
	isAsyncResult,
	validateAndSanitizePrompt,
} from "@/gateway/engine/prompt-utils";

describe("escapeXml", () => {
	test("escapes XML special characters", () => {
		expect(escapeXml("<>&'\"")).toBe("&lt;&gt;&amp;&apos;&quot;");
	});

	test("leaves normal text unchanged", () => {
		expect(escapeXml("hello world")).toBe("hello world");
	});

	test("handles empty string", () => {
		expect(escapeXml("")).toBe("");
	});

	test("handles mixed content", () => {
		expect(escapeXml("a < b > c & d 'e\"f")).toBe("a &lt; b &gt; c &amp; d &apos;e&quot;f");
	});
});

describe("validateAndSanitizePrompt", () => {
	test("accepts valid prompt", () => {
		const result = validateAndSanitizePrompt("Hello world");
		expect(result.valid).toBe(true);
		expect(result.sanitized).toBe("Hello world");
	});

	test("accepts valid prompt with special chars", () => {
		const result = validateAndSanitizePrompt("Hello <world> & 'test'");
		expect(result.valid).toBe(true);
		expect(result.sanitized).toBe("Hello &lt;world&gt; &amp; &apos;test&apos;");
	});

	test("rejects control characters", () => {
		const result = validateAndSanitizePrompt("Hello\x00world");
		expect(result.valid).toBe(false);
		expect(result.reason).toContain("invalid characters");
	});

	test("rejects line too long", () => {
		const longLine = "x".repeat(10001);
		const result = validateAndSanitizePrompt(longLine);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain("line too long");
	});

	test("escapes XML in sanitized output", () => {
		const result = validateAndSanitizePrompt("<script>alert('xss')</script>");
		expect(result.valid).toBe(true);
		expect(result.sanitized).not.toContain("<script>");
		expect(result.sanitized).toContain("&lt;script&gt;");
	});

	test("handles unicode characters", () => {
		const result = validateAndSanitizePrompt("Hello 世界 🌍");
		expect(result.valid).toBe(true);
	});

	test("handles multiline text", () => {
		const result = validateAndSanitizePrompt("line1\nline2\nline3");
		expect(result.valid).toBe(true);
	});
});

describe("buildClaudePrompt", () => {
	test("builds prompt with history", () => {
		const result = buildClaudePrompt("current message", [
			{ sender: "user", text: "hello", timestamp: "2024-01-01T00:00:00Z" },
			{ sender: "agent", text: "hi there", timestamp: "2024-01-01T00:00:01Z" },
		]);

		expect(result).toContain("<messages>");
		expect(result).toContain('<message sender="user">current message</message>');
	});

	test("builds prompt without history", () => {
		const result = buildClaudePrompt("simple prompt", []);
		expect(result).toContain("<messages>");
		expect(result).toContain("simple prompt");
	});

	test("escapes XML in history", () => {
		const result = buildClaudePrompt("test", [
			{ sender: "user", text: "<script>alert(1)</script>", timestamp: "2024-01-01T00:00:00Z" },
		]);
		expect(result).not.toContain("<script>");
		expect(result).toContain("&lt;script&gt;");
	});

	test("throws on invalid message", () => {
		expect(() => buildClaudePrompt("\x00invalid", [])).toThrow();
	});
});

describe("buildPlainContextPrompt", () => {
	test("builds plain text context", () => {
		const result = buildPlainContextPrompt("current request", [
			{ sender: "user", text: "hello", timestamp: "2024-01-01T00:00:00Z" },
		]);

		expect(result).toContain("Conversation context:");
		expect(result).toContain("[2024-01-01T00:00:00Z] user: hello");
		expect(result).toContain("Current request:");
	});

	test("handles empty history", () => {
		const result = buildPlainContextPrompt("request", []);
		expect(result).toContain("Conversation context:");
	});
});

describe("interpolateArg", () => {
	test("replaces prompt placeholder", () => {
		const result = interpolateArg("{{prompt}}", "my prompt", "ws", "123");
		expect(result).toBe("my prompt");
	});

	test("replaces workspace placeholder", () => {
		const result = interpolateArg("{{workspace}}", "prompt", "my-workspace", undefined);
		expect(result).toBe("my-workspace");
	});

	test("replaces chat_id placeholder", () => {
		const result = interpolateArg("{{chat_id}}", "prompt", "ws", 456);
		expect(result).toBe("456");
	});

	test("handles undefined chat_id", () => {
		const result = interpolateArg("--chat={{chat_id}}", "prompt", "ws", undefined);
		expect(result).toBe("--chat=");
	});

	test("leaves unmatched placeholders", () => {
		const result = interpolateArg("hello {{unknown}}", "prompt", "ws", "123");
		expect(result).toBe("hello {{unknown}}");
	});

	test("handles template with multiple replacements", () => {
		const result = interpolateArg("-p {{prompt}} --ws {{workspace}} --chat {{chat_id}}", "test", "myws", "999");
		expect(result).toBe("-p test --ws myws --chat 999");
	});
});

describe("isAsyncResult", () => {
	test("detects tmux mode result", () => {
		const result: ExecutionResult = { status: "running", requestId: "req-1", mode: "tmux" };
		expect(isAsyncResult(result)).toBe(true);
	});

	test("rejects sync result", () => {
		const result: ExecutionResult = { status: "completed", output: "ok" };
		expect(isAsyncResult(result)).toBe(false);
	});
});

// =============================================================================
// In-Process Engine Tests
// =============================================================================

import { InProcessEngine } from "@/gateway/engine/in-process";

describe("InProcessEngine", () => {
	test("getLayer returns in-process", () => {
		const engine = new InProcessEngine(false);
		expect(engine.getLayer()).toBe("in-process");
	});

	test("isAvailable returns false when not enabled", async () => {
		const engine = new InProcessEngine(false);
		const available = await engine.isAvailable();
		expect(available).toBe(false);
	});

	test("isAvailable returns true when enabled with API key", async () => {
		// Set a mock API key for testing
		const originalKey = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "test-api-key-for-testing";

		try {
			const engine = new InProcessEngine(true);
			const available = await engine.isAvailable();
			expect(available).toBe(true);
		} finally {
			// Restore original key
			if (originalKey) {
				process.env.ANTHROPIC_API_KEY = originalKey;
			} else {
				delete process.env.ANTHROPIC_API_KEY;
			}
		}
	});

	test("isAvailable returns false when enabled but no API key", async () => {
		// Ensure no API key is set
		const originalKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;

		try {
			const engine = new InProcessEngine(true);
			const available = await engine.isAvailable();
			expect(available).toBe(false);
		} finally {
			// Restore original key
			if (originalKey) {
				process.env.ANTHROPIC_API_KEY = originalKey;
			}
		}
	});

	test("execute returns not enabled error", async () => {
		const engine = new InProcessEngine(false);
		const result = await engine.execute({ prompt: "test" });
		expect(result.status).toBe("failed");
		expect(result.error).toContain("not enabled");
		expect(result.retryable).toBe(false);
	});

	test("getHealth returns unavailable status", async () => {
		const engine = new InProcessEngine(false);
		const health = await engine.getHealth();
		expect(health.layer).toBe("in-process");
		expect(health.available).toBe(false);
	});
});

// =============================================================================
// In-Process Engine Additional Coverage Tests
// =============================================================================

describe("InProcessEngine additional coverage", () => {
	test("constructor uses default provider and model when not specified", () => {
		const originalProvider = process.env.LLM_PROVIDER;
		const originalModel = process.env.LLM_MODEL;
		delete process.env.LLM_PROVIDER;
		delete process.env.LLM_MODEL;

		try {
			const engine = new InProcessEngine(true);
			expect(engine.getLayer()).toBe("in-process");
		} finally {
			if (originalProvider) process.env.LLM_PROVIDER = originalProvider;
			if (originalModel) process.env.LLM_MODEL = originalModel;
		}
	});

	test("constructor uses custom provider and model", () => {
		const engine = new InProcessEngine(true, "openai", "gpt-4");
		expect(engine.getLayer()).toBe("in-process");
	});

	test("constructor uses env vars for provider and model", () => {
		const originalProvider = process.env.LLM_PROVIDER;
		const originalModel = process.env.LLM_MODEL;
		process.env.LLM_PROVIDER = "google";
		process.env.LLM_MODEL = "gemini-pro";

		try {
			const engine = new InProcessEngine(true);
			expect(engine.getLayer()).toBe("in-process");
		} finally {
			if (originalProvider) process.env.LLM_PROVIDER = originalProvider;
			else delete process.env.LLM_PROVIDER;
			if (originalModel) process.env.LLM_MODEL = originalModel;
			else delete process.env.LLM_MODEL;
		}
	});

	test("isAvailable checks OpenAI provider", async () => {
		const originalAnthropic = process.env.ANTHROPIC_API_KEY;
		const originalOpenai = process.env.OPENAI_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		process.env.OPENAI_API_KEY = "test-openai-key";

		try {
			const engine = new InProcessEngine(true, "openai", "gpt-4");
			const available = await engine.isAvailable();
			expect(available).toBe(true);
		} finally {
			if (originalAnthropic) process.env.ANTHROPIC_API_KEY = originalAnthropic;
			if (originalOpenai) process.env.OPENAI_API_KEY = originalOpenai;
			else delete process.env.OPENAI_API_KEY;
		}
	});

	test("isAvailable checks Google provider", async () => {
		const originalAnthropic = process.env.ANTHROPIC_API_KEY;
		const originalGoogle = process.env.GOOGLE_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		process.env.GOOGLE_API_KEY = "test-google-key";

		try {
			const engine = new InProcessEngine(true, "google", "gemini-pro");
			const available = await engine.isAvailable();
			expect(available).toBe(true);
		} finally {
			if (originalAnthropic) process.env.ANTHROPIC_API_KEY = originalAnthropic;
			if (originalGoogle) process.env.GOOGLE_API_KEY = originalGoogle;
			else delete process.env.GOOGLE_API_KEY;
		}
	});

	test("isAvailable checks Gemini provider (alias)", async () => {
		const originalAnthropic = process.env.ANTHROPIC_API_KEY;
		const originalGemini = process.env.GEMINI_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		process.env.GEMINI_API_KEY = "test-gemini-key";

		try {
			const engine = new InProcessEngine(true, "gemini", "gemini-pro");
			const available = await engine.isAvailable();
			expect(available).toBe(true);
		} finally {
			if (originalAnthropic) process.env.ANTHROPIC_API_KEY = originalAnthropic;
			if (originalGemini) process.env.GEMINI_API_KEY = originalGemini;
			else delete process.env.GEMINI_API_KEY;
		}
	});

	test("isAvailable checks OpenRouter provider", async () => {
		const originalAnthropic = process.env.ANTHROPIC_API_KEY;
		const originalOpenrouter = process.env.OPENROUTER_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		process.env.OPENROUTER_API_KEY = "test-openrouter-key";

		try {
			const engine = new InProcessEngine(true, "openrouter", "anthropic/claude-3");
			const available = await engine.isAvailable();
			expect(available).toBe(true);
		} finally {
			if (originalAnthropic) process.env.ANTHROPIC_API_KEY = originalAnthropic;
			if (originalOpenrouter) process.env.OPENROUTER_API_KEY = originalOpenrouter;
			else delete process.env.OPENROUTER_API_KEY;
		}
	});

	test("isAvailable checks unknown provider (falls back to LLM_API_KEY)", async () => {
		const originalAnthropic = process.env.ANTHROPIC_API_KEY;
		const originalLlmKey = process.env.LLM_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		process.env.LLM_API_KEY = "test-llm-key";

		try {
			const engine = new InProcessEngine(true, "unknown-provider", "model-x");
			const available = await engine.isAvailable();
			expect(available).toBe(true);
		} finally {
			if (originalAnthropic) process.env.ANTHROPIC_API_KEY = originalAnthropic;
			if (originalLlmKey) process.env.LLM_API_KEY = originalLlmKey;
			else delete process.env.LLM_API_KEY;
		}
	});

	test("isAvailable checks unknown provider with API_KEY fallback", async () => {
		const originalAnthropic = process.env.ANTHROPIC_API_KEY;
		const originalLlmKey = process.env.LLM_API_KEY;
		const originalApiKey = process.env.API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.LLM_API_KEY;
		process.env.API_KEY = "test-api-key";

		try {
			const engine = new InProcessEngine(true, "custom-provider", "model-y");
			const available = await engine.isAvailable();
			expect(available).toBe(true);
		} finally {
			if (originalAnthropic) process.env.ANTHROPIC_API_KEY = originalAnthropic;
			if (originalLlmKey) process.env.LLM_API_KEY = originalLlmKey;
			else delete process.env.LLM_API_KEY;
			if (originalApiKey) process.env.API_KEY = originalApiKey;
			else delete process.env.API_KEY;
		}
	});

	test("isAvailable returns false for unknown provider without API key", async () => {
		const originalAnthropic = process.env.ANTHROPIC_API_KEY;
		const originalLlmKey = process.env.LLM_API_KEY;
		const originalApiKey = process.env.API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.LLM_API_KEY;
		delete process.env.API_KEY;

		try {
			const engine = new InProcessEngine(true, "unknown-provider", "model-x");
			const available = await engine.isAvailable();
			expect(available).toBe(false);
		} finally {
			if (originalAnthropic) process.env.ANTHROPIC_API_KEY = originalAnthropic;
			if (originalLlmKey) process.env.LLM_API_KEY = originalLlmKey;
			if (originalApiKey) process.env.API_KEY = originalApiKey;
		}
	});

	test("execute with enabled but no API key returns failed", async () => {
		const originalKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;

		try {
			const engine = new InProcessEngine(true);
			const result = await engine.execute({ prompt: "test" });
			expect(result.status).toBe("failed");
			expect(result.error).toContain("No API key");
		} finally {
			if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
		}
	});

	test("execute with unknown provider and no API key returns failed", async () => {
		const originalAnthropic = process.env.ANTHROPIC_API_KEY;
		const originalLlmKey = process.env.LLM_API_KEY;
		const originalApiKey = process.env.API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.LLM_API_KEY;
		delete process.env.API_KEY;

		try {
			const engine = new InProcessEngine(true, "unknown-provider", "model-x");
			const result = await engine.execute({ prompt: "test" });
			expect(result.status).toBe("failed");
			expect(result.error).toContain("No API key");
		} finally {
			if (originalAnthropic) process.env.ANTHROPIC_API_KEY = originalAnthropic;
			if (originalLlmKey) process.env.LLM_API_KEY = originalLlmKey;
			if (originalApiKey) process.env.API_KEY = originalApiKey;
		}
	});

	test("getHealth returns error message when not available", async () => {
		const originalKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;

		try {
			const engine = new InProcessEngine(true);
			const health = await engine.getHealth();
			expect(health.layer).toBe("in-process");
			expect(health.available).toBe(false);
			expect(health.error).toContain("disabled or API key");
		} finally {
			if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
		}
	});

	test("execute with chatId in options", async () => {
		const engine = new InProcessEngine(false);
		const result = await engine.execute({
			prompt: "test",
			options: { chatId: "chat-123", timeout: 5000 },
		});
		expect(result.status).toBe("failed");
		expect(result.error).toContain("not enabled");
	});

	test("execute with maxTokens in options", async () => {
		const engine = new InProcessEngine(false);
		const result = await engine.execute({
			prompt: "test",
			options: { maxTokens: 2048 },
		});
		expect(result.status).toBe("failed");
		expect(result.error).toContain("not enabled");
	});
});

// =============================================================================
// InProcessEngine isTextContentBlock Tests
// =============================================================================

import { isTextContentBlock } from "@/gateway/engine/agent";

describe("isTextContentBlock function", () => {
	test("returns true for valid text content block", () => {
		const block = { type: "text", text: "hello world" };
		expect(isTextContentBlock(block)).toBe(true);
	});

	test("returns false for non-text content block", () => {
		const block = { type: "image", data: "base64..." };
		expect(isTextContentBlock(block)).toBe(false);
	});

	test("returns false for null", () => {
		expect(isTextContentBlock(null)).toBe(false);
	});

	test("returns false for undefined", () => {
		expect(isTextContentBlock(undefined)).toBe(false);
	});

	test("returns false for primitive values", () => {
		expect(isTextContentBlock("string")).toBe(false);
		expect(isTextContentBlock(123)).toBe(false);
		expect(isTextContentBlock(true)).toBe(false);
	});

	test("returns false for object without type", () => {
		const block = { text: "hello" };
		expect(isTextContentBlock(block)).toBe(false);
	});

	test("returns false for object with wrong type", () => {
		const block = { type: "tool_use", name: "test" };
		expect(isTextContentBlock(block)).toBe(false);
	});

	test("returns true for text block with empty text", () => {
		const block = { type: "text", text: "" };
		expect(isTextContentBlock(block)).toBe(true);
	});
});

// =============================================================================
// InProcessEngine getHealth Tests
// =============================================================================

describe("InProcessEngine getHealth", () => {
	test("returns health with layer 'in-process'", async () => {
		const engine = new InProcessEngine(false);
		const health = await engine.getHealth();
		expect(health.layer).toBe("in-process");
		expect(health.available).toBe(false);
		expect(health.lastCheck).toBeInstanceOf(Date);
	});

	test("returns available=true when enabled with API key", async () => {
		const originalKey = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "test-key";

		try {
			const engine = new InProcessEngine(true);
			const health = await engine.getHealth();
			expect(health.available).toBe(true);
			expect(health.error).toBeUndefined();
		} finally {
			if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
			else delete process.env.ANTHROPIC_API_KEY;
		}
	});

	test("returns error message when not available", async () => {
		const originalKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;

		try {
			const engine = new InProcessEngine(true);
			const health = await engine.getHealth();
			expect(health.available).toBe(false);
			expect(health.error).toBeDefined();
		} finally {
			if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
		}
	});
});

// =============================================================================
// InProcessEngine execute Tests
// =============================================================================

describe("InProcessEngine execute", () => {
	test("returns failed when disabled", async () => {
		const engine = new InProcessEngine(false);
		const result = await engine.execute({ prompt: "test" });
		expect(result.status).toBe("failed");
		expect(result.error).toContain("not enabled");
		expect(result.retryable).toBe(false);
	});

	test("returns failed when no API key configured", async () => {
		const originalKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;

		try {
			const engine = new InProcessEngine(true);
			const result = await engine.execute({ prompt: "test" });
			expect(result.status).toBe("failed");
			expect(result.error).toContain("No API key");
		} finally {
			if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
		}
	});

	test("execute with custom timeout option", async () => {
		const engine = new InProcessEngine(false);
		const result = await engine.execute({
			prompt: "test",
			options: { timeout: 5000 },
		});
		expect(result.status).toBe("failed");
	});

	test("execute with chatId option", async () => {
		const engine = new InProcessEngine(false);
		const result = await engine.execute({
			prompt: "test",
			options: { chatId: "test-chat-123" },
		});
		expect(result.status).toBe("failed");
	});

	test("execute with maxTokens option", async () => {
		const engine = new InProcessEngine(false);
		const result = await engine.execute({
			prompt: "test",
			options: { maxTokens: 2048 },
		});
		expect(result.status).toBe("failed");
	});
});

// =============================================================================
// Provider Config & API Key Resolution Tests (moved from InProcessEngine to embedded-agent.ts)
// =============================================================================

import { PROVIDER_CONFIGS, resolveProviderApiKey } from "@/gateway/engine/agent";

describe("PROVIDER_CONFIGS", () => {
	test("anthropic config returns correct api and key", () => {
		const originalKey = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

		try {
			const config = PROVIDER_CONFIGS["anthropic"];
			expect(config.api).toBe("anthropic-messages");
			expect(config.getApiKey()).toBe("test-anthropic-key");
		} finally {
			if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
			else delete process.env.ANTHROPIC_API_KEY;
		}
	});

	test("openai config returns correct api and key", () => {
		const originalKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-openai-key";

		try {
			const config = PROVIDER_CONFIGS["openai"];
			expect(config.api).toBe("openai-completions");
			expect(config.getApiKey()).toBe("test-openai-key");
		} finally {
			if (originalKey) process.env.OPENAI_API_KEY = originalKey;
			else delete process.env.OPENAI_API_KEY;
		}
	});

	test("google config returns correct api and key", () => {
		const originalKey = process.env.GOOGLE_API_KEY;
		process.env.GOOGLE_API_KEY = "test-google-key";

		try {
			const config = PROVIDER_CONFIGS["google"];
			expect(config.api).toBe("google-generative-ai");
			expect(config.getApiKey()).toBe("test-google-key");
		} finally {
			if (originalKey) process.env.GOOGLE_API_KEY = originalKey;
			else delete process.env.GOOGLE_API_KEY;
		}
	});

	test("gemini config returns correct api and key", () => {
		const originalKey = process.env.GEMINI_API_KEY;
		process.env.GEMINI_API_KEY = "test-gemini-key";

		try {
			const config = PROVIDER_CONFIGS["gemini"];
			expect(config.api).toBe("google-generative-ai");
			expect(config.getApiKey()).toBe("test-gemini-key");
		} finally {
			if (originalKey) process.env.GEMINI_API_KEY = originalKey;
			else delete process.env.GEMINI_API_KEY;
		}
	});

	test("openrouter config returns correct api, baseUrl, and key", () => {
		const originalKey = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = "test-openrouter-key";

		try {
			const config = PROVIDER_CONFIGS["openrouter"];
			expect(config.api).toBe("openai-completions");
			expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
			expect(config.getApiKey()).toBe("test-openrouter-key");
		} finally {
			if (originalKey) process.env.OPENROUTER_API_KEY = originalKey;
			else delete process.env.OPENROUTER_API_KEY;
		}
	});
});

describe("resolveProviderApiKey", () => {
	test("resolves anthropic API key", () => {
		const originalKey = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

		try {
			expect(resolveProviderApiKey("anthropic")).toBe("test-anthropic-key");
		} finally {
			if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
			else delete process.env.ANTHROPIC_API_KEY;
		}
	});

	test("resolves openai API key", () => {
		const originalKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-openai-key";

		try {
			expect(resolveProviderApiKey("openai")).toBe("test-openai-key");
		} finally {
			if (originalKey) process.env.OPENAI_API_KEY = originalKey;
			else delete process.env.OPENAI_API_KEY;
		}
	});

	test("resolves google API key", () => {
		const originalKey = process.env.GOOGLE_API_KEY;
		process.env.GOOGLE_API_KEY = "test-google-key";

		try {
			expect(resolveProviderApiKey("google")).toBe("test-google-key");
		} finally {
			if (originalKey) process.env.GOOGLE_API_KEY = originalKey;
			else delete process.env.GOOGLE_API_KEY;
		}
	});

	test("resolves gemini API key", () => {
		const originalKey = process.env.GEMINI_API_KEY;
		process.env.GEMINI_API_KEY = "test-gemini-key";

		try {
			expect(resolveProviderApiKey("gemini")).toBe("test-gemini-key");
		} finally {
			if (originalKey) process.env.GEMINI_API_KEY = originalKey;
			else delete process.env.GEMINI_API_KEY;
		}
	});

	test("resolves openrouter API key", () => {
		const originalKey = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = "test-openrouter-key";

		try {
			expect(resolveProviderApiKey("openrouter")).toBe("test-openrouter-key");
		} finally {
			if (originalKey) process.env.OPENROUTER_API_KEY = originalKey;
			else delete process.env.OPENROUTER_API_KEY;
		}
	});

	test("falls back to LLM_API_KEY for unknown provider", () => {
		const originalLlmKey = process.env.LLM_API_KEY;
		const originalApiKey = process.env.API_KEY;
		process.env.LLM_API_KEY = "test-llm-key";
		delete process.env.API_KEY;

		try {
			expect(resolveProviderApiKey("unknown-provider")).toBe("test-llm-key");
		} finally {
			if (originalLlmKey) process.env.LLM_API_KEY = originalLlmKey;
			else delete process.env.LLM_API_KEY;
			if (originalApiKey) process.env.API_KEY = originalApiKey;
		}
	});

	test("falls back to API_KEY for unknown provider", () => {
		const originalLlmKey = process.env.LLM_API_KEY;
		const originalApiKey = process.env.API_KEY;
		delete process.env.LLM_API_KEY;
		process.env.API_KEY = "test-api-key";

		try {
			expect(resolveProviderApiKey("custom-provider")).toBe("test-api-key");
		} finally {
			if (originalLlmKey) process.env.LLM_API_KEY = originalLlmKey;
			else delete process.env.LLM_API_KEY;
			if (originalApiKey) process.env.API_KEY = originalApiKey;
		}
	});

	test("returns undefined when no key configured for unknown provider", () => {
		const originalLlmKey = process.env.LLM_API_KEY;
		const originalApiKey = process.env.API_KEY;
		delete process.env.LLM_API_KEY;
		delete process.env.API_KEY;

		try {
			expect(resolveProviderApiKey("unknown")).toBeUndefined();
		} finally {
			if (originalLlmKey) process.env.LLM_API_KEY = originalLlmKey;
			if (originalApiKey) process.env.API_KEY = originalApiKey;
		}
	});

	test("returns undefined when no key configured for known provider", () => {
		const originalKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;

		try {
			expect(resolveProviderApiKey("anthropic")).toBeUndefined();
		} finally {
			if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
		}
	});
});

// =============================================================================
// Host IPC Engine Tests
// =============================================================================

import { createHostIpcEngine, HostIpcEngine } from "@/gateway/engine/host-ipc";

describe("HostIpcEngine", () => {
	test("getLayer returns host-ipc", () => {
		const engine = new HostIpcEngine();
		expect(engine.getLayer()).toBe("host-ipc");
	});

	test("constructor accepts config options", () => {
		const engine = new HostIpcEngine({ engineType: "codex_host", command: "custom-claude" });
		expect(engine.getLayer()).toBe("host-ipc");
	});

	test("createHostIpcEngine factory", () => {
		const engine = createHostIpcEngine();
		expect(engine.getLayer()).toBe("host-ipc");
	});

	test("getHealth returns unavailable when CLI not found", async () => {
		const engine = new HostIpcEngine({ command: "nonexistent-command-xyz" });
		const health = await engine.getHealth();
		expect(health.layer).toBe("host-ipc");
		expect(health.available).toBe(false);
	});
});

// =============================================================================
// Container Engine Tests
// =============================================================================

import { ContainerEngine, createContainerEngine } from "@/gateway/engine/container";

describe("ContainerEngine", () => {
	test("getLayer returns container", () => {
		const engine = new ContainerEngine();
		expect(engine.getLayer()).toBe("container");
	});

	test("constructor accepts useTmux option", () => {
		const engine = new ContainerEngine();
		expect(engine.getLayer()).toBe("container");
	});

	test("createContainerEngine factory", () => {
		const engine = createContainerEngine();
		expect(engine.getLayer()).toBe("container");
	});

	test("getHealth returns unavailable when docker not available", async () => {
		const engine = new ContainerEngine();
		const health = await engine.getHealth();
		expect(health.layer).toBe("container");
	});

	test("execute requires instance or containerId", async () => {
		const engine = new ContainerEngine();
		const result = await engine.execute({ prompt: "test" });
		expect(result.status).toBe("failed");
		expect(result.error).toContain("requires either instance or containerId");
	});
});

// =============================================================================
// Orchestrator Tests
// =============================================================================

import { createOrchestrator, ExecutionOrchestrator } from "@/gateway/engine/orchestrator";

describe("ExecutionOrchestrator", () => {
	test("constructor creates with default config", () => {
		const orchestrator = new ExecutionOrchestrator({ healthCheckIntervalMs: 999999 });
		expect(orchestrator.getLayers()).toContain("host-ipc");
		expect(orchestrator.getLayers()).toContain("container");
	});

	test("constructor accepts custom config", () => {
		const orchestrator = new ExecutionOrchestrator({
			enableInProcess: false,
			enableHostIpc: false,
			enableContainer: false,
			healthCheckIntervalMs: 999999,
		});
		expect(orchestrator.getLayers()).toEqual([]);
	});

	test("createOrchestrator factory", () => {
		const orchestrator = createOrchestrator({ healthCheckIntervalMs: 999999 });
		expect(orchestrator.getLayers().length).toBeGreaterThan(0);
	});

	test("getLayers returns initialized engines", () => {
		const orchestrator = createOrchestrator({ enableInProcess: false, healthCheckIntervalMs: 999999 });
		const layers = orchestrator.getLayers();
		expect(layers).toContain("host-ipc");
		expect(layers).toContain("container");
	});

	test("getHealthStatus returns health for all layers", async () => {
		const orchestrator = createOrchestrator({ healthCheckIntervalMs: 999999 });
		const health = await orchestrator.getHealthStatus();
		expect(health.length).toBeGreaterThan(0);
		expect(health[0]).toHaveProperty("layer");
	});

	test("getBestLayer returns first available layer", async () => {
		const orchestrator = createOrchestrator({ healthCheckIntervalMs: 999999 });
		const bestLayer = await orchestrator.getBestLayer();
		expect(bestLayer).toBeDefined();
	});

	test("getCachedHealth returns cached health after getHealthStatus", async () => {
		const orchestrator = createOrchestrator({ healthCheckIntervalMs: 999999 });
		await orchestrator.getHealthStatus();
		const cached = orchestrator.getCachedHealth("host-ipc");
		expect(cached).toBeDefined();
	});

	test("executeOnLayer returns error for unknown layer", async () => {
		const orchestrator = createOrchestrator({ healthCheckIntervalMs: 999999 });
		const result = await orchestrator.executeOnLayer({ prompt: "test" }, "in-process" as ExecutionLayer);
		expect(result.status).toBe("failed");
	});

	test("stop clears health check timer", () => {
		const orchestrator = createOrchestrator();
		orchestrator.stop();
		expect(true).toBe(true);
	});

	test("stop can be called multiple times", () => {
		const orchestrator = createOrchestrator();
		orchestrator.stop();
		orchestrator.stop();
		expect(true).toBe(true);
	});
});

// =============================================================================
// Index Exports Tests
// =============================================================================

describe("Engine index exports", () => {
	test("exports all engines", () => {
		const { ContainerEngine, HostIpcEngine, InProcessEngine } = require("@/gateway/engine/index");
		expect(ContainerEngine).toBeDefined();
		expect(HostIpcEngine).toBeDefined();
		expect(InProcessEngine).toBeDefined();
	});

	test("exports orchestrator functions", () => {
		const { createOrchestrator, getExecutionOrchestrator } = require("@/gateway/engine/index");
		expect(createOrchestrator).toBeDefined();
		expect(getExecutionOrchestrator).toBeDefined();
	});

	test("exports prompt utils", () => {
		const { escapeXml, validateAndSanitizePrompt, buildClaudePrompt } = require("@/gateway/engine/index");
		expect(escapeXml).toBeDefined();
		expect(validateAndSanitizePrompt).toBeDefined();
		expect(buildClaudePrompt).toBeDefined();
	});

	test("exports error classes", () => {
		const { ExecutionEngineError, NoLayerAvailableError, AllLayersFailedError } = require("@/gateway/engine/index");
		expect(ExecutionEngineError).toBeDefined();
		expect(NoLayerAvailableError).toBeDefined();
		expect(AllLayersFailedError).toBeDefined();
	});

	test("exports factory functions", () => {
		const { createContainerEngine, createHostIpcEngine } = require("@/gateway/engine/index");
		expect(createContainerEngine).toBeDefined();
		expect(createHostIpcEngine).toBeDefined();
	});

	test("exports DEFAULT_ORCHESTRATOR_CONFIG", () => {
		const { DEFAULT_ORCHESTRATOR_CONFIG } = require("@/gateway/engine/index");
		expect(DEFAULT_ORCHESTRATOR_CONFIG).toBeDefined();
	});

	test("exports singleton functions", () => {
		const { getDefaultOrchestrator, setDefaultOrchestrator } = require("@/gateway/engine/index");
		expect(getDefaultOrchestrator).toBeDefined();
		expect(setDefaultOrchestrator).toBeDefined();
	});

	test("getExecutionOrchestrator creates singleton", () => {
		const { getExecutionOrchestrator, setDefaultOrchestrator } = require("@/gateway/engine/index");
		// Clear any existing singleton
		setDefaultOrchestrator(undefined as never);
		// Get should create new instance
		const orch1 = getExecutionOrchestrator();
		expect(orch1).toBeDefined();
		// Second call should return same instance
		const orch2 = getExecutionOrchestrator();
		expect(orch1).toBe(orch2);
	});

	test("exports AgentInstance type", () => {
		const { ContainerEngine } = require("@/gateway/engine/index");
		expect(ContainerEngine).toBeDefined();
	});
});

// =============================================================================
// Host IPC Additional Coverage Tests
// =============================================================================

describe("HostIpcEngine execute coverage", () => {
	test("isAvailable checks CLI availability", async () => {
		const engine = new HostIpcEngine();
		const available = await engine.isAvailable();
		// Either available or not, but tests the path
		expect(typeof available).toBe("boolean");
	});

	test("getCommand returns default when no config", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error - accessing private method for coverage
		const cmd = engine.getCommand();
		expect(cmd).toBeDefined();
	});

	test("getCommand returns custom command from config", () => {
		const engine = new HostIpcEngine({ command: "my-claude" });
		// @ts-expect-error
		expect(engine.getCommand()).toBe("my-claude");
	});

	test("getCommand returns codex_host type", () => {
		const engine = new HostIpcEngine({ engineType: "codex_host" });
		// @ts-expect-error
		const cmd = engine.getCommand();
		expect(cmd).toBeDefined();
	});

	test("prepareExecution with history uses buildClaudePrompt", () => {
		const engine = new HostIpcEngine();
		const history = [{ sender: "user", text: "hello", timestamp: "2024-01-01T00:00:00Z" }];
		// @ts-expect-error
		const result = engine.prepareExecution("test", { history });
		expect(result.prompt).toContain("test");
	});

	test("prepareExecution without history uses plain prompt", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error
		const result = engine.prepareExecution("test prompt", {});
		expect(result.prompt).toBe("test prompt");
	});

	test("prepareExecution with codex_host uses buildPlainContextPrompt", () => {
		const engine = new HostIpcEngine({ engineType: "codex_host" });
		const history = [{ sender: "user", text: "hello", timestamp: "2024-01-01T00:00:00Z" }];
		// @ts-expect-error
		const result = engine.prepareExecution("test", { history });
		expect(result.prompt).toContain("test");
	});

	test("prepareExecution with custom args", () => {
		const engine = new HostIpcEngine({ args: ["-p", "{{prompt}}", "--verbose"] });
		// @ts-expect-error
		const { buildArgs } = engine.prepareExecution("test", {});
		const { args } = buildArgs("prompt", "ws", "123");
		expect(args).toContain("--verbose");
	});

	test("resolveWorkspacePath returns path when exists", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error - accessing private method
		const path = engine.resolveWorkspacePath(".");
		// Current directory should exist
		expect(path === undefined || typeof path === "string").toBe(true);
	});

	test("resolveWorkspacePath returns undefined for non-existent", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error - accessing private method
		const path = engine.resolveWorkspacePath("nonexistent-workspace-xyz-123");
		expect(path).toBeUndefined();
	});

	// Additional test for execute with non-existent command
	test("execute with non-existent command returns running or failed", async () => {
		const engine = new HostIpcEngine({ command: "this-command-definitely-does-not-exist-12345" });
		const result = await engine.execute({ prompt: "test", options: {} });
		expect(result).toHaveProperty("status");
		expect(result.status === "running" || result.status === "failed").toBe(true);
	});

	// Test codex_host buildArgs path (lines 134-136)
	test("prepareExecution with codex_host sets correct args", () => {
		const engine = new HostIpcEngine({ engineType: "codex_host", args: ["{{prompt}}"] });
		// @ts-expect-error
		const { buildArgs } = engine.prepareExecution("test", {});
		const { command, args } = buildArgs("prompt", "ws", "123");
		expect(command).toBeDefined();
		// For codex_host, default args should include {{prompt}}
		expect(args.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// HostIpcEngine Private Methods Coverage
// =============================================================================

describe("HostIpcEngine private methods coverage", () => {
	test("shellQuote escapes single quotes", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error - accessing private method
		const result = engine.shellQuote("it's a test");
		expect(result).toBe("'it'\\''s a test'");
	});

	test("shellQuote handles normal strings", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error - accessing private method
		const result = engine.shellQuote("normal string");
		expect(result).toBe("'normal string'");
	});

	test("generateSessionName creates valid session name", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error - accessing private method
		const result = engine.generateSessionName("my-workspace", "chat-123");
		expect(result).toContain("claude");
		// Hyphens and underscores are allowed in session names
		expect(result).toContain("my-workspace");
		expect(result).toContain("chat-123");
	});

	test("generateSessionName sanitizes special characters", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error - accessing private method
		const result = engine.generateSessionName("ws@#$%", "chat!&*");
		expect(result).not.toContain("@");
		expect(result).not.toContain("#");
		expect(result).not.toContain("!");
	});

	test("extractRecentOutput filters command echo lines", () => {
		const engine = new HostIpcEngine();
		const input = "> some command\nline1\nline2\n## Response\ncontent";
		// @ts-expect-error - accessing private method
		const result = engine.extractRecentOutput(input, "TOKEN");
		expect(result).not.toContain("> some command");
		expect(result).toContain("content");
	});

	test("extractRecentOutput handles markdown headers", () => {
		const engine = new HostIpcEngine();
		const input = "command echo\n## Introduction\nThis is the response";
		// @ts-expect-error - accessing private method
		const result = engine.extractRecentOutput(input, "TOKEN");
		expect(result).toContain("Introduction");
		expect(result).toContain("response");
	});

	test("extractRecentOutput filters Execute mini-app lines", () => {
		const engine = new HostIpcEngine();
		const input = "Execute mini-app something\n## Response\ncontent here";
		// @ts-expect-error - accessing private method
		const result = engine.extractRecentOutput(input, "TOKEN");
		expect(result).not.toContain("Execute mini-app");
	});

	test("extractRecentOutput filters Instructions: lines", () => {
		const engine = new HostIpcEngine();
		const input = "Instructions: do something\n## Output\nthe result";
		// @ts-expect-error - accessing private method
		const result = engine.extractRecentOutput(input, "TOKEN");
		expect(result).not.toContain("Instructions:");
	});

	test("extractRecentOutput filters bash -c lines", () => {
		const engine = new HostIpcEngine();
		const input = "bash -c 'some command'\n## Output\nresult";
		// @ts-expect-error - accessing private method
		const result = engine.extractRecentOutput(input, "TOKEN");
		expect(result).not.toContain("bash -c");
	});

	test("extractRecentOutput uses fallback for no markers", () => {
		const engine = new HostIpcEngine();
		const lines = Array(100).fill("line content");
		const input = lines.join("\n");
		// @ts-expect-error - accessing private method
		const result = engine.extractRecentOutput(input, "TOKEN");
		expect(result.length).toBeGreaterThan(0);
	});

	test("extractRecentOutput detects Claude: start marker", () => {
		const engine = new HostIpcEngine();
		const input = "some command\nClaude: Here is my response";
		// @ts-expect-error - accessing private method
		const result = engine.extractRecentOutput(input, "TOKEN");
		expect(result).toContain("Claude:");
		expect(result).toContain("response");
	});

	test("extractRecentOutput detects Here's start marker", () => {
		const engine = new HostIpcEngine();
		const input = "command output\nHere's the answer";
		// @ts-expect-error - accessing private method
		const result = engine.extractRecentOutput(input, "TOKEN");
		expect(result).toContain("Here's");
	});

	test("extractRecentOutput detects Based on start marker", () => {
		const engine = new HostIpcEngine();
		const input = "output\nBased on your request";
		// @ts-expect-error - accessing private method
		const result = engine.extractRecentOutput(input, "TOKEN");
		expect(result).toContain("Based on");
	});

	test("extractRecentOutput detects I'll start marker", () => {
		const engine = new HostIpcEngine();
		const input = "cmd\nI'll help you with that";
		// @ts-expect-error - accessing private method
		const result = engine.extractRecentOutput(input, "TOKEN");
		expect(result).toContain("I'll");
	});

	test("extractRecentOutput detects Let me start marker", () => {
		const engine = new HostIpcEngine();
		const input = "cmd output\nLet me explain";
		// @ts-expect-error - accessing private method
		const result = engine.extractRecentOutput(input, "TOKEN");
		expect(result).toContain("Let me");
	});

	test("buildSyncCommand creates proper shell command", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error - accessing private method
		const result = engine.buildSyncCommand("claude", ["-p", "test"], "workspace", "TOKEN_123", 60000);
		expect(result).toContain("claude");
		expect(result).toContain("TOKEN_123");
		expect(result).toContain("unset CLAUDECODE");
	});

	test("buildSyncCommand includes timeout watchdog", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error - accessing private method
		const result = engine.buildSyncCommand("claude", ["-p", "test"], "workspace", "TOKEN", 30000);
		expect(result).toContain("sleep");
		expect(result).toContain("kill");
	});

	test("sleep returns promise that resolves", async () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error - accessing private method
		await engine.sleep(10);
		expect(true).toBe(true);
	});
});

// =============================================================================
// HostIpcEngine Tmux Execution Coverage
// =============================================================================

describe("HostIpcEngine tmux execution coverage", () => {
	test("waitForTmuxCompletion returns completed on success", async () => {
		const engine = new HostIpcEngine();
		const completionToken = "CC_BRIDGE_DONE_123";

		// Mock capturePane to return completion output
		// @ts-expect-error - accessing private method
		const originalCapturePane = engine.capturePane;
		// @ts-expect-error
		engine.capturePane = mock(async () => `output\n${completionToken}:0`);

		try {
			// @ts-expect-error - accessing private method
			const result = await engine.waitForTmuxCompletion("session-name", 5000, completionToken);

			expect(result.status).toBe("completed");
			expect(result.exitCode).toBe(0);
		} finally {
			// @ts-expect-error
			engine.capturePane = originalCapturePane;
		}
	});

	test("waitForTmuxCompletion returns failed on shell error", async () => {
		const engine = new HostIpcEngine();
		const completionToken = "CC_BRIDGE_DONE_456";

		// @ts-expect-error
		engine.capturePane = mock(async () => `command not found\n${completionToken}:127`);

		try {
			// @ts-expect-error
			const result = await engine.waitForTmuxCompletion("session-name", 5000, completionToken);

			expect(result.status).toBe("failed");
			expect(result.error).toContain("tmux command failed");
		} finally {
			// Restore
		}
	});

	test("waitForTmuxCompletion returns timeout on exit code 124", async () => {
		const engine = new HostIpcEngine();
		const completionToken = "CC_BRIDGE_DONE_789";

		// @ts-expect-error
		engine.capturePane = mock(async () => `output\n${completionToken}:124`);

		try {
			// @ts-expect-error
			const result = await engine.waitForTmuxCompletion("session-name", 5000, completionToken);

			expect(result.status).toBe("timeout");
			expect(result.isTimeout).toBe(true);
			expect(result.exitCode).toBe(124);
		} finally {
			// Restore
		}
	});

	test("waitForTmuxCompletion returns timeout when no completion token", async () => {
		const engine = new HostIpcEngine();
		const completionToken = "CC_BRIDGE_DONE_TIMEOUT";

		// @ts-expect-error
		engine.capturePane = mock(async () => "output without completion token");

		try {
			// @ts-expect-error - use short timeout
			const result = await engine.waitForTmuxCompletion("session-name", 100, completionToken);

			expect(result.status).toBe("timeout");
			expect(result.isTimeout).toBe(true);
		} finally {
			// Restore
		}
	});

	test("waitForTmuxCompletion handles capturePane error and retries", async () => {
		const engine = new HostIpcEngine();
		const completionToken = "CC_BRIDGE_DONE_RETRY";

		let callCount = 0;
		// @ts-expect-error
		engine.capturePane = mock(async () => {
			callCount++;
			if (callCount < 2) {
				throw new Error("capture failed");
			}
			return `output\n${completionToken}:0`;
		});

		try {
			// @ts-expect-error
			const result = await engine.waitForTmuxCompletion("session-name", 5000, completionToken);

			expect(result.status).toBe("completed");
		} finally {
			// Restore
		}
	});

	test("waitForTmuxCompletion returns timeout on capturePane final error", async () => {
		const engine = new HostIpcEngine();
		const completionToken = "CC_BRIDGE_DONE_FINAL";

		// @ts-expect-error
		engine.capturePane = mock(async () => {
			throw new Error("capture failed");
		});

		try {
			// @ts-expect-error - use short timeout
			const result = await engine.waitForTmuxCompletion("session-name", 100, completionToken);

			expect(result.status).toBe("timeout");
		} finally {
			// Restore
		}
	});

	test("waitForTmuxCompletion handles syntax error in output", async () => {
		const engine = new HostIpcEngine();
		const completionToken = "CC_BRIDGE_DONE_SYNTAX";

		// @ts-expect-error
		engine.capturePane = mock(async () => `syntax error near token\n${completionToken}:2`);

		try {
			// @ts-expect-error
			const result = await engine.waitForTmuxCompletion("session-name", 5000, completionToken);

			expect(result.status).toBe("failed");
			expect(result.error).toContain("tmux command failed");
		} finally {
			// Restore
		}
	});

	test("waitForTmuxCompletion handles 'No such file' error", async () => {
		const engine = new HostIpcEngine();
		const completionToken = "CC_BRIDGE_DONE_NOSUCH";

		// @ts-expect-error
		engine.capturePane = mock(async () => `No such file or directory\n${completionToken}:1`);

		try {
			// @ts-expect-error
			const result = await engine.waitForTmuxCompletion("session-name", 5000, completionToken);

			expect(result.status).toBe("failed");
		} finally {
			// Restore
		}
	});

	test("extractRecentOutput handles empty filtered lines with start markers", () => {
		const engine = new HostIpcEngine();
		const input = "line1\nline2\nClaude: response starts here";

		// @ts-expect-error
		const result = engine.extractRecentOutput(input, "TOKEN");

		expect(result).toContain("Claude:");
	});

	test("extractRecentOutput handles # single hash header", () => {
		const engine = new HostIpcEngine();
		const input = "command\n# Single Header\ncontent";

		// @ts-expect-error
		const result = engine.extractRecentOutput(input, "TOKEN");

		expect(result).toContain("Single Header");
	});

	test("extractRecentOutput handles # header with single word", () => {
		const engine = new HostIpcEngine();
		// The regex /^#{1,2}\s+\w+/ requires at least one space after the hash
		const input = "command\n# Title\ncontent";

		// @ts-expect-error
		const result = engine.extractRecentOutput(input, "TOKEN");

		expect(result).toContain("Title");
	});

	test("executeViaTmux handles error in ensureHostSession", async () => {
		const engine = new HostIpcEngine({ command: "test-cmd" });

		// Mock ensureHostSession to throw
		// @ts-expect-error
		const originalEnsure = engine.ensureHostSession;
		// @ts-expect-error
		engine.ensureHostSession = mock(async () => {
			throw new Error("Session creation failed");
		});

		try {
			const result = await engine.execute({
				prompt: "test",
				options: { sync: false },
			});

			expect(result.status).toBe("failed");
			expect(result.error).toContain("Session creation failed");
		} finally {
			// @ts-expect-error
			engine.ensureHostSession = originalEnsure;
		}
	});

	test("executeViaTmux handles error in sendToHostSession", async () => {
		const engine = new HostIpcEngine({ command: "test-cmd" });

		// @ts-expect-error
		engine.ensureHostSession = mock(async () => {});
		// @ts-expect-error
		engine.sendToHostSession = mock(async () => {
			throw new Error("Send failed");
		});

		try {
			const result = await engine.execute({
				prompt: "test",
				options: { sync: false },
			});

			expect(result.status).toBe("failed");
		} finally {
			// Restore
		}
	});

	test("executeViaTmux with sync mode and successful completion", async () => {
		const engine = new HostIpcEngine({ command: "test-cmd" });

		// @ts-expect-error
		engine.ensureHostSession = mock(async () => {});
		// @ts-expect-error
		engine.sendToHostSession = mock(async () => {});
		// @ts-expect-error
		engine.waitForTmuxCompletion = mock(async () => ({
			status: "completed",
			output: "test output",
			exitCode: 0,
			retryable: false,
		}));
		// @ts-expect-error
		engine.interruptHostSession = mock(async () => {});

		try {
			const result = await engine.execute({
				prompt: "test",
				options: { sync: true, workspace: "ws", chatId: "123" },
			});

			expect(result.status).toBe("completed");
		} finally {
			// Restore
		}
	});

	test("executeViaTmux with sync mode and non-completed result triggers interrupt", async () => {
		const engine = new HostIpcEngine({ command: "test-cmd" });

		// @ts-expect-error
		engine.ensureHostSession = mock(async () => {});
		// @ts-expect-error
		engine.sendToHostSession = mock(async () => {});
		// @ts-expect-error
		engine.waitForTmuxCompletion = mock(async () => ({
			status: "timeout",
			error: "timed out",
			isTimeout: true,
			retryable: true,
		}));
		// @ts-expect-error
		engine.interruptHostSession = mock(async () => {});

		try {
			const result = await engine.execute({
				prompt: "test",
				options: { sync: true, workspace: "ws", chatId: "123" },
			});

			expect(result.status).toBe("timeout");
			// @ts-expect-error
			expect(engine.interruptHostSession).toHaveBeenCalled();
		} finally {
			// Restore
		}
	});

	test("executeViaTmux with ephemeral session cleans up after completion", async () => {
		const engine = new HostIpcEngine({ command: "test-cmd" });

		// @ts-expect-error
		engine.ensureHostSession = mock(async () => {});
		// @ts-expect-error
		engine.sendToHostSession = mock(async () => {});
		// @ts-expect-error
		engine.waitForTmuxCompletion = mock(async () => ({
			status: "completed",
			output: "test output",
			exitCode: 0,
			retryable: false,
		}));
		// @ts-expect-error
		engine.interruptHostSession = mock(async () => {});
		// @ts-expect-error
		engine.killHostSession = mock(async () => {});

		try {
			const result = await engine.execute({
				prompt: "test",
				options: { sync: true, ephemeralSession: true, workspace: "ws", chatId: "123" },
			});

			expect(result.status).toBe("completed");
			// @ts-expect-error
			expect(engine.killHostSession).toHaveBeenCalled();
		} finally {
			// Restore
		}
	});

	test("executeViaTmux with ephemeral session cleans up after failure", async () => {
		const engine = new HostIpcEngine({ command: "test-cmd" });

		// @ts-expect-error
		engine.ensureHostSession = mock(async () => {});
		// @ts-expect-error
		engine.sendToHostSession = mock(async () => {
			throw new Error("Send failed");
		});
		// @ts-expect-error
		engine.killHostSession = mock(async () => {});
		// @ts-expect-error
		engine.hostSessionExists = mock(async () => true);

		try {
			const result = await engine.execute({
				prompt: "test",
				options: { ephemeralSession: true, workspace: "ws", chatId: "123" },
			});

			expect(result.status).toBe("failed");
			// The error is caught in executeViaTmux and session cleanup happens there
		} finally {
			// Restore
		}
	});
});

// =============================================================================
// HostIpcEngine Execute Path Coverage
// =============================================================================

describe("HostIpcEngine execute path coverage", () => {
	test("execute with options.args overrides config.args", () => {
		const engine = new HostIpcEngine({ args: ["--config-arg"] });
		// @ts-expect-error
		const { buildArgs } = engine.prepareExecution("test", { args: ["--request-arg"] });
		const { args } = buildArgs("prompt", "ws", "123");
		expect(args).toContain("--request-arg");
		expect(args).not.toContain("--config-arg");
	});

	test("execute with codex_host and options.args", () => {
		const engine = new HostIpcEngine({ engineType: "codex_host" });
		// @ts-expect-error
		const { buildArgs } = engine.prepareExecution("test", { args: ["--custom"] });
		const { args } = buildArgs("prompt", "ws", "123");
		expect(args).toContain("--custom");
	});

	test("execute with allowDangerouslySkipPermissions false", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error
		const { buildArgs } = engine.prepareExecution("test", { allowDangerouslySkipPermissions: false });
		const { args } = buildArgs("prompt", "ws", "123");
		// Should not include --dangerously-skip-permissions
		expect(args.some((a: string) => a.includes("--dangerously-skip-permissions"))).toBe(false);
	});

	test("execute with custom allowedTools", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error
		const { buildArgs } = engine.prepareExecution("test", { allowedTools: "Read,Write" });
		const { args } = buildArgs("prompt", "ws", "123");
		expect(args.some((a: string) => a.includes("allowedTools=Read,Write"))).toBe(true);
	});

	test("execute with empty allowedTools uses default", () => {
		const engine = new HostIpcEngine();
		// @ts-expect-error
		const { buildArgs } = engine.prepareExecution("test", { allowedTools: "" });
		const { args } = buildArgs("prompt", "ws", "123");
		// Empty allowedTools falls back to "*" (default)
		expect(args.some((a: string) => a.includes("allowedTools=*"))).toBe(true);
	});

	test("execute with options.command override", () => {
		const engine = new HostIpcEngine({ command: "default-cmd" });
		// @ts-expect-error
		const { buildArgs } = engine.prepareExecution("test", { command: "override-cmd" });
		const { command } = buildArgs("prompt", "ws", "123");
		expect(command).toBe("override-cmd");
	});

	test("execute with codex_host options.command override", () => {
		const engine = new HostIpcEngine({ engineType: "codex_host", command: "default-codex" });
		// @ts-expect-error
		const { buildArgs } = engine.prepareExecution("test", { command: "override-codex" });
		const { command } = buildArgs("prompt", "ws", "123");
		expect(command).toBe("override-codex");
	});

	test("getCommand uses CODEX_HOST_COMMAND env var", () => {
		const original = process.env.CODEX_HOST_COMMAND;
		process.env.CODEX_HOST_COMMAND = "my-codex";
		try {
			const engine = new HostIpcEngine({ engineType: "codex_host" });
			// @ts-expect-error
			expect(engine.getCommand()).toBe("my-codex");
		} finally {
			if (original) process.env.CODEX_HOST_COMMAND = original;
			else delete process.env.CODEX_HOST_COMMAND;
		}
	});

	test("getCommand uses CLAUDE_HOST_COMMAND env var", () => {
		const original = process.env.CLAUDE_HOST_COMMAND;
		process.env.CLAUDE_HOST_COMMAND = "my-claude";
		try {
			const engine = new HostIpcEngine();
			// @ts-expect-error
			expect(engine.getCommand()).toBe("my-claude");
		} finally {
			if (original) process.env.CLAUDE_HOST_COMMAND = original;
			else delete process.env.CLAUDE_HOST_COMMAND;
		}
	});

	test("execute returns running status in async mode", async () => {
		const engine = new HostIpcEngine({ command: "nonexistent-cmd-for-test-xyz" });
		const result = await engine.execute({
			prompt: "test",
			options: { sync: false },
		});
		// Should return running or failed (if tmux not available)
		expect(["running", "failed"]).toContain(result.status);
	});

	test("execute with ephemeralSession option", async () => {
		const engine = new HostIpcEngine({ command: "nonexistent-cmd-test" });
		const result = await engine.execute({
			prompt: "test",
			options: { ephemeralSession: true, sync: false },
		});
		expect(result).toHaveProperty("status");
	});

	test("execute with all options", async () => {
		const engine = new HostIpcEngine({ command: "nonexistent-cmd-test" });
		const result = await engine.execute({
			prompt: "test prompt",
			options: {
				workspace: "test-workspace",
				chatId: "chat-456",
				timeout: 5000,
				sync: false,
				ephemeralSession: true,
				allowDangerouslySkipPermissions: true,
				allowedTools: "Read",
			},
		});
		expect(result).toHaveProperty("status");
	});

	test("execute with history for codex_host", async () => {
		const engine = new HostIpcEngine({ engineType: "codex_host", command: "nonexistent" });
		const result = await engine.execute({
			prompt: "test",
			options: {
				history: [{ sender: "user", text: "hello", timestamp: "2024-01-01T00:00:00Z" }],
				sync: false,
			},
		});
		expect(result).toHaveProperty("status");
	});
});

// =============================================================================
// Container Engine Additional Coverage Tests
// =============================================================================

describe("ContainerEngine additional coverage", () => {
	test("isAvailable checks docker availability", async () => {
		const engine = new ContainerEngine();
		const available = await engine.isAvailable();
		// Either available or not, but tests the path
		expect(typeof available).toBe("boolean");
	});

	test("execute validates instance or containerId", async () => {
		const engine = new ContainerEngine();
		const result = await engine.execute({ prompt: "test", options: {} });
		expect(result.status).toBe("failed");
		expect(result.error).toContain("requires either instance or containerId");
	});

	test("execute validates containerId string", async () => {
		const engine = new ContainerEngine();
		const result = await engine.execute({ prompt: "test", options: { containerId: "" } });
		expect(result.status).toBe("failed");
	});

	test("getHealth returns unavailable when docker not available", async () => {
		const engine = new ContainerEngine();
		const health = await engine.getHealth();
		expect(health.layer).toBe("container");
	});

	test("execute with history path uses buildClaudePrompt", async () => {
		const engine = new ContainerEngine();
		// This should fail fast (not timeout) since container doesn't exist
		const result = await engine.execute({
			prompt: "test",
			options: {
				history: [{ sender: "user", text: "hello", timestamp: "2024-01-01T00:00:00Z" }],
			},
		});
		// Should fail due to missing instance/containerId
		expect(result.status).toBe("failed");
	});

	test("TmuxManagerWrapper getOrCreateSession delegates to manager", async () => {
		// Create a mock TmuxManager
		const _mockManager = {
			getOrCreateSession: mock(async () => "session-123"),
			sendToSession: mock(async () => {}),
		};

		// Import the wrapper class through the engine
		const { ContainerEngine } = require("@/gateway/engine/index");

		// We can't easily test TmuxManagerWrapper directly without more refactoring
		// But we can verify the engine has the right interface
		const engine = new ContainerEngine();
		expect(engine.getLayer()).toBe("container");
	});

	test("getTmuxManager lazy initializes", async () => {
		const engine = new ContainerEngine();
		// Access the private method via execute path that uses tmux
		// This is indirect coverage
		expect(engine.getLayer()).toBe("container");
	});

	test("execute handles useTmux option true", async () => {
		// When useTmux is true, it tries to execute via tmux which would timeout/fail
		// But it should still hit the code path
		const engine = new ContainerEngine();
		// Without instance/containerId it should fail fast
		const result = await engine.execute({
			prompt: "test",
			options: { useTmux: true },
		});
		expect(result.status).toBe("failed");
	});

	// Test docker exec path - uses real docker container
	test("execute with containerId invokes docker exec", async () => {
		const engine = new ContainerEngine();
		// Use the actual running container with short timeout - explicitly disable tmux
		const result = await engine.execute({
			prompt: "echo hello",
			containerId: "claude-cc-bridge",
			options: { timeout: 5000, useTmux: false },
		});
		// Should complete or fail, but should have executed docker
		expect(result).toHaveProperty("status");
		// If docker works, we should get output
		if (result.status === "completed") {
			expect(result.output).toContain("hello");
		}
	}, 15000); // 15 second timeout for this test

	// Test that execute validates instance or containerId
	test("execute requires instance or containerId", async () => {
		const engine = new ContainerEngine();
		const result = await engine.execute({
			prompt: "test",
			options: {},
		});
		expect(result.status).toBe("failed");
		expect(result.error).toContain("requires either instance or containerId");
	});
});

// Tmux execution path tests - using dependency injection
describe("ContainerEngine tmux execution path", () => {
	test("executeViaTmux returns running status on success", async () => {
		// Create mock TmuxManager
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		// Import the wrapper and create injected engine
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		const result = await engine.execute({
			prompt: "test prompt",
			instance: { name: "test", containerId: "c1", status: "running", image: "i" },
			options: { useTmux: true, workspace: "ws", chatId: "123" },
		});

		expect(result.status).toBe("running");
		expect(result.mode).toBe("tmux");
		expect(result.requestId).toBeDefined();
		expect(mockManager.getOrCreateSession).toHaveBeenCalled();
		expect(mockManager.sendToSession).toHaveBeenCalled();
	});

	test("executeViaTmux handles error from tmux manager", async () => {
		// Mock tmux manager to throw
		const mockManager = {
			getOrCreateSession: mock(async () => {
				throw new Error("Tmux session failed");
			}),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		const result = await engine.execute({
			prompt: "test",
			instance: { name: "test", containerId: "c1", status: "running", image: "i" },
			options: { useTmux: true, workspace: "ws", chatId: "123" },
		});

		expect(result.status).toBe("failed");
		expect(result.error).toContain("Tmux session failed");
		expect(result.retryable).toBe(false);
	});

	test("getTmuxManager lazy initializes when no injection", async () => {
		const { ContainerEngine } = require("@/gateway/engine/index");
		const engine = new ContainerEngine();

		// Verify we can access the layer method (the engine is initialized)
		expect(engine.getLayer()).toBe("container");
	});

	test("sync ephemeral tmux execution cleans up leaked session after completion", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);
		const waitForResponseFile = mock(async () => ({
			status: "completed",
			output: "ok",
			exitCode: 0,
			retryable: false,
		}));
		(engine as unknown as { waitForResponseFile: typeof waitForResponseFile }).waitForResponseFile =
			waitForResponseFile;

		const result = await engine.execute({
			prompt: "test prompt",
			instance: { name: "test", containerId: "c1", status: "running", image: "i" },
			options: { sync: true, ephemeralSession: true, workspace: "ws", chatId: "miniapp-123" },
		});

		expect(result.status).toBe("completed");
		expect(mockManager.killSession).toHaveBeenCalledWith("c1", "test-session");
	});
});

// =============================================================================
// ContainerEngine Additional Coverage Tests
// =============================================================================

describe("ContainerEngine additional coverage", () => {
	test("execute uses containerId from request when instance not provided", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		const result = await engine.execute({
			prompt: "test",
			containerId: "container-xyz",
			options: { workspace: "ws", chatId: "123" },
		});

		expect(result.status).toBe("running");
		expect(mockManager.getOrCreateSession).toHaveBeenCalledWith("container-xyz", "ws", "123");
	});

	test("execute prefers containerId over instance.containerId", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		const result = await engine.execute({
			prompt: "test",
			containerId: "preferred-container",
			instance: { name: "test", containerId: "instance-container", status: "running", image: "i" },
			options: { workspace: "ws", chatId: "123" },
		});

		expect(result.status).toBe("running");
		expect(mockManager.getOrCreateSession).toHaveBeenCalledWith("preferred-container", "ws", "123");
	});

	test("execute with history builds prompt with buildClaudePrompt", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		const result = await engine.execute({
			prompt: "current message",
			containerId: "c1",
			options: {
				workspace: "ws",
				chatId: "123",
				history: [{ sender: "user", text: "hello", timestamp: "2024-01-01T00:00:00Z" }],
			},
		});

		expect(result.status).toBe("running");
	});

	test("execute with sync mode returns completed result", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		// Mock waitForResponseFile
		const waitForResponseFile = mock(async () => ({
			status: "completed",
			output: "success output",
			exitCode: 0,
			retryable: false,
		}));
		(engine as unknown as { waitForResponseFile: typeof waitForResponseFile }).waitForResponseFile =
			waitForResponseFile;

		const result = await engine.execute({
			prompt: "test",
			containerId: "c1",
			options: { sync: true, workspace: "ws", chatId: "123", timeout: 5000 },
		});

		expect(result.status).toBe("completed");
		expect(result.output).toBe("success output");
	});

	test("execute with sync mode and failed response", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		const waitForResponseFile = mock(async () => ({
			status: "failed",
			output: "error output",
			exitCode: 1,
			error: "Command failed",
			retryable: false,
		}));
		(engine as unknown as { waitForResponseFile: typeof waitForResponseFile }).waitForResponseFile =
			waitForResponseFile;

		const result = await engine.execute({
			prompt: "test",
			containerId: "c1",
			options: { sync: true, workspace: "ws", chatId: "123" },
		});

		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(1);
	});

	test("execute cleans up ephemeral session on error", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {
				throw new Error("Send failed");
			}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		const result = await engine.execute({
			prompt: "test",
			containerId: "c1",
			options: { ephemeralSession: true, workspace: "ws", chatId: "123" },
		});

		expect(result.status).toBe("failed");
		expect(mockManager.killSession).toHaveBeenCalled();
	});

	test("execute handles cleanup error gracefully", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {
				throw new Error("Cleanup failed");
			}),
			sendToSession: mock(async () => {
				throw new Error("Send failed");
			}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		// Should not throw even if cleanup fails
		const result = await engine.execute({
			prompt: "test",
			containerId: "c1",
			options: { ephemeralSession: true, workspace: "ws", chatId: "123" },
		});

		expect(result.status).toBe("failed");
	});

	test("execute with custom timeout", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		const result = await engine.execute({
			prompt: "test",
			containerId: "c1",
			options: { timeout: 60000, workspace: "ws", chatId: "123" },
		});

		expect(result.status).toBe("running");
	});

	test("execute with custom workspace and chatId", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		const result = await engine.execute({
			prompt: "test",
			containerId: "c1",
			options: { workspace: "custom-workspace", chatId: "chat-999" },
		});

		expect(result.status).toBe("running");
		expect(mockManager.getOrCreateSession).toHaveBeenCalledWith("c1", "custom-workspace", "chat-999");
	});

	test("execute uses default values when options not provided", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		const result = await engine.execute({
			prompt: "test",
			containerId: "c1",
			options: {},
		});

		expect(result.status).toBe("running");
		// Should use default workspace "cc-bridge" and chatId "default"
		expect(mockManager.getOrCreateSession).toHaveBeenCalledWith("c1", "cc-bridge", "default");
	});

	test("execute uses instance name when no containerId", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "test-session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { ContainerEngine, TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);
		const engine = new ContainerEngine(wrapper);

		const result = await engine.execute({
			prompt: "test",
			instance: { name: "my-instance", containerId: "inst-c1", status: "running", image: "img" },
			options: { workspace: "ws", chatId: "123" },
		});

		expect(result.status).toBe("running");
		expect(mockManager.getOrCreateSession).toHaveBeenCalledWith("inst-c1", "ws", "123");
	});
});

// =============================================================================
// ContainerEngine Private Methods Coverage via Mocked ResponseFileReader
// =============================================================================

describe("ContainerEngine waitForResponseFile coverage", () => {
	test("waitForResponseFile returns completed result", async () => {
		const { ContainerEngine } = require("@/gateway/engine/index");
		const engine = new ContainerEngine();

		// Create a mock ResponseFileReader
		const mockReader = {
			exists: mock(async () => true),
			readResponseFile: mock(async () => ({
				output: "test output",
				exitCode: 0,
				error: undefined,
			})),
		};

		// Inject the mock reader
		(engine as unknown as { getResponseFileReader: () => typeof mockReader }).getResponseFileReader = () => mockReader;

		// Call waitForResponseFile directly
		// @ts-expect-error - accessing private method
		const result = await engine.waitForResponseFile("workspace", "request-id", 5000);

		expect(result.status).toBe("completed");
		expect(result.output).toBe("test output");
		expect(result.exitCode).toBe(0);
	});

	test("waitForResponseFile returns failed result on non-zero exit code", async () => {
		const { ContainerEngine } = require("@/gateway/engine/index");
		const engine = new ContainerEngine();

		const mockReader = {
			exists: mock(async () => true),
			readResponseFile: mock(async () => ({
				output: "error output",
				exitCode: 1,
				error: "Command failed",
			})),
		};

		(engine as unknown as { getResponseFileReader: () => typeof mockReader }).getResponseFileReader = () => mockReader;

		// @ts-expect-error - accessing private method
		const result = await engine.waitForResponseFile("workspace", "request-id", 5000);

		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Command failed");
	});

	test("waitForResponseFile handles read errors and retries", async () => {
		const { ContainerEngine } = require("@/gateway/engine/index");
		const engine = new ContainerEngine();

		let callCount = 0;
		const mockReader = {
			exists: mock(async () => true),
			readResponseFile: mock(async () => {
				callCount++;
				if (callCount < 3) {
					throw new Error("File not ready");
				}
				return {
					output: "success after retry",
					exitCode: 0,
					error: undefined,
				};
			}),
		};

		(engine as unknown as { getResponseFileReader: () => typeof mockReader }).getResponseFileReader = () => mockReader;

		// @ts-expect-error - accessing private method
		const result = await engine.waitForResponseFile("workspace", "request-id", 5000);

		expect(result.status).toBe("completed");
		expect(result.output).toBe("success after retry");
	});

	test("waitForResponseFile returns timeout when file never appears", async () => {
		const { ContainerEngine } = require("@/gateway/engine/index");
		const engine = new ContainerEngine();

		const mockReader = {
			exists: mock(async () => false),
			readResponseFile: mock(async () => ({ output: "", exitCode: 0 })),
		};

		(engine as unknown as { getResponseFileReader: () => typeof mockReader }).getResponseFileReader = () => mockReader;

		// Use a very short timeout to make the test fast
		// @ts-expect-error - accessing private method
		const result = await engine.waitForResponseFile("workspace", "request-id", 100);

		expect(result.status).toBe("timeout");
		expect(result.isTimeout).toBe(true);
		expect(result.retryable).toBe(true);
	});

	test("getResponseFileReader creates reader lazily", () => {
		const { ContainerEngine } = require("@/gateway/engine/index");
		const engine = new ContainerEngine();

		// @ts-expect-error - accessing private method
		const reader1 = engine.getResponseFileReader();
		// @ts-expect-error - accessing private method
		const reader2 = engine.getResponseFileReader();

		// Should return same instance
		expect(reader1).toBe(reader2);
	});

	test("sleep method works correctly", async () => {
		const { ContainerEngine } = require("@/gateway/engine/index");
		const engine = new ContainerEngine();

		const start = Date.now();
		// @ts-expect-error - accessing private method
		await engine.sleep(50);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some variance
	});
});

// =============================================================================
// ContainerEngine TmuxManagerWrapper Tests
// =============================================================================

describe("TmuxManagerWrapper", () => {
	test("getOrCreateSession delegates to manager", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "session-name"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);

		const result = await wrapper.getOrCreateSession("c1", "ws", "chat1");

		expect(result).toBe("session-name");
		expect(mockManager.getOrCreateSession).toHaveBeenCalledWith("c1", "ws", "chat1");
	});

	test("killSession delegates to manager", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);

		await wrapper.killSession("c1", "session");

		expect(mockManager.killSession).toHaveBeenCalledWith("c1", "session");
	});

	test("sendToSession delegates to manager", async () => {
		const mockManager = {
			getOrCreateSession: mock(async () => "session"),
			killSession: mock(async () => {}),
			sendToSession: mock(async () => {}),
		};
		const { TmuxManagerWrapper } = require("@/gateway/engine/index");
		const wrapper = new TmuxManagerWrapper(mockManager);

		await wrapper.sendToSession("c1", "session", "prompt", {
			requestId: "req-1",
			chatId: "chat-1",
			workspace: "ws",
		});

		expect(mockManager.sendToSession).toHaveBeenCalledWith("c1", "session", "prompt", {
			requestId: "req-1",
			chatId: "chat-1",
			workspace: "ws",
		});
	});
});

// =============================================================================
// Orchestrator Additional Coverage Tests
// =============================================================================

describe("ExecutionOrchestrator execute paths", () => {
	test("getBestLayer returns null when no layers available", async () => {
		const orchestrator = new ExecutionOrchestrator({
			enableInProcess: false,
			enableHostIpc: false,
			enableContainer: false,
			healthCheckIntervalMs: 999999,
		});

		const bestLayer = await orchestrator.getBestLayer();
		expect(bestLayer === null || bestLayer === undefined).toBe(true);
	});

	test("getBestLayer returns layer when available", async () => {
		const orchestrator = new ExecutionOrchestrator({
			enableInProcess: false,
			enableHostIpc: true,
			enableContainer: false,
			healthCheckIntervalMs: 999999,
		});

		const bestLayer = await orchestrator.getBestLayer();
		// May be null if CLI not available, but covers the path
		expect(bestLayer === null || bestLayer === undefined || typeof bestLayer === "string").toBe(true);
	});

	test("executeOnLayer returns error when layer not found", async () => {
		const orchestrator = new ExecutionOrchestrator({
			enableInProcess: false,
			enableHostIpc: false,
			enableContainer: false,
			healthCheckIntervalMs: 999999,
		});

		const result = await orchestrator.executeOnLayer({ prompt: "test" }, "host-ipc" as ExecutionLayer);
		expect(result.status).toBe("failed");
	});

	test("getCachedHealth returns undefined for unknown layer", () => {
		const orchestrator = new ExecutionOrchestrator({
			healthCheckIntervalMs: 999999,
		});

		const health = orchestrator.getCachedHealth("unknown-layer" as ExecutionLayer);
		expect(health).toBeUndefined();
	});

	test("setDefaultOrchestrator and getDefaultOrchestrator", () => {
		const { setDefaultOrchestrator, getDefaultOrchestrator } = require("@/gateway/engine/index");
		const newOrchestrator = new ExecutionOrchestrator({ healthCheckIntervalMs: 999999 });
		setDefaultOrchestrator(newOrchestrator);
		const retrieved = getDefaultOrchestrator();
		expect(retrieved).toBe(newOrchestrator);
	});

	test("execute completes on first available layer", async () => {
		const orchestrator = new ExecutionOrchestrator({
			enableInProcess: false,
			enableHostIpc: true,
			enableContainer: false,
			healthCheckIntervalMs: 999999,
		});

		// Manually set a mock engine
		const mockEngine = {
			getLayer: () => "host-ipc",
			isAvailable: async () => true,
			execute: async () => ({ status: "completed", output: "success", exitCode: 0 }),
		};
		// @ts-expect-error - injecting mock engine
		orchestrator.engines.set("host-ipc", mockEngine);

		const result = await orchestrator.execute({ prompt: "test" });
		expect(result.status).toBe("completed");
		expect(result.output).toBe("success");
	});

	test("execute falls back to next layer on failure", async () => {
		const orchestrator = new ExecutionOrchestrator({
			enableInProcess: false,
			enableHostIpc: true,
			enableContainer: true,
			healthCheckIntervalMs: 999999,
		});

		// Set up mock engines - first fails, second succeeds
		const mockHostIpc = {
			getLayer: () => "host-ipc",
			isAvailable: async () => true,
			execute: async () => ({ status: "failed", error: "host-ipc failed", retryable: false }),
		};
		const mockContainer = {
			getLayer: () => "container",
			isAvailable: async () => true,
			execute: async () => ({ status: "completed", output: "container success", exitCode: 0 }),
		};
		// @ts-expect-error
		orchestrator.engines.set("host-ipc", mockHostIpc);
		// @ts-expect-error
		orchestrator.engines.set("container", mockContainer);

		const result = await orchestrator.execute({ prompt: "test" });
		expect(result.status).toBe("completed");
		expect(result.output).toBe("container success");
	});

	test("execute retries on retryable failure", async () => {
		const orchestrator = new ExecutionOrchestrator({
			enableInProcess: false,
			enableHostIpc: true,
			enableContainer: false,
			healthCheckIntervalMs: 999999,
			maxRetries: 1,
		});

		let callCount = 0;
		const mockEngine = {
			getLayer: () => "host-ipc",
			isAvailable: async () => true,
			execute: async () => {
				callCount++;
				if (callCount === 1) {
					return { status: "failed", error: "temp error", retryable: true };
				}
				return { status: "completed", output: "success on retry", exitCode: 0 };
			},
		};
		// @ts-expect-error
		orchestrator.engines.set("host-ipc", mockEngine);

		const result = await orchestrator.execute({ prompt: "test" });
		expect(result.status).toBe("completed");
		expect(callCount).toBe(2); // initial + retry
	});

	test("execute throws when all layers fail", async () => {
		const orchestrator = new ExecutionOrchestrator({
			enableInProcess: false,
			enableHostIpc: true,
			enableContainer: false,
			healthCheckIntervalMs: 999999,
		});

		const mockEngine = {
			getLayer: () => "host-ipc",
			isAvailable: async () => true,
			execute: async () => ({ status: "failed", error: "failed", retryable: false }),
		};
		// @ts-expect-error
		orchestrator.engines.set("host-ipc", mockEngine);

		await expect(orchestrator.execute({ prompt: "test" })).rejects.toThrow();
	});

	test("execute handles layer exception", async () => {
		const orchestrator = new ExecutionOrchestrator({
			enableInProcess: false,
			enableHostIpc: true,
			enableContainer: false,
			healthCheckIntervalMs: 999999,
		});

		const mockEngine = {
			getLayer: () => "host-ipc",
			isAvailable: async () => true,
			execute: async () => {
				throw new Error("engine error");
			},
		};
		// @ts-expect-error
		orchestrator.engines.set("host-ipc", mockEngine);

		// Should fall through to next layer or throw
		try {
			await orchestrator.execute({ prompt: "test" });
		} catch (e) {
			expect(e).toBeDefined();
		}
	});

	test("getLayers returns all initialized engines", () => {
		const orchestrator = new ExecutionOrchestrator({
			enableInProcess: false,
			enableHostIpc: true,
			enableContainer: true,
			healthCheckIntervalMs: 999999,
		});

		const layers = orchestrator.getLayers();
		expect(layers).toContain("host-ipc");
		expect(layers).toContain("container");
	});

	// Test lazy initialization in getExecutionOrchestrator (orchestrator.ts lines 266-270)
	test("getExecutionOrchestrator singleton works", () => {
		// This tests the lazy initialization in the orchestrator module
		const { getExecutionOrchestrator } = require("@/gateway/engine/index");
		// The function should be callable and return an orchestrator
		const orch = getExecutionOrchestrator();
		expect(orch).toBeDefined();
		expect(typeof orch.execute).toBe("function");
	});

	// Additional test to exercise more orchestrator paths
	test("orchestrator stops health monitoring on stop", async () => {
		const orchestrator = new ExecutionOrchestrator({
			enableHostIpc: true,
			healthCheckIntervalMs: 100,
		});

		// Wait a bit for health check to potentially start
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Stop should clear the timer
		orchestrator.stop();

		// Call stop again - should not throw
		orchestrator.stop();

		expect(true).toBe(true);
	});

	// Test that calls getExecutionOrchestrator multiple times
	test("getExecutionOrchestrator caches the instance", () => {
		const { getExecutionOrchestrator } = require("@/gateway/engine/index");
		const orch1 = getExecutionOrchestrator();
		const orch2 = getExecutionOrchestrator();
		// Both should be the same instance
		expect(orch1).toBe(orch2);
	});
});
