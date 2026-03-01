import type { MemoryConfig } from "@/gateway/memory/contracts";

export interface MemoryLoadDecision {
	includeSoul: boolean;
	includeUser: boolean;
	includeLongTermMemory: boolean;
	includeDailyMemory: boolean;
}

export function getMemoryLoadDecision(isGroupContext: boolean, config: MemoryConfig): MemoryLoadDecision {
	if (isGroupContext) {
		return {
			includeSoul: true,
			includeUser: true,
			includeLongTermMemory: config.loadPolicy.groupLoadLongTerm,
			includeDailyMemory: false,
		};
	}

	return {
		includeSoul: true,
		includeUser: true,
		includeLongTermMemory: true,
		includeDailyMemory: true,
	};
}

export function inferGroupContext(channelId: string, chatId: string | number): boolean {
	if (channelId === "telegram") {
		if (typeof chatId === "number") {
			return chatId < 0;
		}
		return String(chatId).startsWith("-");
	}

	if (channelId === "feishu") {
		// Conservative default until explicit chat_type is propagated in Message.
		return true;
	}

	return false;
}
