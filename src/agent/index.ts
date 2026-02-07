import fs from "node:fs";
import { app } from "@/agent/app";
import { AGENT_CONSTANTS } from "@/agent/consts";
import { StdioIpcAdapter } from "@/packages/ipc";

// IPC Startup
if (import.meta.main) {
	const socketPath =
		process.env.AGENT_SOCKET || AGENT_CONSTANTS.EXECUTION.AGENT_SOCKET;

	// Detect if we should run as a persistent server or one-shot stdio adapter
	const isServerMode = process.env.AGENT_MODE === "server";
	const isStdioForced = process.env.AGENT_MODE === "stdio";

	if (isServerMode && !isStdioForced && socketPath) {
		// Persistent Unix Socket Server Mode
		// Ensure parent directory exists
		const socketDir = socketPath.substring(0, socketPath.lastIndexOf("/"));
		if (!fs.existsSync(socketDir)) {
			fs.mkdirSync(socketDir, { recursive: true });
		}

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
