import { BuiltinMemoryBackend } from "@/gateway/memory/backend-builtin";
import { ExternalMemoryBackend, StubExternalProvider } from "@/gateway/memory/backend-external";
import { NoneMemoryBackend } from "@/gateway/memory/backend-none";
import type { MemoryBackend, MemoryConfig, MemorySlot } from "@/gateway/memory/contracts";
import { getMemoryLoadDecision } from "@/gateway/memory/policy";

const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
	slot: "none",
	citations: "auto",
	loadPolicy: {
		groupLoadLongTerm: false,
	},
	flush: {
		enabled: true,
		softThresholdTokens: 4000,
	},
	builtin: {
		index: {
			enabled: true,
		},
	},
};

function asCitation(value: unknown): MemoryConfig["citations"] | null {
	if (value === "auto" || value === "on" || value === "off") {
		return value;
	}
	return null;
}

function asSlot(value: unknown): MemorySlot | null {
	if (value === "builtin" || value === "none" || value === "external") {
		return value;
	}
	return null;
}

export function resolveMemoryConfig(raw: unknown): MemoryConfig {
	if (!raw || typeof raw !== "object") {
		return DEFAULT_MEMORY_CONFIG;
	}
	const input = raw as {
		slot?: unknown;
		citations?: unknown;
		loadPolicy?: { groupLoadLongTerm?: unknown };
		flush?: { enabled?: unknown; softThresholdTokens?: unknown };
		builtin?: { index?: { enabled?: unknown } };
		external?: { provider?: unknown };
	};
	const maybeSlot = asSlot(input.slot);
	const maybeCitations = asCitation(input.citations);
	const groupLoadLongTerm =
		typeof input.loadPolicy?.groupLoadLongTerm === "boolean"
			? input.loadPolicy.groupLoadLongTerm
			: DEFAULT_MEMORY_CONFIG.loadPolicy.groupLoadLongTerm;
	const flushEnabled =
		typeof input.flush?.enabled === "boolean" ? input.flush.enabled : DEFAULT_MEMORY_CONFIG.flush.enabled;
	const softThresholdTokens =
		typeof input.flush?.softThresholdTokens === "number" && Number.isFinite(input.flush.softThresholdTokens)
			? input.flush.softThresholdTokens
			: DEFAULT_MEMORY_CONFIG.flush.softThresholdTokens;
	const builtinIndexEnabled =
		typeof input.builtin?.index?.enabled === "boolean"
			? input.builtin.index.enabled
			: DEFAULT_MEMORY_CONFIG.builtin.index.enabled;
	const externalProvider =
		typeof input.external?.provider === "string" && input.external.provider.trim()
			? input.external.provider
			: undefined;

	return {
		slot: maybeSlot ?? DEFAULT_MEMORY_CONFIG.slot,
		citations: maybeCitations ?? DEFAULT_MEMORY_CONFIG.citations,
		loadPolicy: { groupLoadLongTerm },
		flush: {
			enabled: flushEnabled,
			softThresholdTokens,
		},
		builtin: {
			index: {
				enabled: builtinIndexEnabled,
			},
		},
		external: externalProvider ? { provider: externalProvider } : undefined,
	};
}

