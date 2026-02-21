import type { FeishuChannel } from "@/gateway/channels/feishu";
import type { TelegramChannel } from "@/gateway/channels/telegram";
import { persistence } from "@/gateway/persistence";
import { logger } from "@/packages/logger";

export type BroadcastChannel = "telegram" | "feishu";

export interface BroadcastTarget {
	chatId: string;
	channel: BroadcastChannel;
	instanceName?: string;
	workspace?: string;
}

export interface BroadcastContext {
	telegram: TelegramChannel;
	feishu?: FeishuChannel;
}

export interface BroadcastOptions {
	targetChatIds?: Array<string | number>;
	channels?: BroadcastChannel[];
}

function inferChannel(chatId: string): BroadcastChannel {
	if (chatId.startsWith("oc_") || chatId.startsWith("ou_")) return "feishu";
	return "telegram";
}

function normalizeChannel(value: string | null): BroadcastChannel | null {
	if (value === "telegram" || value === "feishu") return value;
	return null;
}

export async function resolveBroadcastTargets(options?: BroadcastOptions): Promise<BroadcastTarget[]> {
	const [sessions, channelRows] = await Promise.all([persistence.getAllSessions(), persistence.getAllChatChannels()]);

	const channelByChat = new Map<string, string>();
	for (const row of channelRows) {
		channelByChat.set(String(row.chat_id), row.channel);
	}

	const requested = options?.targetChatIds?.map((id) => String(id));
	const requestedSet = requested ? new Set(requested) : null;
	const channelFilter = options?.channels ? new Set(options.channels) : null;

	const targets: BroadcastTarget[] = [];
	for (const session of sessions) {
		const chatId = String(session.chat_id);
		if (requestedSet && !requestedSet.has(chatId)) continue;

		const channel = normalizeChannel(channelByChat.get(chatId) || null) ?? inferChannel(chatId);
		if (channelFilter && !channelFilter.has(channel)) continue;

		const workspace = await persistence.getWorkspace(chatId);
		targets.push({
			chatId,
			channel,
			instanceName: session.instance_name,
			workspace,
		});
	}

	return targets;
}

export async function broadcastMessage(
	context: BroadcastContext,
	text: string,
	options?: BroadcastOptions,
): Promise<{ sent: number; failed: number; skipped: number }> {
	const targets = await resolveBroadcastTargets(options);
	let sent = 0;
	let failed = 0;
	let skipped = 0;

	for (const target of targets) {
		try {
			if (target.channel === "feishu") {
				if (!context.feishu) {
					skipped += 1;
					continue;
				}
				await context.feishu.sendMessage(target.chatId, text);
				sent += 1;
				continue;
			}

			await context.telegram.sendMessage(target.chatId, text);
			sent += 1;
		} catch (error) {
			failed += 1;
			logger.warn(
				{
					chatId: target.chatId,
					channel: target.channel,
					error: error instanceof Error ? error.message : String(error),
				},
				"Broadcast send failed",
			);
		}
	}

	return { sent, failed, skipped };
}
