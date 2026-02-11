import fs from "node:fs";
import path from "node:path";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { logger } from "@/packages/logger";

export interface AgentInstance {
	name: string;
	containerId: string;
	status: string;
	image: string;
}

export class InstanceManager {
	private instances: Map<string, AgentInstance> = new Map();
	private parseErrorCount = 0;
	private totalParseAttempts = 0;

	async refresh(): Promise<AgentInstance[]> {
		try {
			// Discover containers with the specific label
			const proc = Bun.spawn([
				"docker",
				"ps",
				"-a",
				"--filter",
				`label=${GATEWAY_CONSTANTS.INSTANCES.LABEL}`,
				"--format",
				"{{json .}}",
			]);

			// Wait for process to complete and read output
			await proc.exited;
			const output = await new Response(proc.stdout).text();
			const lines = output.trim().split("\n");

			const newInstances = new Map<string, AgentInstance>();

			for (const line of lines) {
				if (!line.trim()) continue;
				this.totalParseAttempts++;

				try {
					const data = JSON.parse(line);
					// data example: {"ID":"...","Names":"...","Status":"...","Labels":"...","Image":"..."}

					// Parse labels to get the actual instance name if provided
					const labels = data.Labels.split(",").reduce(
						(acc: Record<string, string>, curr: string) => {
							const [key, val] = curr.split("=");
							acc[key] = val;
							return acc;
						},
						{} as Record<string, string>,
					);

					const name = labels[GATEWAY_CONSTANTS.INSTANCES.LABEL] || data.Names;

					newInstances.set(name, {
						name,
						containerId: data.ID,
						status: data.Status.toLowerCase().includes("up") ? "running" : "stopped",
						image: data.Image,
					});
				} catch (e) {
					this.parseErrorCount++;
					logger.warn({ line, error: e }, "Error parsing docker ps output");
				}
			}

			this.instances = newInstances;
			logger.debug({ count: this.instances.size }, "Discovered agent instances");

			// Setup IPC directories for all discovered instances
			for (const instance of this.instances.values()) {
				this.setupIpcDirectories(instance.name);
			}

			return Array.from(this.instances.values());
		} catch (error) {
			logger.error({ error }, "Failed to refresh instances");
			return Array.from(this.instances.values());
		}
	}

	private setupIpcDirectories(instanceName: string) {
		const baseDir = path.resolve(GATEWAY_CONSTANTS.CONFIG.IPC_DIR, instanceName);
		const dirs = ["messages", "tasks", "snapshots"];

		for (const dir of dirs) {
			const fullPath = path.join(baseDir, dir);
			if (!fs.existsSync(fullPath)) {
				fs.mkdirSync(fullPath, { recursive: true });
			}
		}
	}

	getInstances(): AgentInstance[] {
		return Array.from(this.instances.values());
	}

	/**
	 * Get parsing metrics for monitoring error rates
	 */
	getMetrics(): { parseErrorCount: number; errorRate: number } {
		return {
			parseErrorCount: this.parseErrorCount,
			errorRate: this.totalParseAttempts > 0 ? this.parseErrorCount / this.totalParseAttempts : 0,
		};
	}

	/**
	 * Discovers all subdirectories under WORKSPACE_ROOT.
	 */
	async getWorkspaceFolders(): Promise<string[]> {
		const root = GATEWAY_CONSTANTS.CONFIG.WORKSPACE_ROOT;
		try {
			if (!fs.existsSync(root)) return [];
			const dirs = await fs.promises.readdir(root, { withFileTypes: true });
			return dirs.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
		} catch (error) {
			logger.error({ error, root }, "Failed to list workspace folders");
			return [];
		}
	}

	getInstance(name: string): AgentInstance | undefined {
		return this.instances.get(name);
	}
}

export const instanceManager = new InstanceManager();
