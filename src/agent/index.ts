import fs from "node:fs";
import { AgentHttpServer } from "@/agent/api/server";
import { app } from "@/agent/app";
import { AGENT_CONSTANTS } from "@/agent/consts";
import { RequestTracker } from "@/gateway/services/RequestTracker";
import { SessionPoolService } from "@/gateway/services/SessionPoolService";
import { TmuxManager } from "@/gateway/services/tmux-manager";
import { StdioIpcAdapter } from "@/packages/ipc";

// IPC Startup
if (import.meta.main) {
	const socketPath = process.env.AGENT_SOCKET || AGENT_CONSTANTS.EXECUTION.AGENT_SOCKET;

	// Detect if we should run as a persistent server or one-shot stdio adapter
	const isServerMode = process.env.AGENT_MODE === "server";
	const isStdioForced = process.env.AGENT_MODE === "stdio";
	const isHttpMode = process.env.AGENT_MODE === "http";
	const isTcpMode = process.env.AGENT_MODE === "tcp";

	if (isHttpMode) {
		// HTTP API Server Mode
		console.info("Starting agent HTTP API server");

		const tmuxManager = new TmuxManager();
		const sessionPool = new SessionPoolService(tmuxManager, {
			containerId: process.env.AGENT_CONTAINER_ID || "claude-agent",
		});
		const requestTracker = new RequestTracker({
			stateBaseDir: AGENT_CONSTANTS.STATE_BASE_DIR,
		});

		const httpServer = new AgentHttpServer(
			{
				port: Number.parseInt(process.env.HTTP_PORT || "3000", 10),
				host: process.env.HTTP_HOST || "0.0.0.0",
				apiKey: process.env.HTTP_API_KEY || "change-me-in-production",
				enableAuth: process.env.HTTP_AUTH !== "false",
				rateLimitMax: Number.parseInt(process.env.HTTP_RATE_LIMIT_MAX || "100", 10),
				rateLimitWindow: process.env.HTTP_RATE_LIMIT_WINDOW || "1 minute",
			},
			sessionPool,
			requestTracker,
			tmuxManager,
		);

		// Start services
		Promise.all([tmuxManager.start(), requestTracker.start(), sessionPool.start(), httpServer.start()])
			.then(() => {
				console.info(`HTTP API server listening on port ${httpServer.config.port}`);
			})
			.catch((err) => {
				console.error("Failed to start HTTP server:", err);
				process.exit(1);
			});

		// Graceful shutdown
		process.on("SIGTERM", async () => {
			console.info("Shutting down HTTP server...");
			await Promise.all([httpServer.stop(), sessionPool.stop(), requestTracker.stop(), tmuxManager.stop()]);
			process.exit(0);
		});
	} else if (isTcpMode) {
		// TCP Server Mode (for faster IPC from host)
		const port = Number.parseInt(process.env.AGENT_TCP_PORT || "3001", 10);
		console.info(`Starting agent TCP server on port ${port}`);
		Bun.serve({
			port,
			hostname: "0.0.0.0",
			fetch: app.fetch,
		});
	} else if (isServerMode && !isStdioForced && socketPath) {
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
