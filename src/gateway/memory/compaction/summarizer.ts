/**
 * LLM Summarizer
 *
 * Generates structured summaries using LLM.
 * Follows pi-mono's summary format.
 */

import type { SessionSummary } from "./types";

/**
 * Summarizer configuration
 */
export interface SummarizerConfig {
	apiKey?: string;
	model?: string;
	baseUrl?: string;
}

/**
 * LLM Summarizer Interface
 */
export interface Summarizer {
	/**
	 * Generate a summary from session messages
	 */
	summarize(messages: SessionMessage[]): Promise<SessionSummary>;

	/**
	 * Update an existing summary with new messages
	 */
	updateSummary(existingSummary: SessionSummary, newMessages: SessionMessage[]): Promise<SessionSummary>;
}

/**
 * Session message for summarization
 */
export interface SessionMessage {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp?: string;
}

/**
 * Default summary format prompt
 */
const SUMMARY_FORMAT = `Generate a summary of the conversation in this exact format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints mentioned]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list]

## Critical Context
- [Data needed to continue]

## File Operations (for reference)
Track what files were read, written, or modified during this session.`;

const UPDATE_SUMMARY_FORMAT = `Given an existing summary and new messages since that summary, update the summary. Keep all existing information that is still relevant. Format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints mentioned]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list]

## Critical Context
- [Data needed to continue]

## File Operations (for reference)
Track what files were read, written, or modified during this session.

Previous summary:
{{existingSummary}}

New messages:
{{newMessages}}`;

/**
 * Parse LLM response into SessionSummary
 */
