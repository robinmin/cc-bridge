import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import type { Message } from "@/gateway/pipeline";
import { logger } from "@/packages/logger";
import type { Channel, ChannelAdapter } from "./index";

// Default timeout for Telegram API calls (30 seconds)
const TELEGRAM_API_TIMEOUT_MS = 30000;
const REDACTED_TOKEN = "<redacted>";
const DEFAULT_TELEGRAM_PARSE_MODE = "MarkdownV2";

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

function redactToken(input: string, token: string): string {
	if (!token || !input.includes(token)) return input;
	return input.split(token).join(REDACTED_TOKEN);
}

function sanitizeTelegramNetworkError(error: unknown, token: string): Error {
	if (error instanceof Error) {
		const sanitized = new Error(redactToken(error.message, token));
		sanitized.name = error.name;
		// Preserve useful code (ConnectionRefused/ECONNREFUSED/etc.) without leaking URL/token fields.
		if ("code" in error) {
			(sanitized as Error & { code?: string }).code = String((error as { code?: unknown }).code);
		}
		return sanitized;
	}
	return new Error("Unknown network error");
}

function escapeMarkdownV2(text: string): string {
	// Telegram MarkdownV2 reserved chars:
	// _ * [ ] ( ) ~ ` > # + - = | { } . !
	return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export class TelegramClient {
	constructor(private botToken: string) {}

	async sendMessage(chatId: string | number, text: string, options?: { parse_mode?: string }): Promise<void> {
		const url = `${GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`;
		const payload: { chat_id: string | number; text: string; parse_mode?: string } = {
			chat_id: chatId,
			text: options?.parse_mode ? text : escapeMarkdownV2(text),
		};

		if (options?.parse_mode) {
			payload.parse_mode = options.parse_mode;
		} else {
			payload.parse_mode = DEFAULT_TELEGRAM_PARSE_MODE;
		}

		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Telegram API error: ${error}`);
		}
	}

	async sendChatAction(chatId: string | number, action: ChatAction = "typing"): Promise<void> {
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

	async setCommands(commands: { command: string; description: string }[]): Promise<void> {
		logger.debug({ count: commands.length, commands }, "Updating Telegram bot menu commands");
		const url = `${GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE}/bot${this.botToken}/setMyCommands`;
		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ commands }),
				signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
			});
		} catch (error) {
			throw sanitizeTelegramNetworkError(error, this.botToken);
		}

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

	async getFile(fileId: string): Promise<{ file_path: string; file_size?: number }> {
		const url = `${GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE}/bot${this.botToken}/getFile`;
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ file_id: fileId }),
			signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Telegram API error (getFile): ${error}`);
		}

		const data = (await response.json()) as { ok: boolean; result?: { file_path: string; file_size?: number } };
		if (!data.ok || !data.result?.file_path) {
			throw new Error("Telegram API error (getFile): missing file_path");
		}

		return data.result;
	}

	async downloadFile(filePath: string): Promise<Response> {
		const url = `${GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE}/file/bot${this.botToken}/${filePath}`;
		return fetch(url, { signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS) });
	}
}

export class TelegramChannel implements Channel, ChannelAdapter {
	name = "telegram";
	private client: TelegramClient;

	constructor(botToken: string) {
		this.client = new TelegramClient(botToken);
	}

	getClient(): TelegramClient {
		return this.client;
	}

	async sendMessage(chatId: string | number, text: string, options?: unknown): Promise<void> {
		await this.client.sendMessage(chatId, text, options as { parse_mode?: string });

		// Log outgoing message with truncated content (after send completes)
		const maxLength = 256;
		const truncatedText = text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
		const elapsedSec = consumeChatElapsed(chatId);
		const elapsedSuffix = elapsedSec !== null ? ` (${elapsedSec.toFixed(2)}s)` : "";
		logger.info(`[${chatId}] <== ${truncatedText.replace(/\n/g, "\\n")}${elapsedSuffix}`);
	}

	async showTyping(chatId: string | number): Promise<void> {
		await this.client.sendChatAction(chatId, "typing");
	}

	async setMenu(commands: { command: string; description: string }[]): Promise<void> {
		await this.client.setCommands(commands);
	}

	async getStatus(): Promise<unknown> {
		return this.client.getWebhookInfo();
	}

	parseWebhook(body: unknown): Message | null {
		if (!body || typeof body !== "object") return null;
		const webhookBody = body as Record<string, unknown>;

		if (!webhookBody.message || typeof webhookBody.message !== "object") return null;
		const msg = webhookBody.message as Record<string, unknown>;

		if (!msg.chat || typeof msg.chat !== "object") return null;
		const chat = msg.chat as Record<string, unknown>;

		if (!chat.id) return null;

		const from = msg.from && typeof msg.from === "object" ? (msg.from as Record<string, unknown>) : undefined;

		const attachments: Message["attachments"] = [];

		if (msg.document && typeof msg.document === "object") {
			const doc = msg.document as Record<string, unknown>;
			const fileId = String(doc.file_id || "");
			if (fileId) {
				const mimeType = typeof doc.mime_type === "string" ? doc.mime_type : undefined;
				const fileName = typeof doc.file_name === "string" ? doc.file_name : `document_${fileId}`;
				const sizeBytes = typeof doc.file_size === "number" ? doc.file_size : undefined;
				const kind = mimeType === "application/pdf" ? "other" : mimeType?.startsWith("image/") ? "image" : "text";
				attachments.push({
					source: "telegram",
					fileId,
					fileName,
					mimeType,
					sizeBytes,
					kind: kind as "text" | "image" | "other",
				});
			}
		}

		if (Array.isArray(msg.photo) && msg.photo.length > 0) {
			const photos = msg.photo as Array<Record<string, unknown>>;
			const largest = photos.reduce((prev, curr) => {
				const prevSize = typeof prev.file_size === "number" ? prev.file_size : 0;
				const currSize = typeof curr.file_size === "number" ? curr.file_size : 0;
				return currSize > prevSize ? curr : prev;
			});
			const fileId = String(largest.file_id || "");
			if (fileId) {
				const fileName = `photo_${String(largest.file_unique_id || fileId)}.jpg`;
				const sizeBytes = typeof largest.file_size === "number" ? largest.file_size : undefined;
				attachments.push({
					source: "telegram",
					fileId,
					fileName,
					mimeType: "image/jpeg",
					sizeBytes,
					kind: "image",
				});
			}
		}

		return {
			channelId: "telegram",
			chatId: chat.id as string | number,
			text: typeof msg.text === "string" ? msg.text : "",
			sender: (from?.username as string) || (from?.first_name as string) || "unknown",
			updateId: webhookBody.update_id as number,
			user: {
				id: from?.id as string | number,
				username: from?.username as string | undefined,
			},
			attachments,
		};
	}
}

const chatTimers = new Map<string, number>();

export const markChatStart = (chatId: string | number): void => {
	chatTimers.set(String(chatId), Date.now());
};

export const consumeChatElapsed = (chatId: string | number): number | null => {
	const key = String(chatId);
	const start = chatTimers.get(key);
	if (start === undefined) return null;
	chatTimers.delete(key);
	return (Date.now() - start) / 1000;
};
