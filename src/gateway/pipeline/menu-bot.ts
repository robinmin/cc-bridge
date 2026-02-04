import { type Bot, type Message } from "./index";
import { type Channel } from "@/gateway/channels";
import { instanceManager } from "@/gateway/instance-manager";
import { persistence } from "@/gateway/persistence";
import { logger } from "@/packages/logger";
import { WorkspaceList, WorkspaceStatus } from "@/gateway/output/WorkspaceReport";
import { HelpReport } from "@/gateway/output/HelpReport";

export class MenuBot implements Bot {
    name = "MenuBot";

    static readonly MENU_COMMANDS = [
        { command: "ws_list", description: "List all project workspaces" },
        { command: "ws_status", description: "Current workspace status" },
        { command: "ws_switch", description: "Switch to a workspace (e.g. /ws_switch name)" },
        { command: "status", description: "System infrastructure health" },
        { command: "help", description: "Show available commands" },
    ];

    constructor(
        private channel: Channel,
        private persistenceManager = persistence,
    ) { }

    getMenus() {
        return MenuBot.MENU_COMMANDS;
    }

    /**
     * Aggregates menus from all bots in the chain.
     */
    static getAllMenus(bots: Bot[]): { command: string; description: string }[] {
        return bots.flatMap((bot) => bot.getMenus());
    }

    async handle(message: Message): Promise<boolean> {
        const text = message.text.trim();
        if (!text.startsWith("/")) return false;

        const parts = text.split(" ");
        const command = parts[0].toLowerCase();

        switch (command) {
            case "/start":
                await this.channel.sendMessage(
                    message.chatId,
                    "👋 Welcome to Kirin (cc-bridge)!\n\nI am your multi-workspace Gateway. Use the menu or `/ws_list` to manage your projects.",
                );
                return true;
            case "/help": {
                const report = HelpReport({
                    commands: MenuBot.MENU_COMMANDS,
                    format: "telegram"
                });

                await this.channel.sendMessage(message.chatId, report);
                return true;
            }
            case "/status":
                await this.handleBridgeStatus(message);
                return true;

            case "/ws_status": {
                const current = await this.persistenceManager.getSession(message.chatId);
                const instances = await instanceManager.refresh();
                const inst = current ? instances.find((i) => i.name === current) : undefined;

                const report = WorkspaceStatus({
                    current,
                    status: inst?.status,
                    format: "telegram"
                });

                await this.channel.sendMessage(message.chatId, report);
                return true;
            }

            case "/list":
            case "/ws_list": {
                const allFolders = await instanceManager.getWorkspaceFolders();
                const allInstances = await instanceManager.refresh();
                const currentSession = await this.persistenceManager.getSession(message.chatId);

                if (allFolders.length === 0) {
                    await this.channel.sendMessage(message.chatId, "⚠️ No workspaces found in root folder.");
                } else {
                    const workspaces = allFolders.map(folder => {
                        const isActive = folder === currentSession;
                        const inst = allInstances.find(i => i.name === folder);
                        return {
                            name: folder,
                            status: inst?.status || "stopped",
                            isActive
                        };
                    });

                    const report = WorkspaceList({
                        workspaces,
                        format: "telegram",
                        currentSession
                    });

                    await this.channel.sendMessage(message.chatId, report);
                }
                return true;
            }

            case "/ws_switch": {
                try {
                    const target = parts[1];
                    if (!target) {
                        await this.channel.sendMessage(
                            message.chatId,
                            "❓ Please specify a workspace name.\nExample: `/ws_switch cc-bridge`.",
                        );
                        return true;
                    }

                    const workspaces = await instanceManager.refresh();
                    const found = workspaces.find((i) => i.name.toLowerCase() === target.toLowerCase());

                    if (!found) {
                        await this.channel.sendMessage(message.chatId, `❌ Workspace \`${target}\` not found.`);
                    } else {
                        await this.persistenceManager.setSession(message.chatId, found.name);
                        await this.channel.sendMessage(message.chatId, `✅ Switched to workspace: **${found.name}**`);
                    }
                } catch (err) {
                    logger.error({ err, command }, "Failed to process menu command");
                }
                return true;
            }

            case "/bridge_status":
                await this.handleBridgeStatus(message);
                return true;
        }

        return false;
    }

    async handleBridgeStatus(message: Message): Promise<void> {
        try {
            const port = process.env.PORT || 8080;
            const res = await fetch(`http://localhost:${port}/health?format=telegram`);
            if (!res.ok) throw new Error("Health check failed");

            const report = await res.text();
            await this.channel.sendMessage(message.chatId, report);
        } catch (error) {
            logger.error({ error }, "Error in bridge_status command");
            await this.channel.sendMessage(message.chatId, "❌ Failed to fetch detailed system status.");
        }
    }
}
