import { describe, expect, mock, test } from "bun:test";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { EventCollector, isTextContentBlock } from "@/gateway/engine/agent";

describe("event-bridge", () => {
	describe("isTextContentBlock", () => {
		test("returns true for text content block", () => {
			const block = { type: "text" as const, text: "hello" };
			expect(isTextContentBlock(block)).toBe(true);
		});

		test("returns false for image content block", () => {
			const block = { type: "image" as const, source: { url: "http://example.com" } };
			expect(isTextContentBlock(block)).toBe(false);
		});

		test("returns false for null", () => {
			expect(isTextContentBlock(null)).toBe(false);
		});

		test("returns false for undefined", () => {
			expect(isTextContentBlock(undefined)).toBe(false);
		});

		test("returns false for plain object without type", () => {
			expect(isTextContentBlock({ foo: "bar" })).toBe(false);
		});

		test("returns false for string", () => {
			expect(isTextContentBlock("text")).toBe(false);
		});
	});

	describe("EventCollector", () => {
		test("initializes with default maxIterations", () => {
			const collector = new EventCollector();
			expect(collector).toBeDefined();
		});

		test("initializes with custom maxIterations", () => {
			const collector = new EventCollector({ maxIterations: 10 });
			expect(collector).toBeDefined();
		});

		test("initializes with onMaxIterations callback", () => {
			const onMax = mock(() => {});
			const collector = new EventCollector({ maxIterations: 5, onMaxIterations: onMax });
			expect(collector).toBeDefined();
		});

		test("initializes with onImmediate callback", () => {
			const onImmediate = mock(() => {});
			const collector = new EventCollector({ onImmediate });
			expect(collector).toBeDefined();
		});

		test("handles turn_end event and increments turnCount", () => {
			const collector = new EventCollector({ maxIterations: 5 });
			const event: AgentEvent = {
				type: "turn_end",
				turnIndex: 0,
			} as AgentEvent;
			collector.handleEvent(event);
			const result = collector.toResult();
			expect(result.turnCount).toBe(1);
		});

		test("handles multiple turn_end events", () => {
			const collector = new EventCollector({ maxIterations: 10 });
			collector.handleEvent({ type: "turn_end", turnIndex: 0 } as AgentEvent);
			collector.handleEvent({ type: "turn_end", turnIndex: 1 } as AgentEvent);
			collector.handleEvent({ type: "turn_end", turnIndex: 2 } as AgentEvent);
			const result = collector.toResult();
			expect(result.turnCount).toBe(3);
		});

		test("calls onMaxIterations when max iterations reached", () => {
			const onMax = mock(() => {});
			const collector = new EventCollector({ maxIterations: 2, onMaxIterations: onMax });
			collector.handleEvent({ type: "turn_end", turnIndex: 0 } as AgentEvent);
			collector.handleEvent({ type: "turn_end", turnIndex: 1 } as AgentEvent);
			expect(onMax).toHaveBeenCalledTimes(1);
		});

		test("sets aborted when max iterations reached", () => {
			const collector = new EventCollector({ maxIterations: 1 });
			collector.handleEvent({ type: "turn_end", turnIndex: 0 } as AgentEvent);
			const result = collector.toResult();
			expect(result.aborted).toBe(true);
		});

		test("handles message_end event and collects text", () => {
			const collector = new EventCollector();
			const message: AgentMessage = {
				role: "assistant",
				content: [{ type: "text" as const, text: "Hello world" }],
			};
			collector.handleEvent({ type: "message_end", message } as AgentEvent);
			const result = collector.toResult();
			expect(result.output).toBe("Hello world");
		});

		test("handles multiple message_end events", () => {
			const collector = new EventCollector();
			collector.handleEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text" as const, text: "First" }] },
			} as AgentEvent);
			collector.handleEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text" as const, text: "Second" }] },
			} as AgentEvent);
			const result = collector.toResult();
			expect(result.output).toBe("First\nSecond");
		});

		test("ignores non-text content in message_end", () => {
			const collector = new EventCollector();
			const message: AgentMessage = {
				role: "assistant",
				content: [
					{ type: "text" as const, text: "Hello" },
					{ type: "image" as const, source: { url: "http://example.com" } },
					{ type: "text" as const, text: "World" },
				],
			};
			collector.handleEvent({ type: "message_end", message } as AgentEvent);
			const result = collector.toResult();
			expect(result.output).toBe("Hello\nWorld");
		});

		test("handles tool_execution_end event", () => {
			const collector = new EventCollector();
			const event: AgentEvent = {
				type: "tool_execution_end",
				toolCallId: "call-123",
				toolName: "bash",
				isError: false,
			} as AgentEvent;
			collector.handleEvent(event);
			const result = collector.toResult();
			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0].toolCallId).toBe("call-123");
			expect(result.toolCalls[0].toolName).toBe("bash");
			expect(result.toolCalls[0].isError).toBe(false);
		});

		test("handles tool_execution_end with error", () => {
			const collector = new EventCollector();
			collector.handleEvent({
				type: "tool_execution_end",
				toolCallId: "call-456",
				toolName: "read_file",
				isError: true,
			} as AgentEvent);
			const result = collector.toResult();
			expect(result.toolCalls[0].isError).toBe(true);
		});

		test("handles agent_end event and collects messages", () => {
			const collector = new EventCollector();
			const messages: AgentMessage[] = [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: [{ type: "text" as const, text: "Hi" }] },
			];
			collector.handleEvent({ type: "agent_end", messages } as AgentEvent);
			const result = collector.toResult();
			expect(result.messages).toEqual(messages);
		});

		test("ignores agent_start event", () => {
			const collector = new EventCollector();
			collector.handleEvent({ type: "agent_start" } as AgentEvent);
			const result = collector.toResult();
			expect(result.turnCount).toBe(0);
			expect(result.output).toBe("");
		});

		test("ignores turn_start event", () => {
			const collector = new EventCollector();
			collector.handleEvent({ type: "turn_start", turnIndex: 0 } as AgentEvent);
			const result = collector.toResult();
			expect(result.turnCount).toBe(0);
		});

		test("ignores message_start event", () => {
			const collector = new EventCollector();
			collector.handleEvent({ type: "message_start" } as AgentEvent);
			const result = collector.toResult();
			expect(result.output).toBe("");
		});

		test("ignores tool_execution_start event", () => {
			const collector = new EventCollector();
			collector.handleEvent({
				type: "tool_execution_start",
				toolCallId: "call-123",
				toolName: "bash",
			} as AgentEvent);
			const result = collector.toResult();
			expect(result.toolCalls).toHaveLength(0);
		});

		test("calls onImmediate callback for each event", () => {
			const onImmediate = mock(() => {});
			const collector = new EventCollector({ onImmediate });
			collector.handleEvent({ type: "agent_start" } as AgentEvent);
			collector.handleEvent({ type: "turn_start", turnIndex: 0 } as AgentEvent);
			expect(onImmediate).toHaveBeenCalledTimes(2);
		});

		test("toResult returns correct structure", () => {
			const collector = new EventCollector();
			collector.handleEvent({ type: "turn_end", turnIndex: 0 } as AgentEvent);
			collector.handleEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text" as const, text: "Output" }] },
			} as AgentEvent);
			collector.handleEvent({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "test",
				isError: false,
			} as AgentEvent);
			const result = collector.toResult();
			expect(result).toHaveProperty("output");
			expect(result).toHaveProperty("turnCount");
			expect(result).toHaveProperty("aborted");
			expect(result).toHaveProperty("toolCalls");
			expect(result).toHaveProperty("messages");
		});
	});
});
