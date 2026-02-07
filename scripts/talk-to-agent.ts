import { executeClaudeRaw } from "../src/gateway/services/claude-executor";

async function main() {
    const msg = process.argv.slice(2).join(" ");
    if (!msg) {
        console.error("Usage: bun run scripts/talk-to-agent.ts <message>");
        process.exit(1);
    }

    // Wrap the message in the <messages> format
    const prompt = `<messages>\n<message sender="user">${msg}</message>\n</messages>`;

    // Container name and instance name from environment or defaults
    const containerId = process.env.CONTAINER_ID || "claude-cc-bridge";
    const instanceName = process.env.INSTANCE_NAME || "cc-bridge";

    try {
        const result = await executeClaudeRaw(containerId, instanceName, prompt, {
            allowDangerouslySkipPermissions: true,
            allowedTools: "*",
        });

        if (result.success) {
            process.stdout.write((result.output ?? "") + "\n");
        } else {
            console.error(`❌ Agent Error: ${result.error}`);
            process.exit(result.retryable ? 2 : 1);
        }
    } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`❌ Gateway Error: ${errorMsg}`);
        process.exit(1);
    }
}

main();
