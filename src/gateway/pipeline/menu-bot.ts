import type { Channel } from "@/gateway/channels";
import { instanceManager } from "@/gateway/instance-manager";
import { HelpReport } from "@/gateway/output/HelpReport";
import { WorkspaceList, WorkspaceStatus } from "@/gateway/output/WorkspaceReport";
import { persistence } from "@/gateway/persistence";
import { logger } from "@/packages/logger";
import type { Bot, Message } from "./index";

export class MenuBot implements Bot {
	name = "MenuBot";

	static readonly MENU_COMMANDS = [
		{ command: "ws_list", description: "List all project workspaces" },
		{ command: "ws_status", description: "Current workspace status" },
		{
			command: "ws_switch",
			description: "Switch to a workspace (e.g. /ws_switch name)",
		},
		{
			command: "ws_add",
			description: "Add a new workspace (e.g. /ws_add my-project)",
		},
		{ command: "schedulers", description: "List scheduled tasks" },
		{ command: "scheduler_add", description: "Add scheduled task" },
		{ command: "scheduler_del", description: "Delete scheduled task by id" },
		{ command: "status", description: "System infrastructure health" },
		{ command: "help", description: "Show available commands" },
	];

	constructor(
		private channel: Channel,
		private persistenceManager = persistence,
	) {}

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
			case "/ws_add": {
				try {
					const workspaceName = parts[1];
					if (!workspaceName) {
						await this.channel.sendMessage(
							message.chatId,
							"❓ Please specify a workspace name.\nExample: `/ws_add my-project`.",
						);
						return true;
					}
					await this.handleWorkspaceAdd(message, workspaceName);
				} catch (err) {
					logger.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to create workspace");
					await this.channel.sendMessage(message.chatId, "❌ Failed to create workspace. Please try again.");
				}
				return true;
			}
			case "/help": {
				const report = HelpReport({
					commands: MenuBot.MENU_COMMANDS,
					format: "telegram",
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
					format: "telegram",
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
					const workspaces = allFolders.map((folder) => {
						const isActive = folder === currentSession;
						const inst = allInstances.find((i) => i.name === folder);
						return {
							name: folder,
							status: inst?.status || "stopped",
							isActive,
						};
					});

					const report = WorkspaceList({
						workspaces,
						format: "telegram",
						currentSession,
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
					logger.error(
						{ err: err instanceof Error ? err.message : String(err), command },
						"Failed to process menu command",
					);
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
			const res = await fetch(
				`http://localhost:${port}/health?format=telegram`,
				{ signal: AbortSignal.timeout(5000) }, // 5 second timeout
			);
			if (!res.ok) throw new Error("Health check failed");

			const report = await res.text();
			await this.channel.sendMessage(message.chatId, report);
		} catch (error) {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "Error in bridge_status command");
			await this.channel.sendMessage(message.chatId, "❌ Failed to fetch detailed system status.");
		}
	}

	/**
	 * Handles workspace creation: checks if workspace exists, creates it with git init
	 */
	async handleWorkspaceAdd(message: Message, workspaceName: string): Promise<void> {
		// Validate workspace name (alphanumeric, dash, underscore, no spaces)
		const validName = /^[a-zA-Z0-9_-]+$/;
		if (!validName.test(workspaceName)) {
			await this.channel.sendMessage(
				message.chatId,
				"⚠️ Invalid workspace name. Use only letters, numbers, dashes, and underscores (no spaces).\nExample: `/ws_add my-project`",
			);
			return;
		}

		// Get the projects root from config
		const { ConfigLoader } = await import("@/packages/config");
		const { GATEWAY_CONSTANTS } = await import("@/gateway/consts");
		const config = ConfigLoader.load(GATEWAY_CONSTANTS.CONFIG.CONFIG_FILE, GATEWAY_CONSTANTS.DEFAULT_CONFIG);
		const projectsRoot = config.projectsRoot || GATEWAY_CONSTANTS.CONFIG.PROJECTS_ROOT;

		// Check if workspace directory already exists
		const { existsSync } = await import("node:fs");
		const path = await import("node:path");
		const workspacePath = path.join(projectsRoot, workspaceName);

		if (existsSync(workspacePath)) {
			await this.channel.sendMessage(
				message.chatId,
				`❌ Workspace \`${workspaceName}\` already exists at \`${workspacePath}\``,
			);
			return;
		}

		// Create the workspace directory
		const { mkdirSync } = await import("node:fs");
		try {
			mkdirSync(workspacePath, { recursive: true });
			logger.info({ workspacePath }, "Created workspace directory");
		} catch (err) {
			await this.channel.sendMessage(
				message.chatId,
				`❌ Failed to create workspace directory: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		// Initialize git repository
		try {
			const gitInit = Bun.spawn(["git", "init"], {
				cwd: workspacePath,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await gitInit.exited;
			if (exitCode !== 0) {
				logger.warn({ exitCode, workspacePath }, "git init failed, but workspace was created");
			} else {
				logger.info({ workspacePath }, "Initialized git repository");
			}
		} catch (err) {
			logger.warn(
				{ error: err instanceof Error ? err.message : String(err) },
				"git init failed, but workspace was created",
			);
		}

		// Run tasks init for project initialization
		try {
			const tasksInit = Bun.spawn(["tasks", "init"], {
				cwd: workspacePath,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await tasksInit.exited;
			if (exitCode !== 0) {
				logger.warn({ exitCode, workspacePath }, "tasks init failed, but workspace was created");
			} else {
				logger.info({ workspacePath }, "Initialized tasks project");
			}
		} catch (err) {
			logger.warn(
				{ error: err instanceof Error ? err.message : String(err) },
				"tasks init failed (tasks CLI may not be installed), but workspace was created",
			);
		}

		// Create initial git commit
		try {
			const gitAdd = Bun.spawn(["git", "add", "."], {
				cwd: workspacePath,
				stdout: "pipe",
				stderr: "pipe",
			});
			await gitAdd.exited;

			const gitCommit = Bun.spawn(["git", "commit", "-m", "project initialization"], {
				cwd: workspacePath,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await gitCommit.exited;
			if (exitCode !== 0) {
				logger.warn({ exitCode, workspacePath }, "git commit failed, but workspace was created");
			} else {
				logger.info({ workspacePath }, "Created initial git commit");
			}
		} catch (err) {
			logger.warn(
				{ error: err instanceof Error ? err.message : String(err) },
				"git commit failed, but workspace was created",
			);
		}

		// Set the new workspace as current for the user
		await this.persistenceManager.setWorkspace(message.chatId, workspaceName);

		await this.channel.sendMessage(
			message.chatId,
			`✅ Workspace \`${workspaceName}\` created successfully at \`${workspacePath}\`\n\n📁 Git repository initialized\n📋 Tasks project initialized\n💾 Initial commit created\n🎯 Switched to new workspace`,
		);
	}
}
