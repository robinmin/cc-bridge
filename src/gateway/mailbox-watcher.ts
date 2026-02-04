import fs from "node:fs/promises";
import path from "node:path";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { type Channel } from "@/gateway/channels";
import { persistence } from "@/gateway/persistence";
import { logger } from "@/packages/logger";

export interface MailboxMessage {
    type: "message" | "status" | "task";
    chatId: string | number;
    text: string;
    [key: string]: any;
}

export class MailboxWatcher {
    private timer: Timer | null = null;
    private isRunning = false;

    constructor(
        private channel: Channel,
        private ipcDir: string = GATEWAY_CONSTANTS.CONFIG.IPC_DIR,
        private pollInterval: number = GATEWAY_CONSTANTS.CONFIG.IPC_POLL_INTERVAL_MS,
        private persistenceManager = persistence
    ) { }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info({ ipcDir: this.ipcDir }, "MailboxWatcher started");

        this.timer = setInterval(async () => {
            await this.poll();
        }, this.pollInterval);
    }

    async stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.isRunning = false;
        logger.info("MailboxWatcher stopped");
    }

    async poll() {
        try {
            if (!(await this.exists(this.ipcDir))) return;

            const instanceDirs = await fs.readdir(this.ipcDir);
            for (const instanceName of instanceDirs) {
                const messagesDir = path.join(this.ipcDir, instanceName, "messages");
                if (await this.exists(messagesDir)) {
                    await this.processMessages(messagesDir);
                }
            }
        } catch (error) {
            logger.error({ error }, "MailboxWatcher poll error");
        }
    }

    private async processMessages(messagesDir: string) {
        const files = await fs.readdir(messagesDir);
        for (const file of files) {
            if (!file.endsWith(".json")) continue;

            const filePath = path.join(messagesDir, file);
            try {
                const content = await fs.readFile(filePath, "utf-8");
                const data: MailboxMessage = JSON.parse(content);

                if (data.type === "message" && data.chatId && data.text) {
                    await this.channel.sendMessage(data.chatId, data.text);
                    await this.persistenceManager.storeMessage(data.chatId, "agent", data.text);
                    logger.info({ chatId: data.chatId, text: data.text }, "Delivered proactive message from agent");
                }

                // Delete processed message
                await fs.unlink(filePath);
            } catch (error) {
                logger.error({ file, error }, "Error processing mailbox message");
                // Optionally move to errors folder as Nanoclaw does
            }
        }
    }

    private async exists(path: string): Promise<boolean> {
        return fs.access(path).then(() => true).catch(() => false);
    }
}
