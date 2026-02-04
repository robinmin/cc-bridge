import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { logger } from "@/packages/logger";
import fs from "node:fs";
import path from "node:path";

export interface AgentInstance {
    name: string;
    containerId: string;
    status: string;
    image: string;
}

export class InstanceManager {
    private instances: Map<string, AgentInstance> = new Map();

    async refresh(): Promise<AgentInstance[]> {
        try {
            // Discover containers with the specific label
            const proc = Bun.spawn([
                "docker", "ps", "-a",
                "--filter", `label=${GATEWAY_CONSTANTS.INSTANCES.LABEL}`,
                "--format", "{{json .}}"
            ]);

            const output = await new Response(proc.stdout).text();
            const lines = output.trim().split("\n");

            const newInstances = new Map<string, AgentInstance>();

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const data = JSON.parse(line);
                    // data example: {"ID":"...","Names":"...","Status":"...","Labels":"...","Image":"..."}

                    // Parse labels to get the actual instance name if provided
                    const labels = data.Labels.split(",").reduce((acc: any, curr: string) => {
                        const [key, val] = curr.split("=");
                        acc[key] = val;
                        return acc;
                    }, {});

                    const name = labels[GATEWAY_CONSTANTS.INSTANCES.LABEL] || data.Names;

                    newInstances.set(name, {
                        name,
                        containerId: data.ID,
                        status: data.Status.toLowerCase().includes("up") ? "running" : "stopped",
                        image: data.Image
                    });
                } catch (e) {
                    logger.error({ line, error: e }, "Error parsing docker ps output");
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
            console.error("Failed to refresh instances:", error);
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
     * Discovers all subdirectories under WORKSPACE_ROOT.
     */
    async getWorkspaceFolders(): Promise<string[]> {
        const root = GATEWAY_CONSTANTS.CONFIG.WORKSPACE_ROOT;
        try {
            if (!fs.existsSync(root)) return [];
            const dirs = await fs.promises.readdir(root, { withFileTypes: true });
            return dirs
                .filter(d => d.isDirectory() && !d.name.startsWith("."))
                .map(d => d.name);
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
