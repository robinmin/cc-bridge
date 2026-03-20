/**
 * Event Bridge - AgentEvent to ExecutionResult Collector
 *
 * Subscribes to pi-agent-core AgentEvent stream and collects results
 * into the ExecutionResult shape expected by the execution engine layer.
 * Also provides a maxIterations guard via turn_end counting.
 */

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import { logger } from "@/packages/logger";
import {
	type AgentRunObservability,
	type AgentUsageSnapshot,
	accumulateUsage,
	cloneUsageSnapshot,
} from "./observability";

/**
 * Collected result from an agent run
 */
export interface AgentResult {
	/** Final text output concatenated from all assistant messages */
	output: string;
	/** Number of turns (LLM call + tool execution rounds) completed */
	turnCount: number;
	/** Whether the agent was aborted (timeout or maxIterations) */
	aborted: boolean;
	/** Tool calls that were executed during the run */
	toolCalls: ToolCallRecord[];
	/** Final messages from the agent */
	messages: AgentMessage[];
	/** Per-run observability snapshot */
	observability?: AgentRunObservability;
}

/**
 * Record of a tool call execution
 */
export interface ToolCallRecord {
	toolCallId: string;
	toolName: string;
	isError: boolean;
}

/**
 * Check if a content block is a text block.
 * Exported as isTextContentBlock for external consumers.
 */
export function isTextContentBlock(block: unknown): block is TextContent {
	return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
}

/** @internal Alias used within this module */
const isTextContent = isTextContentBlock;

/**
 * Extract text from an AgentMessage (assistant messages only)
 */
function extractTextFromMessage(message: AgentMessage): string {
	if (!message || typeof message !== "object") return "";
	if (!("role" in message) || message.role !== "assistant") return "";
	if (!("content" in message) || !Array.isArray(message.content)) return "";

	return message.content
		.filter(isTextContent)
		.map((block) => block.text.trim())
		.filter(Boolean)
		.join("\n");
}

/**
 * Collects AgentEvent emissions into an AgentResult.
 *
 * Usage:
 *   const collector = new EventCollector({ maxIterations: 50, onMaxIterations: () => agent.abort() });
 *   const unsub = agent.subscribe((event) => {
 *     collector.handleEvent(event);
 *     onEvent?.(event);
 *   });
 *   await agent.prompt(message);
 *   unsub();
 *   return collector.toResult();
 *
 * Streaming mode:
 *   const collector = new EventCollector({
 *     maxIterations: 50,
 *     onImmediate: (event) => { /* handle immediately for streaming /* }
 *   });
 */
export class EventCollector {
	private turnCount = 0;
	private aborted = false;
	private toolCalls: ToolCallRecord[] = [];
	private finalMessages: AgentMessage[] = [];
	private textParts: string[] = [];
	private usageTotals: AgentUsageSnapshot = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};

	private readonly maxIterations: number;
	private readonly onMaxIterations?: () => void;
	private readonly onImmediate?: (event: AgentEvent) => void;

	constructor(options?: {
		maxIterations?: number;
		onMaxIterations?: () => void;
		onImmediate?: (event: AgentEvent) => void;
	}) {
		this.maxIterations = options?.maxIterations ?? 50;
		this.onMaxIterations = options?.onMaxIterations;
		this.onImmediate = options?.onImmediate;
	}

	/**
	 * Handle a single AgentEvent. Call this from the agent.subscribe() callback.
	 * If onImmediate is configured, also fire it for streaming events.
	 */
	handleEvent(event: AgentEvent): void {
		// Fire onImmediate callback for streaming events (non-blocking)
		if (this.onImmediate) {
			try {
				this.onImmediate(event);
			} catch (error) {
				// Log but don't let streaming errors break agent execution
				logger.error({ error }, "Streaming callback error");
			}
		}

		switch (event.type) {
			case "turn_end": {
				this.turnCount++;
				if (this.turnCount >= this.maxIterations) {
					this.aborted = true;
					this.onMaxIterations?.();
				}
				break;
			}

			case "message_end": {
				const text = extractTextFromMessage(event.message);
				if (text) {
					this.textParts.push(text);
				}
				if (event.message.role === "assistant") {
					accumulateUsage(this.usageTotals, (event.message as AssistantMessage).usage);
				}
				break;
			}

			case "tool_execution_end": {
				this.toolCalls.push({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
				});
				break;
			}

			case "agent_end": {
				this.finalMessages = event.messages;
				break;
			}

			// agent_start, turn_start, message_start, message_update,
			// tool_execution_start, tool_execution_update: no collection needed
		}
	}

	/**
	 * Build the final AgentResult from collected events.
	 * Call after agent.prompt() resolves.
	 */
	toResult(): AgentResult {
		return {
			output: this.textParts.join("\n"),
			turnCount: this.turnCount,
			aborted: this.aborted,
			toolCalls: this.toolCalls,
			messages: this.finalMessages,
		};
	}

	getUsageTotals(): AgentUsageSnapshot {
		return cloneUsageSnapshot(this.usageTotals);
	}

	attachObservability(run: AgentRunObservability): AgentResult {
		return {
			...this.toResult(),
			observability: run,
		};
	}
}
