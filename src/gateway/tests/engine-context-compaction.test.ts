import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	type CompactionConfig,
	compactMessages,
	compactMessagesSync,
	needsCompaction,
} from "@/gateway/engine/context-compaction";

describe("context-compaction", () => {
	describe("needsCompaction", () => {
		test("returns false when message count below threshold", () => {
			const result = needsCompaction(50, 100, 0.8);
			expect(result).toBe(false);
		});

		test("returns true when message count exceeds threshold", () => {
			const result = needsCompaction(90, 100, 0.8);
			expect(result).toBe(true);
		});

		test("returns true when at exact threshold (uses >=)", () => {
			// Implementation uses >= so at threshold returns true
			const result = needsCompaction(80, 100, 0.8);
			expect(result).toBe(true);
		});

		test("returns true when at threshold with different values", () => {
			// Implementation uses >= so at threshold returns true
			const result = needsCompaction(150, 200, 0.75);
			expect(result).toBe(true);
		});

		test("returns true when above threshold with different values", () => {
			const result = needsCompaction(160, 200, 0.75);
			expect(result).toBe(true);
		});

		test("returns true when maxMessages is zero", () => {
			// Any message with 0 maxMessages triggers compaction
			const result = needsCompaction(10, 0, 0.8);
			expect(result).toBe(true);
		});
	});

	describe("compactMessagesSync", () => {
		const createMessages = (count: number) => {
			return Array.from({ length: count }, (_, i) => ({
				role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: `Message ${i}`,
			}));
		};

		test("returns original messages when no compaction needed", () => {
			const messages = createMessages(50);
			const result = compactMessagesSync(messages, 100, 20);
			expect(result).toEqual(messages);
		});

		test("prunes to maxMessages when exceeding limit", () => {
			const messages = createMessages(150);
			const result = compactMessagesSync(messages, 100, 20);
			expect(result.length).toBeLessThanOrEqual(100);
		});

		test("preserves recent messages", () => {
			const messages = createMessages(150);
			const result = compactMessagesSync(messages, 100, 30);
			// Should preserve at least 30 recent messages
			expect(result.length).toBeGreaterThanOrEqual(30);
		});

		test("handles empty message array", () => {
			const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
			const result = compactMessagesSync(messages, 100, 20);
			expect(result).toEqual([]);
		});

		test("handles messages fewer than preserveRecent", () => {
			const messages = createMessages(5);
			const result = compactMessagesSync(messages, 100, 20);
			expect(result).toEqual(messages);
		});

		test("system messages are preserved at the start", () => {
			const messages = [{ role: "system" as const, content: "System prompt" }, ...createMessages(150)];
			const result = compactMessagesSync(messages, 100, 20);
			expect(result[0].role).toBe("system");
			expect(result[0].content).toBe("System prompt");
		});

		test("compactMessages with system messages - non-system <= preserveRecent", async () => {
			const messages = [
				{ role: "system" as const, content: "System prompt" },
				...createMessages(15), // 15 non-system
			];
			const config: CompactionConfig = { enabled: true, threshold: 0.5, preserveRecent: 20 };
			const summarizeFn = async (_text: string) => "Summary";

			const result = await compactMessages(messages, config, summarizeFn);
			// Non-system messages (15) <= preserveRecent (20), so no compaction
			expect(result.messages.length).toBe(16);
			expect(result.result.messagesDropped).toBe(0);
		});

		test("compactMessages with system messages - compaction needed", async () => {
			const messages = [
				{ role: "system" as const, content: "System prompt" },
				...createMessages(100), // 100 non-system
			];
			const config: CompactionConfig = { enabled: true, threshold: 0.5, preserveRecent: 20 };
			const summarizeFn = async (_text: string) => "Summary of conversation";

			const result = await compactMessages(messages, config, summarizeFn);
			// Should have: 1 system + 1 summary + 20 recent = 22
			expect(result.messages.length).toBe(22);
			expect(result.messages[0].role).toBe("system");
		});

		test("compactMessages handles summarization error fallback", async () => {
			const messages = createMessages(60);
			const config: CompactionConfig = { enabled: true, threshold: 0.5, preserveRecent: 10 };
			const summarizeFn = async (_text: string) => {
				throw new Error("Summarization failed");
			};

			const result = await compactMessages(messages, config, summarizeFn);
			// Should fallback to sync compaction
			expect(result.messages.length).toBeLessThan(60);
			expect(result.result.summaryLength).toBe(0);
		});

		test("compactMessages extracts text from user messages with array content", async () => {
			const messages = [
				{ role: "user" as const, content: [{ type: "text" as const, text: "Hello world" }] },
				{ role: "assistant" as const, content: [{ type: "text" as const, text: "Hi there" }] },
			];
			const config: CompactionConfig = { enabled: true, threshold: 0.5, preserveRecent: 1 };
			const summarizeFn = async (text: string) => {
				// Check that text extraction includes user message with array content
				expect(text).toContain("[User]:");
				return "Summary";
			};

			await compactMessages(messages, config, summarizeFn);
		});

		test("compactMessages extracts text from tool_result messages", async () => {
			const messages = [
				{ role: "tool_result" as const, content: "Tool output here", toolName: "bash" },
				{ role: "assistant" as const, content: [{ type: "text" as const, text: "Used tool" }] },
			];
			const config: CompactionConfig = { enabled: true, threshold: 0.5, preserveRecent: 1 };
			const summarizeFn = async (text: string) => {
				expect(text).toContain("[Tool Result");
				return "Summary";
			};

			await compactMessages(messages, config, summarizeFn);
		});

		test("compactMessages handles tool_result with array content", async () => {
			const messages = [
				{
					role: "tool_result" as const,
					content: [
						{ type: "text" as const, text: "Output line 1" },
						{ type: "text" as const, text: "Output line 2" },
					],
					toolName: "read_file",
				},
			];
			const config: CompactionConfig = { enabled: true, threshold: 0.1, preserveRecent: 0 };
			const summarizeFn = async (text: string) => {
				expect(text).toContain("[Tool Result (read_file)]:");
				return "Summary";
			};

			await compactMessages(messages, config, summarizeFn);
		});

		test("compactMessages truncates long tool results", async () => {
			const longOutput = "x".repeat(600);
			const messages = [{ role: "tool_result" as const, content: longOutput, toolName: "bash" }];
			const config: CompactionConfig = { enabled: true, threshold: 0.1, preserveRecent: 0 };
			const summarizeFn = async (text: string) => {
				// Should be truncated to ~500 chars
				expect(text.length).toBeLessThan(600);
				expect(text).toContain("[truncated]");
				return "Summary";
			};

			await compactMessages(messages, config, summarizeFn);
		});

		test("compactMessages handles null/undefined messages gracefully", async () => {
			const messages: (AgentMessage | null | undefined)[] = [
				null,
				undefined,
				{ role: "user" as const, content: "valid" },
			];
			const config: CompactionConfig = { enabled: true, threshold: 0.5, preserveRecent: 1 };
			const summarizeFn = async (_text: string) => "Summary";

			const result = await compactMessages(messages, config, summarizeFn);
			// Should not crash, just skip invalid messages
			expect(result.messages).toBeDefined();
		});

		test("compactMessages extracts text from assistant messages with array content during compaction", async () => {
			// Create enough messages to trigger compaction
			const messages = [
				{ role: "assistant" as const, content: [{ type: "text" as const, text: "Response 1" }] },
				{ role: "assistant" as const, content: [{ type: "text" as const, text: "Response 2" }] },
				{ role: "assistant" as const, content: [{ type: "text" as const, text: "Response 3" }] },
				{ role: "assistant" as const, content: [{ type: "text" as const, text: "Response 4" }] },
				{ role: "user" as const, content: [{ type: "text" as const, text: "Question" }] },
			];
			// Use low threshold to ensure compaction happens
			const config: CompactionConfig = { enabled: true, threshold: 0.3, preserveRecent: 1 };
			const summarizeFn = async (text: string) => {
				// Should extract text from assistant messages with array content
				expect(text).toContain("[Assistant]:");
				return "Summary";
			};

			await compactMessages(messages, config, summarizeFn);
		});

		test("needsCompaction with default threshold", () => {
			// Default threshold is 0.8
			expect(needsCompaction(80, 100)).toBe(true);
			expect(needsCompaction(79, 100)).toBe(false);
		});
	});

	describe("compactMessagesSync", () => {
		const createMessages = (count: number) => {
			return Array.from({ length: count }, (_, i) => ({
				role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: `Message ${i}`,
			}));
		};

		test("returns original when no compaction needed", async () => {
			// Use preserveRecent >= message count to skip compaction
			const messages = createMessages(10);
			const config: CompactionConfig = { enabled: true, threshold: 0.8, preserveRecent: 20 };
			const summarizeFn = async (text: string) => `Summary of ${text.slice(0, 20)}`;

			const result = await compactMessages(messages, config, summarizeFn);
			expect(result.messages.length).toBe(10);
		});

		test("compacts when threshold exceeded", async () => {
			const messages = createMessages(150);
			const config: CompactionConfig = { enabled: true, threshold: 0.8, preserveRecent: 20 };
			const summarizeFn = async (text: string) => `Summary: ${text.slice(0, 30)}`;

			const result = await compactMessages(messages, config, summarizeFn);
			expect(result.messages.length).toBeLessThan(messages.length);
			expect(result.result.originalCount).toBe(150);
			expect(result.result.compactedCount).toBeLessThan(150);
		});

		test("handles disabled compaction config", async () => {
			const messages = createMessages(150);
			const config: CompactionConfig = { enabled: false, threshold: 0.8, preserveRecent: 20 };
			const summarizeFn = async (text: string) => `Summary: ${text}`;

			const result = await compactMessages(messages, config, summarizeFn);
			// When disabled, returns all messages unchanged
			expect(result.messages.length).toBe(150);
		});

		test("returns summary statistics", async () => {
			const messages = createMessages(100);
			const config: CompactionConfig = { enabled: true, threshold: 0.5, preserveRecent: 10 };
			const summarizeFn = async (_text: string) => "Summarized content";

			const result = await compactMessages(messages, config, summarizeFn);
			expect(result.result.originalCount).toBe(100);
			expect(result.result.messagesDropped).toBeGreaterThan(0);
			expect(result.result.summaryLength).toBeGreaterThan(0);
		});

		test("preserves recent messages count", async () => {
			const messages = createMessages(100);
			const config: CompactionConfig = { enabled: true, threshold: 0.5, preserveRecent: 15 };
			const summarizeFn = async (_text: string) => "Summary";

			const result = await compactMessages(messages, config, summarizeFn);
			// The last preserveRecent messages should be preserved
			expect(result.messages.length).toBeGreaterThanOrEqual(15);
		});

		test("handles empty messages", async () => {
			const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
			const config: CompactionConfig = { enabled: true, threshold: 0.8, preserveRecent: 20 };
			const summarizeFn = async (_text: string) => "Summary";

			const result = await compactMessages(messages, config, summarizeFn);
			expect(result.messages).toEqual([]);
		});

		test("handles summarize function error gracefully", async () => {
			const messages = createMessages(60);
			const config: CompactionConfig = { enabled: true, threshold: 0.5, preserveRecent: 10 };
			const summarizeFn = async (_text: string) => {
				throw new Error("Summarization failed");
			};

			// Should not throw, should fallback to sync compaction
			const result = await compactMessages(messages, config, summarizeFn);
			expect(result.messages).toBeDefined();
		});
	});
});
