import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import type { Message } from "@/gateway/pipeline";
import { logger } from "@/packages/logger";
import type { Channel, ChannelAdapter } from "./index";

// Default timeout for Telegram API calls (30 seconds)
const TELEGRAM_API_TIMEOUT_MS = 30000;

// Available chat actions for sendChatAction
type ChatAction =
	| "typing"
	| "record_audio"
	| "record_video"
	| "record_video_note"
	| "upload_photo"
	| "upload_video"
	| "upload_document"
	| "upload_audio"
	| "find_location"
	| "record_voice_note"
	| "upload_voice_note";

export class TelegramClient {
	constructor(private botToken: string) {}

	async sendMessage(
		chatId: string | number,
		text: string,
		options?: { parse_mode?: string },
	): Promise<void> {
		const url = `${GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`;
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: chatId,
				text,
				parse_mode: options?.parse_mode || "Markdown",
			}),
			signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Telegram API error: ${error}`);
		}
	}

	async sendChatAction(
		chatId: string | number,
		action: ChatAction = "typing",
	): Promise<void> {
		const url = `${GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE}/bot${this.botToken}/sendChatAction`;
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: chatId,
				action,
			}),
			signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
		});

		if (!response.ok) {
			const error = await response.text();
			logger.warn({ chatId, action, error }, "Failed to send chat action");
			// Don't throw - chat action is optional
		}
	}

	async setCommands(
		commands: { command: string; description: string }[],
	): Promise<void> {
		logger.debug(
			{ count: commands.length, commands },
			"Updating Telegram bot menu commands",
		);
		const url = `${GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE}/bot${this.botToken}/setMyCommands`;
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ commands }),
			signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Telegram API (setCommands) error: ${error}`);
		}
	}

	async getWebhookInfo(): Promise<unknown> {
		const url = `${GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE}/bot${this.botToken}/getWebhookInfo`;
		const response = await fetch(url, {
			signal: AbortSignal.timeout(GATEWAY_CONSTANTS.DIAGNOSTICS.TIMEOUT_MS),
		});
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Telegram API (getWebhookInfo) error: ${error}`);
		}
		return response.json();
	}
}

export class TelegramChannel implements Channel, ChannelAdapter {
	name = "telegram";
	private client: TelegramClient;

	constructor(botToken: string) {
		this.client = new TelegramClient(botToken);
	}

	async sendMessage(
		chatId: string | number,
		text: string,
		options?: unknown,
	): Promise<void> {
		await this.client.sendMessage(
			chatId,
			text,
			options as { parse_mode?: string },
		);
	}

	async showTyping(chatId: string | number): Promise<void> {
		await this.client.sendChatAction(chatId, "typing");
	}

	async setMenu(
		commands: { command: string; description: string }[],
	): Promise<void> {
		await this.client.setCommands(commands);
	}

	async getStatus(): Promise<unknown> {
		return this.client.getWebhookInfo();
	}

	parseWebhook(body: unknown): Message | null {
		const webhookBody = body as Record<string, unknown>;
		if (!webhookBody || !webhookBody.message) return null;

		const msg = webhookBody.message as Record<string, unknown>;
		const from = msg.from as Record<string, unknown> | undefined;
		const chat = msg.chat as Record<string, unknown>;

		return {
			channelId: "telegram",
			chatId: chat.id as string | number,
			text: (msg.text as string) || "",
			updateId: webhookBody.update_id as number,
			user: {
				id: from?.id as string | number,
				username: from?.username as string | undefined,
			},
		};
	}
}
