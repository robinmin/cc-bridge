import { type IpcRequest, type IpcResponse } from "@/packages/types";

export class IpcClient {
    constructor(private containerId: string) { }

    async sendRequest(request: IpcRequest): Promise<IpcResponse> {
        const payload = JSON.stringify(request);

        // We use docker exec -i to send the request to the agent's stdin
        const proc = Bun.spawn(["docker", "exec", "-i", this.containerId, "bun", "run", "src/agent/index.ts"], {
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
                error: {
                    message: errorMsg,
                },
            };
        }

        try {
            // Find the line that is valid JSON and matches our request ID
            const lines = stdout.trim().split("\n");
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line.startsWith("{") || !line.endsWith("}")) continue;

                try {
                    const parsed = JSON.parse(line);
                    if (parsed && typeof parsed === "object" && parsed.id === request.id) {
                        return parsed as IpcResponse;
                    }
                } catch {
                    continue;
                }
            }
            throw new Error(`Could not find valid JSON response with ID ${request.id} in output: ${stdout}`);
        } catch (error: any) {
            return {
                id: request.id,
                status: 500,
                error: {
                    message: `IPC Error: ${error.message}`,
                },
            };
        }
    }
}
