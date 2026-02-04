import { persistence } from "@/gateway/persistence";
import { instanceManager } from "@/gateway/instance-manager";
import { IpcClient } from "@/packages/ipc/client";
import { logger } from "@/packages/logger";

export class TaskScheduler {
    private timer: Timer | null = null;
    private isRunning = false;

    constructor(
        private persistenceManager = persistence,
        private instManager = instanceManager
    ) { }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info("TaskScheduler started");

        // Use a 1-minute interval for the scheduler
        this.timer = setInterval(async () => {
            await this.checkTasks();
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
            const dueTasks = await this.persistenceManager.getActiveTasks() as any[];
            if (dueTasks.length === 0) return;

            logger.info({ count: dueTasks.length }, "Found due tasks");

            for (const task of dueTasks) {
                await this.executeTask(task);
            }
        } catch (error) {
            logger.error({ error }, "Error checking tasks");
        }
    }

    private async executeTask(task: any) {
        try {
            const instance = this.instManager.getInstance(task.instance_name);
            if (!instance || instance.status !== "running") {
                logger.warn({ taskId: task.id, instance: task.instance_name }, "Skipping task: Instance not found or not running");
                return;
            }

            const client = new IpcClient(instance.containerId);
            const response = await client.sendRequest({
                id: `task-${task.id}-${Date.now()}`,
                method: "POST",
                path: "/execute",
                body: {
                    command: task.prompt
                }
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
                next_run: this.calculateNextRun(task)
            });

        } catch (error) {
            logger.error({ taskId: task.id, error }, "Error executing task");
        }
    }

    private calculateNextRun(task: any): string | null {
        if (task.schedule_type === "once") return null;

        // Simple interval fallback for now: +1 hour
        const next = new Date(Date.now() + 3600 * 1000);
        return next.toISOString().replace("T", " ").substring(0, 19);
    }
}

export const taskScheduler = new TaskScheduler();
