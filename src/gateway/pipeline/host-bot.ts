import { existsSync } from "node:fs";
import path from "node:path";
import type { Channel } from "@/gateway/channels";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { logger } from "@/packages/logger";
import type { Bot, Message } from "./index";

// Timeout for host commands (10 seconds)
const HOST_COMMAND_TIMEOUT_MS = 10000;
const HOST_OUTPUT_MAX_CHARS = 3500;

// Commands that are prohibited for /host execution.
// A command is blocked when it equals an entry or starts with "<entry><separator>".
const DEFAULT_HOST_COMMAND_BLACKLIST = [
	"rm",
	"mv",
	"dd",
	"mkfs",
	"fdisk",
	"parted",
	"wipefs",
	"chmod",
	"chown",
	"chattr",
	"truncate",
	"reboot",
	"shutdown",
	"halt",
	"poweroff",
	"init",
	"systemctl",
	"service",
	"kill",
	"killall",
	"pkill",
	"sudo",
	"su",
	"passwd",
	"useradd",
	"usermod",
	"userdel",
	"groupadd",
	"groupdel",
	"mount",
	"umount",
	"iptables",
	"ufw",
	"docker",
	"kubectl",
	"crontab",
	"at",
	"curl",
	"wget",
	"nc",
	"ncat",
	"netcat",
	"ssh",
	"scp",
	"rsync",
	"bash",
	"sh",
	"zsh",
	"python",
	"python3",
	"node",
	"perl",
	"ruby",
];

// Allowed script path (must be within project directory)
const ALLOWED_SCRIPT_DIR = path.resolve("scripts");
const SCRIPT_NAME = "host_cmd.sh";

export class HostBot implements Bot {
	name = "HostBot";
	private scriptPath: string;
	private hostCommandBlacklist: string[];
	static readonly MENU_COMMANDS = [
		{ command: "host", description: "Execute host command (blacklist protected)" },
		{ command: "host_uptime", description: "Show host uptime" },
		{ command: "host_ps", description: "Show host top processes" },
	];

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
		this.hostCommandBlacklist = DEFAULT_HOST_COMMAND_BLACKLIST;
	}

	getMenus() {
		return HostBot.MENU_COMMANDS;
	}

	async handle(message: Message): Promise<boolean> {
		const text = message.text.trim();
		const fullCommand = text.split(" ")[0].toLowerCase();

		if (fullCommand === "/host") {
			return this.handleRawHostCommand(message, text);
		}

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

	private async handleRawHostCommand(message: Message, text: string): Promise<boolean> {
		const command = text.replace(/^\/host\s*/i, "").trim();

		if (!command) {
			await this.channel.sendMessage(message.chatId, "Usage: /host <command>");
			return true;
		}

		const blockedBy = this.getBlockedPrefix(command);
		if (blockedBy) {
			await this.channel.sendMessage(message.chatId, `❌ Command blocked by security policy: \`${blockedBy}\``);
			return true;
		}

		try {
			if (this.channel.showTyping) {
				this.channel.showTyping(message.chatId).catch(() => {});
			}

			const proc = Bun.spawn(["bash", "-lc", command], {
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					WORKSPACE_ROOT: GATEWAY_CONSTANTS.CONFIG.WORKSPACE_ROOT,
				},
			});

			const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
				setTimeout(() => resolve({ timedOut: true }), HOST_COMMAND_TIMEOUT_MS);
			});

			const result = await Promise.race([
				(async () => {
					const stdout = await new Response(proc.stdout).text();
					const stderr = await new Response(proc.stderr).text();
					const exitCode = await proc.exited;
					return { timedOut: false as const, stdout, stderr, exitCode };
				})(),
				timeoutPromise,
			]);

			if (result.timedOut) {
				proc.kill();
				await this.channel.sendMessage(message.chatId, "⏱️ Command timed out. Please try a simpler command.");
				return true;
			}

			const rendered = this.renderHostCommandResult(command, result.stdout, result.stderr, result.exitCode);
			await this.channel.sendMessage(message.chatId, rendered);
			return true;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error({ error: errorMsg, command }, "Error executing /host command");
			await this.channel.sendMessage(message.chatId, "❌ Failed to execute host command.");
			return true;
		}
	}

	private getBlockedPrefix(command: string): string | null {
		const normalized = command.trim().toLowerCase();
		for (const blocked of this.hostCommandBlacklist) {
			if (
				normalized === blocked ||
				normalized.startsWith(`${blocked} `) ||
				normalized.startsWith(`${blocked};`) ||
				normalized.startsWith(`${blocked}|`) ||
				normalized.startsWith(`${blocked}&`)
			) {
				return blocked;
			}
		}
		return null;
	}

	private truncateOutput(value: string): { text: string; truncated: boolean } {
		if (value.length <= HOST_OUTPUT_MAX_CHARS) {
			return { text: value, truncated: false };
		}
		return {
			text: `${value.slice(0, HOST_OUTPUT_MAX_CHARS)}\n...[truncated]`,
			truncated: true,
		};
	}

	private renderHostCommandResult(command: string, stdout: string, stderr: string, exitCode: number): string {
		const out = this.truncateOutput(stdout || "");
		const err = this.truncateOutput(stderr || "");

		const lines = [`$ ${command}`, `exit_code=${exitCode}`];
		if (out.text.trim().length > 0) {
			lines.push("", "stdout:", out.text.trimEnd());
		}
		if (err.text.trim().length > 0) {
			lines.push("", "stderr:", err.text.trimEnd());
		}
		if (out.truncated || err.truncated) {
			lines.push("", "⚠️ Output truncated due to length.");
		}

		return lines.join("\n");
	}
}
