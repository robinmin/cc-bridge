/**
 * Memory Compaction Orchestrator
 *
 * Coordinates token threshold detection, LLM summarization, and memory consolidation.
 * Follows pi-mono's approach.
 */

import { getDailyLogDate, getMemoryPaths, upsertMemory } from "./storage";
import { createSummarizer, type SessionMessage } from "./summarizer";
import { countTokens, DEFAULT_COMPACTION_SETTINGS, getCompactionAmount, shouldCompact } from "./token-counter";
import type { CompactionResult, CompactionSettings, CompactionTrigger, SessionSummary } from "./types";

/**
 * Memory Compaction Orchestrator
 */
export class MemoryCompactor {
	private settings: CompactionSettings;
	private summarizer: ReturnType<typeof createSummarizer>;
	private lastSummary: SessionSummary | null = null;

	constructor(settings?: Partial<CompactionSettings>) {
		this.settings = { ...DEFAULT_COMPACTION_SETTINGS, ...settings };
		this.summarizer = createSummarizer();
	}

	/**
	 * Get current settings
	 */
	getSettings(): CompactionSettings {
		return { ...this.settings };
	}

	/**
	 * Update settings
	 */
	setSettings(settings: Partial<CompactionSettings>): void {
		this.settings = { ...this.settings, ...settings };
	}

	/**
	 * Check if should compact
	 */
	checkShouldCompact(currentTokens: number, contextWindow: number): boolean {
		return shouldCompact(currentTokens, contextWindow, this.settings);
	}

	/**
	 * Run compaction
	 */
	async compact(
		trigger: CompactionTrigger,
		messages: SessionMessage[],
		workspaceRoot: string,
	): Promise<CompactionResult> {
		if (!this.settings.enabled) {
			return {
				ok: false,
				reason: "compaction disabled",
				previousTokens: 0,
				newTokens: 0,
			};
		}

		try {
			// Calculate current tokens
			const content = messages.map((m) => m.content).join("\n");
			const previousTokens = countTokens(content);

			// Get compaction amount
			const contextWindow = this.settings.reserveTokens + this.settings.keepRecentTokens;
			const excessTokens = getCompactionAmount(previousTokens, contextWindow, this.settings);

			if (excessTokens <= 0) {
				return {
					ok: false,
					reason: "no excess tokens",
					previousTokens,
					newTokens: previousTokens,
				};
			}

			// Generate summary
			let summary: SessionSummary;

			if (this.lastSummary) {
				// Update existing summary with new messages
				summary = await this.summarizer.updateSummary(this.lastSummary, messages);
			} else {
				// Generate new summary
				summary = await this.summarizer.summarize(messages);
			}

			// Write summary to memory
			await this.writeSummaryToMemory(summary, workspaceRoot);

			// Calculate new tokens
			const summaryText = this.formatSummaryForMemory(summary);
			const newTokens = countTokens(summaryText);

			// Store last summary
			this.lastSummary = summary;

			return {
				ok: true,
				summary,
				previousTokens,
				newTokens,
				reason: trigger.reason,
			};
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : "compaction failed",
				previousTokens: 0,
				newTokens: 0,
			};
		}
	}

	/**
	 * Write summary to memory (long-term storage)
	 */
	private async writeSummaryToMemory(summary: SessionSummary, workspaceRoot: string): Promise<void> {
		const _paths = getMemoryPaths(workspaceRoot);

		// Format summary as markdown
		const memoryEntry = this.formatSummaryForMemory(summary);

		// Write to memory.md (long-term)
		await upsertMemory(workspaceRoot, memoryEntry);

		// Also write to today's daily log for reference
		const today = getDailyLogDate();
		const { appendDailyLog } = await import("./daily-log");
		await appendDailyLog(workspaceRoot, `## Compaction Summary\n${memoryEntry}`, today);
	}

	/**
	 * Format summary for memory storage
	 */
	private formatSummaryForMemory(summary: SessionSummary): string {
		let text = "## Session Summary\n\n";

		if (summary.goal) {
			text += `**Goal**: ${summary.goal}\n\n`;
		}

		if (summary.constraints.length > 0) {
			text += "**Constraints**:\n";
			for (const c of summary.constraints) {
				text += `- ${c}\n`;
			}
			text += "\n";
		}

		if (summary.progress.done.length > 0) {
			text += "**Completed**:\n";
			for (const d of summary.progress.done) {
				text += `- [x] ${d}\n`;
			}
			text += "\n";
		}

		if (summary.progress.inProgress.length > 0) {
			text += "**In Progress**:\n";
			for (const d of summary.progress.inProgress) {
				text += `- [ ] ${d}\n`;
			}
			text += "\n";
		}

		if (summary.keyDecisions.length > 0) {
			text += "**Decisions**:\n";
			for (const d of summary.keyDecisions) {
				text += `- **${d.decision}**: ${d.rationale}\n`;
			}
			text += "\n";
		}

		if (summary.nextSteps.length > 0) {
			text += "**Next Steps**:\n";
			for (let i = 0; i < summary.nextSteps.length; i++) {
				text += `${i + 1}. ${summary.nextSteps[i]}\n`;
			}
			text += "\n";
		}

		if (summary.criticalContext.length > 0) {
			text += "**Critical Context**:\n";
			for (const c of summary.criticalContext) {
				text += `- ${c}\n`;
			}
		}

		return text;
	}

	/**
	 * Get the last summary
	 */
	getLastSummary(): SessionSummary | null {
		return this.lastSummary;
	}

	/**
	 * Clear the last summary (for testing)
	 */
	clearLastSummary(): void {
		this.lastSummary = null;
	}
}

/**
 * Create a memory compactor
 */
export function createMemoryCompactor(settings?: Partial<CompactionSettings>): MemoryCompactor {
	return new MemoryCompactor(settings);
}
