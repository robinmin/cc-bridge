import type { Message } from "@/gateway/pipeline";

export interface Channel {
	name: string;
	/**
	 * Sends a message back to the user on this channel.
	 */
	sendMessage(
		chatId: string | number,
		text: string,
		options?: unknown,
	): Promise<void>;

	/**
	 * Shows a typing/working indicator to the user.
	 * Optional - channels that don't support this will no-op.
	 */
	showTyping?(chatId: string | number): Promise<void>;
}

export interface ChannelAdapter {
	/**
	 * Parses a raw webhook request into a generic Message.
	 */
	parseWebhook(body: unknown): Message | null;
}
