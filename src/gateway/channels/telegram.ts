import { type Channel, type ChannelAdapter } from "./index";
import { type Message } from "@/gateway/pipeline";
import { logger } from "@/packages/logger";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";

export class TelegramClient {
    constructor(private botToken: string) { }

    async sendMessage(chatId: string | number, text: string, options?: { parse_mode?: string }): Promise<void> {
        const url = `${GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: options?.parse_mode || "Markdown",
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Telegram API error: ${error}`);
        }
    }

    async setCommands(commands: { command: string; description: string }[]): Promise<void> {
        logger.debug({ count: commands.length, commands }, "Updating Telegram bot menu commands");
        const url = `${GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE}/bot${this.botToken}/setMyCommands`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ commands }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Telegram API (setCommands) error: ${error}`);
        }
    }

    async getWebhookInfo(): Promise<any> {
        const url = `${GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE}/bot${this.botToken}/getWebhookInfo`;
        const response = await fetch(url, { signal: AbortSignal.timeout(GATEWAY_CONSTANTS.DIAGNOSTICS.TIMEOUT_MS) });
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

    async sendMessage(chatId: string | number, text: string, options?: any): Promise<void> {
        await this.client.sendMessage(chatId, text, options);
    }

    async setMenu(commands: { command: string; description: string }[]): Promise<void> {
        await this.client.setCommands(commands);
    }

    async getStatus(): Promise<any> {
        return this.client.getWebhookInfo();
    }

    parseWebhook(body: any): Message | null {
        if (!body || !body.message) return null;

        const msg = body.message;
        return {
            channelId: "telegram",
            chatId: msg.chat.id,
            text: msg.text || "",
            updateId: body.update_id,
            user: {
                id: msg.from.id,
                username: msg.from.username,
            },
        };
    }
}
