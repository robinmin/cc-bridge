import { existsSync } from "node:fs";
import path from "node:path";
import type { Channel } from "@/gateway/channels";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { logger } from "@/packages/logger";
import type { Bot, Message } from "./index";

// Timeout for host commands (10 seconds)
const HOST_COMMAND_TIMEOUT_MS = 10000;

// Allowed script path (must be within project directory)
const ALLOWED_SCRIPT_DIR = path.resolve("scripts");
const SCRIPT_NAME = "host_cmd.sh";

export class HostBot implements Bot {
	name = "HostBot";
	private scriptPath: string;

	constructor(private channel: Channel) {
		// Validate and resolve the script path
		const resolvedPath = path.resolve(ALLOWED_SCRIPT_DIR, SCRIPT_NAME);

		// Ensure the resolved path is within the allowed directory
		if (!resolvedPath.startsWith(ALLOWED_SCRIPT_DIR)) {
			throw new Error(
				`Security violation: Script path "${resolvedPath}" is outside allowed directory "${ALLOWED_SCRIPT_DIR}"`,
			);
		}

		// Check if the script exists
		if (!existsSync(resolvedPath)) {
			logger.warn({ scriptPath: resolvedPath }, "Host command script not found, HostBot commands will fail");
		}

		this.scriptPath = resolvedPath;
	}

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
		const menu = this.getMenus().find((m) => `/${m.command}` === fullCommand);
		if (!menu) return false;

		// 2. Extract the script command (e.g. 'uptime' from 'host_uptime')
		const scriptCmd = menu.command.includes("_") ? menu.command.split("_")[1] : menu.command;

		try {
			logger.debug({ scriptCmd, fullCommand }, "Delegating host command to script");

			// Show typing indicator for better UX
			if (this.channel.showTyping) {
				this.channel.showTyping(message.chatId).catch(() => {
					// Non-critical, ignore errors
				});
			}

			const proc = Bun.spawn(["bash", this.scriptPath, scriptCmd], {
				stdout: "pipe",
				stderr: "pipe",
				env: {
					// Only pass necessary environment variables to prevent leaks
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					WORKSPACE_ROOT: GATEWAY_CONSTANTS.CONFIG.WORKSPACE_ROOT,
				},
			});

			// Add timeout to prevent hanging
			const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
				setTimeout(() => resolve({ timedOut: true }), HOST_COMMAND_TIMEOUT_MS);
			});

			const result = await Promise.race([
				(async () => {
					const output = await new Response(proc.stdout).text();
					const errorOutput = await new Response(proc.stderr).text();
					const exitCode = await proc.exited;
					return { timedOut: false, output, errorOutput, exitCode };
				})(),
				timeoutPromise,
			]);

			if (result.timedOut) {
				proc.kill();
				logger.warn({ scriptCmd }, "Host command timed out");
				await this.channel.sendMessage(message.chatId, "⏱️ Command timed out. Please try again.");
				return true;
			}

			if (result.exitCode === 0 && result.output?.trim()) {
				await this.channel.sendMessage(message.chatId, result.output.trim());
				return true;
			}

			// Handle error case
			logger.error({ scriptCmd, exitCode: result.exitCode, stderr: result.errorOutput }, "Host command failed");
			await this.channel.sendMessage(message.chatId, "❌ Command failed. Please check system status.");
			return true;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error({ error: errorMsg, scriptCmd }, "Error executing host command");
			await this.channel.sendMessage(message.chatId, "❌ Failed to execute command. Please try again.");
			return true;
		}
	}
}