export function parseSummaryResponse(response: string): SessionSummary {
	const summary: SessionSummary = {
		goal: "",
		constraints: [],
		progress: {
			done: [],
			inProgress: [],
			blocked: [],
		},
		keyDecisions: [],
		nextSteps: [],
		criticalContext: [],
		fileOperations: {
			read: [],
			written: [],
			modified: [],
		},
	};

	// Parse goal
	const goalMatch = response.match(/## Goal\s*\n([^\n]+)/);
	if (goalMatch) {
		summary.goal = goalMatch[1].trim();
	}

	// Parse constraints
	const constraintsMatch = response.match(/## Constraints & Preferences\s*\n([\s\S]*?)(?=##|$)/);
	if (constraintsMatch) {
		summary.constraints = constraintsMatch[1]
			.split("\n")
			.filter((l) => l.trim().startsWith("-"))
			.map((l) => l.replace(/^-\s*/, "").trim());
	}

	// Parse done
	const doneMatch = response.match(/### Done\s*\n([\s\S]*?)(?=###|$)/);
	if (doneMatch) {
		summary.progress.done = doneMatch[1]
			.split("\n")
			.filter((l) => l.trim().startsWith("-"))
			.map((l) => l.replace(/^-\s*\[x\]\s*/, "").trim());
	}

	// Parse in progress
	const inProgressMatch = response.match(/### In Progress\s*\n([\s\S]*?)(?=###|$)/);
	if (inProgressMatch) {
		summary.progress.inProgress = inProgressMatch[1]
			.split("\n")
			.filter((l) => l.trim().startsWith("-"))
			.map((l) => l.replace(/^-\s*\[\]\s*/, "").trim());
	}

	// Parse blocked
	const blockedMatch = response.match(/### Blocked\s*\n([\s\S]*?)(?=##|$)/);
	if (blockedMatch) {
		summary.progress.blocked = blockedMatch[1]
			.split("\n")
			.filter((l) => l.trim().startsWith("-"))
			.map((l) => l.replace(/^-\s*/, "").trim());
	}

	// Parse key decisions
	const decisionsMatch = response.match(/## Key Decisions\s*\n([\s\S]*?)(?=##|$)/);
	if (decisionsMatch) {
		summary.keyDecisions = decisionsMatch[1]
			.split("\n")
			.filter((l) => l.trim().startsWith("-"))
			.map((l) => {
				const cleaned = l.replace(/^-\s*/, "").trim();
				const match = cleaned.match(/\[(.*?)\]:\s*(.*)/);
				if (match) {
					return { decision: match[1].trim(), rationale: match[2].trim() };
				}
				return { decision: cleaned, rationale: "" };
			});
	}

	// Parse next steps
	const nextStepsMatch = response.match(/## Next Steps\s*\n([\s\S]*?)(?=##|$)/);
	if (nextStepsMatch) {
		summary.nextSteps = nextStepsMatch[1]
			.split("\n")
			.filter((l) => /^\d+\./.test(l.trim()))
			.map((l) => l.replace(/^\d+\.\s*/, "").trim());
	}

	// Parse critical context
	const contextMatch = response.match(/## Critical Context\s*\n([\s\S]*?)(?=##|$)/);
	if (contextMatch) {
		summary.criticalContext = contextMatch[1]
			.split("\n")
			.filter((l) => l.trim().startsWith("-"))
			.map((l) => l.replace(/^-\s*/, "").trim());
	}

	return summary;
}

/**
 * OpenAI-based summarizer
 */
export class OpenAISummarizer implements Summarizer {
	private apiKey: string;
	private model: string;
	private baseUrl: string;

	constructor(config: SummarizerConfig) {
		this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
		this.model = config.model ?? "gpt-4o-mini";
		this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
	}

	async summarize(messages: SessionMessage[]): Promise<SessionSummary> {
		if (!this.apiKey) {
			throw new Error("OpenAI API key not configured");
		}

		const content = messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");

		const prompt = `${SUMMARY_FORMAT}\n\nConversation to summarize:\n${content}`;

		const response = await this.callLLM(prompt);
		return parseSummaryResponse(response);
	}

	async updateSummary(existingSummary: SessionSummary, newMessages: SessionMessage[]): Promise<SessionSummary> {
		if (!this.apiKey) {
			throw new Error("OpenAI API key not configured");
		}

		const summaryText = this.formatSummary(existingSummary);
		const newContent = newMessages.map((m) => `${m.role}: ${m.content}`).join("\n\n");

		const prompt = `${UPDATE_SUMMARY_FORMAT.replace("{{existingSummary}}", summaryText).replace(
			"{{newMessages}}",
			newContent,
		)}`;

		const response = await this.callLLM(prompt);
		return parseSummaryResponse(response);
	}

	private async callLLM(prompt: string): Promise<string> {
		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0.3,
			}),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`OpenAI summarization error: ${error}`);
		}

		const data = (await response.json()) as {
			choices: Array<{ message: { content: string } }>;
		};

		return data.choices[0]?.message?.content ?? "";
	}

	private formatSummary(summary: SessionSummary): string {
		let text = `## Goal\n${summary.goal}\n\n`;
		text += "## Constraints & Preferences\n";
		for (const c of summary.constraints) {
			text += `- ${c}\n`;
		}
		text += "\n## Progress\n### Done\n";
		for (const d of summary.progress.done) {
			text += `- [x] ${d}\n`;
		}
		text += "### In Progress\n";
		for (const d of summary.progress.inProgress) {
			text += `- [ ] ${d}\n`;
		}
		text += "### Blocked\n";
		for (const d of summary.progress.blocked) {
			text += `- ${d}\n`;
		}
		text += "## Key Decisions\n";
		for (const d of summary.keyDecisions) {
			text += `- **${d.decision}**: ${d.rationale}\n`;
		}
		text += "## Next Steps\n";
		for (let i = 0; i < summary.nextSteps.length; i++) {
			text += `${i + 1}. ${summary.nextSteps[i]}\n`;
		}
		text += "## Critical Context\n";
		for (const c of summary.criticalContext) {
			text += `- ${c}\n`;
		}
		return text;
	}
}

/**
 * Create a summarizer
 */
export function createSummarizer(config?: SummarizerConfig): Summarizer {
	return new OpenAISummarizer(config ?? {});
}