export function createMemoryBackend(config: MemoryConfig, workspaceRoot: string): MemoryBackend {
	switch (config.slot) {
		case "builtin":
			return new BuiltinMemoryBackend(workspaceRoot);
		case "external":
			return new ExternalMemoryBackend(new StubExternalProvider(), workspaceRoot);
		default:
			return new NoneMemoryBackend();
	}
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function dayFilePath(date: Date): string {
	const yyyy = String(date.getFullYear());
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `.memory/daily/${yyyy}-${mm}-${dd}.md`;
}

export async function buildMemoryBootstrapContext(params: {
	config: MemoryConfig;
	workspaceRoot: string;
	isGroupContext: boolean;
	maxSectionChars?: number;
}): Promise<string> {
	const backend = createMemoryBackend(params.config, params.workspaceRoot);
	if (!backend.status().available) {
		return "";
	}

	const decision = getMemoryLoadDecision(params.isGroupContext, params.config);
	const maxSectionChars = params.maxSectionChars ?? 1800;
	const sections: Array<{ title: string; path: string }> = [];

	if (decision.includeSoul) sections.push({ title: "SOUL", path: ".memory/SOUL.md" });
	if (decision.includeUser) sections.push({ title: "USER", path: ".memory/USER.md" });
	if (decision.includeLongTermMemory) sections.push({ title: "MEMORY", path: ".memory/MEMORY.md" });
	if (decision.includeDailyMemory) {
		const now = new Date();
		sections.push({ title: "MEMORY_TODAY", path: dayFilePath(now) });
		sections.push({ title: "MEMORY_YESTERDAY", path: dayFilePath(new Date(now.getTime() - 24 * 60 * 60 * 1000)) });
	}

	const rendered: string[] = [];
	for (const section of sections) {
		const doc = await backend.get(section.path);
		const text = doc.text.trim();
		if (!text) continue;
		rendered.push(`[${section.title}]`);
		rendered.push(truncate(text, maxSectionChars));
	}

	if (rendered.length === 0) {
		return "";
	}

	return [`Memory context:`, ...rendered].join("\n");
}

function formatDailyEntry(userText: string, assistantText?: string): string {
	const ts = new Date().toISOString();
	const lines = [`## ${ts}`, `- user: ${userText.trim()}`];
	if (assistantText?.trim()) {
		lines.push(`- assistant: ${assistantText.trim()}`);
	}
	return lines.join("\n");
}

export function shouldCaptureLongTermMemory(userText: string): boolean {
	const text = userText.toLowerCase();
	return (
		text.includes("remember this") ||
		text.includes("please remember") ||
		text.includes("my preference is") ||
		text.includes("i prefer") ||
		text.includes("always use") ||
		text.includes("never use") ||
		text.includes("decision:") ||
		text.startsWith("remember ")
	);
}

export function estimateTokenCountFromHistory(
	history: Array<{ sender: string; text: string; timestamp: string }>,
): number {
	const totalChars = history.reduce((sum, item) => sum + item.sender.length + item.timestamp.length + item.text.length, 0);
	return Math.ceil(totalChars / 4);
}

export function shouldTriggerMemoryFlush(
	history: Array<{ sender: string; text: string; timestamp: string }>,
	config: MemoryConfig,
): boolean {
	if (!config.flush.enabled) {
		return false;
	}
	return estimateTokenCountFromHistory(history) >= config.flush.softThresholdTokens;
}

export async function persistConversationMemory(params: {
	config: MemoryConfig;
	workspaceRoot: string;
	userText: string;
	assistantText?: string;
	historyForFlush?: Array<{ sender: string; text: string; timestamp: string }>;
}): Promise<{ dailyWritten: boolean; longTermWritten: boolean; flushHintWritten: boolean }> {
	const backend = createMemoryBackend(params.config, params.workspaceRoot);
	if (!backend.status().available) {
		return { dailyWritten: false, longTermWritten: false, flushHintWritten: false };
	}

	const dailyEntry = formatDailyEntry(params.userText, params.assistantText);
	const dailyResult = await backend.appendDaily(dailyEntry);
	const longTermNeeded = shouldCaptureLongTermMemory(params.userText);
	const longTermResult = longTermNeeded ? await backend.upsertLongTerm(params.userText.trim()) : { ok: false };

	let flushHintWritten = false;
	if (params.historyForFlush && shouldTriggerMemoryFlush(params.historyForFlush, params.config)) {
		const flushResult = await backend.appendDaily(
			`## ${new Date().toISOString()}\n- system: context nearing compaction; review durable facts and keep MEMORY.md updated.`,
		);
		flushHintWritten = flushResult.ok;
	}

	return {
		dailyWritten: dailyResult.ok,
		longTermWritten: !!longTermResult.ok,
		flushHintWritten,
	};
}
