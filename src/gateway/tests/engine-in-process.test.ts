import { describe, expect, mock, test } from "bun:test";
import { InProcessEngine } from "@/gateway/engine/in-process";

// Mock the embedded-agent module
const mockAgent = {
	abort: mock(() => {}),
	dispose: mock(() => {}),
	getMessages: mock(() => []),
	isRunning: mock(() => false),
	steer: mock(() => {}),
	queueFollowUp: mock(() => {}),
	prompt: mock(async () => ({ output: "mock response" })),
};

// Only mock embedded-agent, not agent-sessions
// This allows other test files to test the real AgentSessionManager
mock.module("@/gateway/engine/embedded-agent", () => ({
	EmbeddedAgent: class MockEmbeddedAgent {
		constructor(_config: unknown) {
			// biome-ignore lint/correctness/noConstructorReturn: intentional mock - returns existing object for test isolation
			return mockAgent as unknown as MockEmbeddedAgent;
		}
	},
	resolveProviderApiKey: mock(() => "mock-api-key"),
}));

// Mock tools
mock.module("@/gateway/engine/tools", () => ({
	createDefaultTools: mock(() => []),
}));

describe("in-process", () => {
	describe("InProcessEngine", () => {
		test("can be constructed with enabled=false", () => {
			const engine = new InProcessEngine(false);
			expect(engine).toBeDefined();
			expect(engine.getLayer()).toBe("in-process");
			engine.dispose();
		});

		test("can be constructed with enabled=true", () => {
			const engine = new InProcessEngine(true);
			expect(engine).toBeDefined();
			engine.dispose();
		});

		test("getLayer returns correct layer name", () => {
			const engine = new InProcessEngine();
			expect(engine.getLayer()).toBe("in-process");
			engine.dispose();
		});

		test("isAvailable returns false when not enabled", async () => {
			const engine = new InProcessEngine(false);
			const available = await engine.isAvailable();
			expect(available).toBe(false);
			engine.dispose();
		});

		test("execute returns failure when not enabled", async () => {
			const engine = new InProcessEngine(false);
			const result = await engine.execute({
				command: "test command",
			});
			expect(result.status).toBe("failed");
			expect(result.error).toContain("not enabled");
			expect(result.retryable).toBe(false);
			engine.dispose();
		});
	});
});
