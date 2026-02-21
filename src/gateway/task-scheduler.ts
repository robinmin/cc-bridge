import fs from "node:fs/promises";
import path from "node:path";
import { miniAppDriver } from "@/gateway/apps/driver";
import { instanceManager } from "@/gateway/instance-manager";
import { persistence } from "@/gateway/persistence";
import { IpcFactory } from "@/packages/ipc";
import { logger } from "@/packages/logger";
import { calculateNextRun } from "@/packages/scheduler";

// Task types for better type safety
interface ScheduledTask {
	id: string;
	instance_name: string;
	chat_id: string;
	prompt: string;
	schedule_type: "once" | "recurring" | "cron";
	schedule_value: string;
	next_run: string;
	status: "active" | "completed";
}

type UploadsConfig = {
	enabled: boolean;
	allowedMimeTypes: string[];
	maxTextBytes: number;
	maxImageBytes: number;
	retentionHours: number;
	storageDir: string;
};

export class TaskScheduler {
	private timer: Timer | null = null;
	private isRunning = false;
	private tickInProgress = false;
	private uploadsConfig?: UploadsConfig;

	constructor(
		private persistenceManager = persistence,
		private instManager = instanceManager,
	) {}

	async start(config?: { uploads?: UploadsConfig }) {
		if (this.isRunning) return;
		this.isRunning = true;
		this.uploadsConfig = config?.uploads;
		logger.info("TaskScheduler started");

		// Use a 1-minute interval for the scheduler
		this.timer = setInterval(() => {
			void this.runTick();
		}, 60000);
	}

	async stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.isRunning = false;
		logger.info("TaskScheduler stopped");
	}

	async checkTasks() {
		try {
			const dueTasks = (await this.persistenceManager.getActiveTasks()) as ScheduledTask[];
			if (dueTasks.length === 0) return;

			logger.info({ count: dueTasks.length }, "Found due tasks");

			for (const task of dueTasks) {
				await this.executeTask(task);
			}
		} catch (error) {
			logger.error({ error }, "Error checking tasks");
		}
	}

	private async runTick(): Promise<void> {
		if (this.tickInProgress) {
			logger.warn("TaskScheduler tick skipped because previous tick is still running");
			return;
		}
		this.tickInProgress = true;
		try {
			await this.checkTasks();
			await this.cleanupUploads();
		} finally {
			this.tickInProgress = false;
		}
	}

	private async cleanupUploads() {
		try {
			const cfg = this.uploadsConfig;
			if (!cfg || !cfg.enabled || !cfg.storageDir) return;

			const ttlMs = (cfg.retentionHours || 24) * 60 * 60 * 1000;
			const baseDir = path.resolve(cfg.storageDir);
			await this.cleanupDir(baseDir, ttlMs);
		} catch (error) {
			logger.error({ error }, "Error cleaning up uploads");
		}
	}

	private async cleanupDir(dir: string, ttlMs: number): Promise<void> {
		let entries: Array<{ name: string; isDir: boolean }> = [];
		try {
			const dirents = await fs.readdir(dir, { withFileTypes: true });
			entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
		} catch {
			return;
		}

		const now = Date.now();
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDir) {
				await this.cleanupDir(fullPath, ttlMs);
				continue;
			}
			try {
				const stat = await fs.stat(fullPath);
				if (now - stat.mtimeMs > ttlMs) {
					await fs.unlink(fullPath);
				}
			} catch {
				// ignore
			}
		}
	}

	private async executeTask(task: ScheduledTask) {
		try {
			if (miniAppDriver.isMiniAppTaskPrompt(task.prompt)) {
				const parsed = miniAppDriver.parseTaskPrompt(task.prompt);
				if (!parsed) {
					logger.warn({ taskId: task.id, prompt: task.prompt }, "Invalid mini-app task prompt");
				} else {
					const result = await miniAppDriver.runApp(parsed.appId, { input: parsed.input });
					logger.info({ taskId: task.id, appId: parsed.appId, result }, "Mini-app task dispatched");
				}

				await this.persistenceManager.saveTask({
					...task,
					status: task.schedule_type === "once" ? "completed" : "active",
					next_run: this.calculateNextRun(task),
				});
				return;
			}

			const instance = this.instManager.getInstance(task.instance_name);
			if (!instance || instance.status !== "running") {
				logger.warn(
					{ taskId: task.id, instance: task.instance_name },
					"Skipping task: Instance not found or not running",
				);
				return;
			}

			const client = IpcFactory.create("auto", {
				containerId: instance.containerId,
				instanceName: task.instance_name,
			});
			const response = await client.sendRequest({
				id: `task-${task.id}-${Date.now()}`,
				method: "POST",
				path: "/execute",
				body: {
					command: task.prompt,
				},
			});

			if (response.error) {
				logger.error({ taskId: task.id, error: response.error }, "Task execution failed");
			} else {
				logger.info({ taskId: task.id }, "Task executed successfully");
			}

			// Update next run time or mark as done depending on type
			await this.persistenceManager.saveTask({
				...task,
				status: task.schedule_type === "once" ? "completed" : "active",
				next_run: this.calculateNextRun(task),
			});
		} catch (error) {
			logger.error({ taskId: task.id, error }, "Error executing task");
		}
	}

	private calculateNextRun(task: ScheduledTask): string | null {
		const next = calculateNextRun({
			schedule_type: task.schedule_type,
			schedule_value: task.schedule_value || "",
		});
		if (next) return next;

		logger.warn(
			{ taskId: task.id, scheduleType: task.schedule_type, scheduleValue: task.schedule_value },
			"Invalid schedule, falling back to 1h from now",
		);
		return new Date(Date.now() + 3600 * 1000).toISOString().replace("T", " ").substring(0, 19);
	}
}

export const taskScheduler = new TaskScheduler();
