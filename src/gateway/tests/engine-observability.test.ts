import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
	categorizeAgentError,
	createObservabilitySnapshot,
	EventCollector,
	finishObservabilityRun,
	startObservabilityRun,
	usageFromPiUsage,
} from "@/gateway/engine/agent";

describe("agent observability", () => {
	test("usageFromPiUsage normalizes tokens and cost", () => {
		const usage = usageFromPiUsage({
			input: 120,
			output: 45,
			cacheRead: 30,
			cacheWrite: 10,
			totalTokens: 205,
			cost: {
				input: 0.12,
				output: 0.45,
				cacheRead: 0.03,
				cacheWrite: 0.01,
				total: 0.61,
			},
		});

		expect(usage.totalTokens).toBe(205);
		expect(usage.cost.total).toBe(0.61);
	});

	test("EventCollector aggregates assistant usage across message_end events", () => {
		const collector = new EventCollector();

		collector.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "first" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				usage: {
					input: 100,
					output: 40,
					cacheRead: 5,
					cacheWrite: 0,
					totalTokens: 145,
					cost: {
						input: 0.1,
						output: 0.2,
						cacheRead: 0.01,
						cacheWrite: 0,
						total: 0.31,
					},
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		} as AgentEvent);
		collector.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "second" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				usage: {
					input: 60,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 80,
					cost: {
						input: 0.06,
						output: 0.08,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0.14,
					},
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		} as AgentEvent);

		const usage = collector.getUsageTotals();
		expect(usage.input).toBe(160);
		expect(usage.output).toBe(60);
		expect(usage.totalTokens).toBe(225);
		expect(usage.cost.total).toBe(0.45);
	});

	test("session snapshot tracks totals and error categories", () => {
		const snapshot = createObservabilitySnapshot("session-1", "anthropic", "claude-sonnet-4-6");
		const context = startObservabilityRun(snapshot, 24);
		const run = finishObservabilityRun({
			snapshot,
			context,
			outputLength: 12,
			turnCount: 2,
			toolCallCount: 1,
			toolErrorCount: 1,
			aborted: true,
			errorCategory: "max_iterations",
			usage: usageFromPiUsage({
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: {
					input: 0.05,
					output: 0.02,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.07,
				},
			}),
		});

		expect(run.errorCategory).toBe("max_iterations");
		expect(snapshot.failureCount).toBe(1);
		expect(snapshot.totals.turnCount).toBe(2);
		expect(snapshot.totals.usage.totalTokens).toBe(60);
		expect(snapshot.totals.errorsByCategory.max_iterations).toBe(1);
	});

	test("categorizeAgentError identifies common failure modes", () => {
		expect(categorizeAgentError(new Error("prompt() is already running"))).toBe("concurrency");
		expect(categorizeAgentError(new Error("No API key configured for provider"))).toBe("configuration");
		expect(categorizeAgentError(new Error("Request timeout reached"))).toBe("timeout");
	});
});
