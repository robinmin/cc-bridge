export interface Message {
    channelId: string;
    chatId: string | number;
    text: string;
    sender?: string;
    updateId?: number;
    user?: {
        id: string | number;
        username?: string;
    };
}

export interface Bot {
    name: string;
    /**
     * Handles a message. Returns true if the message was handled and should stop bubbling,
     * false if it should continue to the next bot in the chain.
     */
    handle(message: Message): Promise<boolean>;
    /**
     * returns the menu commands for this bot.
     */
    getMenus(): { command: string; description: string }[];
}
