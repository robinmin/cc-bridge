import { IpcClient } from "../src/packages/ipc/client";

async function main() {
    const msg = process.argv.slice(2).join(" ");
    if (!msg) {
        console.error("Usage: bun run scripts/talk-to-agent.ts <message>");
        process.exit(1);
    }

    // Mimic src/gateway/pipeline/agent-bot.ts exactly
    // Wrap the message in the <messages> format
    const prompt = `<messages>\n<message sender="user">${msg}</message>\n</messages>`;

    // Container name and instance name from environment or defaults
    const containerId = process.env.CONTAINER_ID || "claude-cc-bridge";
    const instanceName = process.env.INSTANCE_NAME || "cc-bridge";

    const client = new IpcClient(containerId, instanceName);

    try {
        const response = await client.sendRequest({
            id: Math.random().toString(36).substring(7),
            method: "POST",
            path: "/execute",
            body: {
                command: "claude",
                args: [
                    "-p", prompt,
                    "--allow-dangerously-skip-permissions",
                ]
            }
        });

        if (response.error) {
            console.error(`❌ Agent Error: ${response.error.message}`);
            process.exit(1);
        } else if (response.result) {
            const result = response.result as any;
            const output = result.stdout || result.content || JSON.stringify(result);
            process.stdout.write(output + "\n");
        }
    } catch (error: any) {
        console.error(`❌ Gateway Error: ${error.message}`);
        process.exit(1);
    }
}

main();
