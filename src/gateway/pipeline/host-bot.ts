import { type Bot, type Message } from "./index";
import { type Channel } from "@/gateway/channels";
import { logger } from "@/packages/logger";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import path from "node:path";

export class HostBot implements Bot {
    name = "HostBot";
    private scriptPath = path.resolve("scripts/host_cmd.sh");

    constructor(private channel: Channel) { }

    getMenus() {
        return [
            { command: "host_uptime", description: "Show host uptime" },
            { command: "host_ps", description: "Show host top processes" },
        ];
    }

    async handle(message: Message): Promise<boolean> {
        const text = message.text.trim();
        const fullCommand = text.split(" ")[0].toLowerCase();

        // 1. Check if this is a command we handle (driven by getMenus)
        const menu = this.getMenus().find(m => `/${m.command}` === fullCommand);
        if (!menu) return false;

        // 2. Extract the script command (e.g. 'uptime' from 'host_uptime')
        const scriptCmd = menu.command.includes("_")
            ? menu.command.split("_")[1]
            : menu.command;

        try {
            logger.debug({ scriptCmd, fullCommand }, "Delegating host command to script");
            const proc = Bun.spawn(["bash", this.scriptPath, scriptCmd], {
                stdout: "pipe",
                stderr: "pipe",
                env: {
                    ...process.env,
                    WORKSPACE_ROOT: GATEWAY_CONSTANTS.CONFIG.WORKSPACE_ROOT
                }
            });

            const output = await new Response(proc.stdout).text();
            const errorOutput = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            if (exitCode === 0) {
                if (output.trim()) {
                    await this.channel.sendMessage(message.chatId, output.trim());
                }
                return true;
            }

            logger.error({ scriptCmd, exitCode, errorOutput }, "Host command failed on script side");
            return false;
        } catch (error) {
            logger.error({ error, scriptCmd }, "Error executing host delegation");
            return false;
        }
    }
}
