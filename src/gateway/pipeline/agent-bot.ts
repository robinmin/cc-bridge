import { type Bot, type Message } from "./index";
import { type Channel } from "@/gateway/channels";
import { instanceManager } from "@/gateway/instance-manager";
import { IpcClient } from "@/packages/ipc/client";
import { persistence } from "@/gateway/persistence";
import { logger } from "@/packages/logger";

export class AgentBot implements Bot {
    name = "AgentBot";

    constructor(
        private channel: Channel,
        private persistenceManager = persistence
    ) { }

    getMenus() {
        return [];
    }

    async handle(message: Message): Promise<boolean> {
        // 1. Session Tracking: Try to find a sticky instance
        let instanceName = await this.persistenceManager.getSession(message.chatId);
        let instance = instanceName ? instanceManager.getInstance(instanceName) : undefined;

        // Fallback to any running instance if sticky one is gone or doesn't exist
        if (!instance || instance.status !== "running") {
            const instances = instanceManager.getInstances();
            instance = instances.find(i => i.status === "running");

            if (instance) {
                logger.info({ chatId: message.chatId, instance: instance.name }, "Sticky session lost or missing, selecting new instance");
                await this.persistenceManager.setSession(message.chatId, instance.name);
            }
        } else {
            logger.debug({ chatId: message.chatId, instance: instance.name }, "Sticky session hit");
        }

        if (!instance) {
            logger.warn({ chatId: message.chatId }, "No running instances available for message");
            await this.channel.sendMessage(message.chatId, "⚠️ No running Claude instance found. Use `/list` to check status.");
            return true;
        }

        // 2. Context Reconstruction: Get last 10 messages for history
        const history = await this.persistenceManager.getHistory(message.chatId, 11); // latest 10 + current
        const historyLines = history
            .filter(m => m.text !== message.text) // exclude current message (we'll add it)
            .reverse()
            .map(m => `<message sender="${m.sender}" timestamp="${m.timestamp}">${m.text}</message>`);

        const prompt = `<messages>\n${historyLines.join("\n")}\n<message sender="user">${message.text}</message>\n</messages>`;

        logger.debug({ chatId: message.chatId, promptLength: prompt.length, historyCount: historyLines.length }, "Reconstructed prompt");

        let retries = 1;
        while (retries >= 0) {
            try {
                logger.debug({ chatId: message.chatId, containerId: instance.containerId }, "Sending request to agent");
                const client = new IpcClient(instance.containerId, instance.name);

                const response = await client.sendRequest({
                    id: Math.random().toString(36).substring(7),
                    method: "POST",
                    path: "/execute",
                    body: {
                        command: "claude",
                        args: [
                            "-p", prompt,
                            "--allow-dangerously-skip-permissions",
                        ]
                    }
                });

                if (response.error) {
                    const errorMsg = response.error.message || "";
                    if (retries > 0 && errorMsg.includes("No such container")) {
                        logger.warn({ chatId: message.chatId, containerId: instance.containerId }, "Stale container ID detected, refreshing and retrying...");
                        const instances = await instanceManager.refresh();
                        const refreshedInstance = instances.find(i => i.name === instance?.name);
                        if (refreshedInstance && refreshedInstance.status === "running") {
                            instance = refreshedInstance;
                            retries--;
                            continue;
                        }
                    }

                    logger.error({ chatId: message.chatId, error: response.error }, "Agent IPC error");
                    await this.channel.sendMessage(message.chatId, `❌ Agent Error: ${response.error.message}`);
                } else if (response.result) {
                    const result = response.result as any;
                    const output = result.stdout || result.content || JSON.stringify(result);
                    logger.debug({ chatId: message.chatId, outputLength: output.length }, "Agent IPC reply received");
                    await this.channel.sendMessage(message.chatId, output);

                    // Store agent response
                    await this.persistenceManager.storeMessage(message.chatId, "agent", output);
                }
                return true;
            } catch (error: any) {
                if (retries > 0) {
                    logger.warn({ chatId: message.chatId, error: error.message }, "IPC call failed, retrying once...");
                    await instanceManager.refresh();
                    retries--;
                    continue;
                }
                logger.error({ chatId: message.chatId, error }, "Gateway IPC fatal error");
                await this.channel.sendMessage(message.chatId, `❌ Gateway Error: ${error.message}`);
                return true;
            }
        }
        return true;
    }
}
