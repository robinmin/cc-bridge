import fs from "node:fs";
import { AgentHttpServer } from "@/agent/api/server";
import { logger } from "@/packages/logger";
import { app } from "@/agent/app";
import { AGENT_CONSTANTS } from "@/agent/consts";
import { createGatewayBackedAgentRuntime } from "@/agent/runtime/gateway-adapter";
import { StdioIpcAdapter } from "./ipc-adapter";

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
		logger.info("Starting agent HTTP API server");

		const runtime = createGatewayBackedAgentRuntime({
			containerId: process.env.AGENT_CONTAINER_ID || "claude-agent",
			stateBaseDir: AGENT_CONSTANTS.STATE_BASE_DIR,
		});
		const { tmuxManager, sessionPool, requestTracker } = runtime;

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
				logger.info({ port: httpServer.getPort() }, "HTTP API server listening");
			})
			.catch((err) => {
				logger.error({ err }, "Failed to start HTTP server");
				process.exit(1);
			});

		// Graceful shutdown
		const shutdown = async () => {
			logger.info("Shutting down HTTP server...");
			await Promise.all([httpServer.stop(), sessionPool.stop(), requestTracker.stop(), tmuxManager.stop()]);
			process.exit(0);
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);
	} else if (isTcpMode) {
		// TCP Server Mode (for faster IPC from host)
		const port = Number.parseInt(process.env.AGENT_TCP_PORT || "3001", 10);
		logger.info({ port }, "Starting agent TCP server");
		const server = Bun.serve({
			port,
			hostname: "0.0.0.0",
			fetch: app.fetch,
		});
		const shutdown = () => {
			logger.info("Shutting down TCP server...");
			server.stop(true);
			process.exit(0);
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);
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
		logger.info({ socketPath }, "Starting persistent agent server");
		const server = Bun.serve({
			unix: socketPath,
			fetch: app.fetch,
		});
		const shutdown = () => {
			logger.info("Shutting down unix socket server...");
			server.stop(true);
			process.exit(0);
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);
	} else {
		// One-shot Stdio IPC Mode (Default/Fallback)
		const adapter = new StdioIpcAdapter(app);
		adapter.start();
	}
}
export { app };
