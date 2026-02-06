import { StdioIpcAdapter } from "@/packages/ipc";
import { app } from "@/agent/app";
import { AGENT_CONSTANTS } from "@/agent/consts";
import fs from "node:fs";

// IPC Startup
if (import.meta.main) {
	const socketPath = process.env.AGENT_SOCKET || AGENT_CONSTANTS.EXECUTION.AGENT_SOCKET;

	// Detect if we should run as a persistent server or one-shot stdio adapter
	const isServerMode = process.env.AGENT_MODE === "server";
	const isStdioForced = process.env.AGENT_MODE === "stdio";

	if (isServerMode && !isStdioForced && socketPath) {
		// Persistent Unix Socket Server Mode
		if (fs.existsSync(socketPath)) {
			fs.unlinkSync(socketPath);
		}
		console.info(`Starting persistent agent server on ${socketPath}`);
		Bun.serve({
			unix: socketPath,
			fetch: app.fetch,
		});
	} else {
		// One-shot Stdio IPC Mode (Default/Fallback)
		const adapter = new StdioIpcAdapter(app);
		adapter.start();
	}
}
export { app };
