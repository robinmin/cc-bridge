import { type IpcRequest, type IpcResponse } from "@/packages/types";
import path from "node:path";
import fs from "node:fs";

export class IpcClient {
    private socketPath: string | null = null;

    constructor(private containerId: string, private instanceName?: string) {
        if (this.instanceName) {
            // Check for Unix socket on host (shared volume)
            const hostSocket = path.resolve("data/ipc", this.instanceName, "agent.sock");
            if (fs.existsSync(hostSocket)) {
                this.socketPath = hostSocket;
            }
        }
    }

    async sendRequest(request: IpcRequest): Promise<IpcResponse> {
        // NOTE: Unix socket fetch from host to container is incompatible with macOS Docker volumes.
        // We revert to docker exec but force AGENT_MODE=stdio to ensure it works alongside the server.
        return this.sendViaDockerExec(request);
    }

    private async sendViaDockerExec(request: IpcRequest): Promise<IpcResponse> {
        const payload = JSON.stringify(request);

        // Force stido mode to ensure we don't try to start a second server inside the container
        const proc = Bun.spawn(["docker", "exec", "-i", "-e", "AGENT_MODE=stdio", this.containerId, "bun", "run", "src/agent/index.ts"], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });

        const writer = proc.stdin;
        writer.write(payload + "\n");
        writer.flush();
        writer.end();

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0 && !stdout) {
            const errorMsg = stderr.trim() || `Agent exited with code ${exitCode}`;
            return {
                id: request.id,
                status: 500,
                error: { message: errorMsg },
            };
        }

        try {
            const lines = stdout.trim().split("\n");
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line.startsWith("{") || !line.endsWith("}")) continue;

                try {
                    const parsed = JSON.parse(line);
                    if (parsed && typeof parsed === "object" && parsed.id === request.id) {
                        return parsed as IpcResponse;
                    }
                } catch { continue; }
            }
            throw new Error(`Could not find valid JSON response with ID ${request.id} in output`);
        } catch (error: any) {
            return {
                id: request.id,
                status: 500,
                error: { message: `IPC Error: ${error.message}` },
            };
        }
    }
}
