import type { Message } from "@/gateway/pipeline";

export interface Channel {
    name: string;
    /**
     * Sends a message back to the user on this channel.
     */
    sendMessage(chatId: string | number, text: string, options?: any): Promise<void>;
}

export interface ChannelAdapter {
    /**
     * Parses a raw webhook request into a generic Message.
     */
    parseWebhook(body: any): Message | null;
}
