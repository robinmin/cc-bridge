import { Hono } from "hono";
import { pinoLogger } from "hono-pino";
import { TelegramChannel } from "@/gateway/channels/telegram";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { instanceManager } from "@/gateway/instance-manager";
import { MailboxWatcher } from "@/gateway/mailbox-watcher";
import { authMiddleware } from "@/gateway/middleware/auth";
import { persistence } from "@/gateway/persistence";
import { AgentBot } from "@/gateway/pipeline/agent-bot";
import { HostBot } from "@/gateway/pipeline/host-bot";
import { MenuBot } from "@/gateway/pipeline/menu-bot";
import { rateLimiter } from "@/gateway/rate-limiter";
import { handleCallbackHealth, handleClaudeCallback } from "@/gateway/routes/claude-callback";
import { handleHealth } from "@/gateway/routes/health";
import { handleWebhook } from "@/gateway/routes/webhook";
import { FileCleanupService } from "@/gateway/services/file-cleanup";
import { FileSystemIpc } from "@/gateway/services/filesystem-ipc";
import { IdempotencyService } from "@/gateway/services/IdempotencyService";
import { RateLimitService } from "@/gateway/services/RateLimitService";
import { ResponseFileReader } from "@/gateway/services/ResponseFileReader";
import { taskScheduler } from "@/gateway/task-scheduler";
import { ConfigLoader } from "@/packages/config";
import { logger, setLogLevel } from "@/packages/logger";

const app = new Hono();

// Custom HTTP logging for better readability (plaintext mode)
app.use("*", async (c, next) => {
	const start = Date.now();
	await next();
	const duration = Date.now() - start;

	// Log HTTP requests in a clean format
	const status = c.res.status;
	const method = c.req.method;
	const path = c.req.path;

	// Format: [GET] /path → 200 (123ms)
	logger.info(`[${method}] ${path} → ${status} (${duration}ms)`);
});

// Pino middleware for structured logging (JSON mode)
app.use("*", pinoLogger({ pino: logger }));

// Load External Configuration
const config = ConfigLoader.load(GATEWAY_CONSTANTS.CONFIG.CONFIG_FILE, GATEWAY_CONSTANTS.DEFAULT_CONFIG);

// Apply log level from config
setLogLevel(config.logLevel);

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PORT = config.port;

if (!BOT_TOKEN) {
	logger.warn("TELEGRAM_BOT_TOKEN is not set.");
}

// Initialize Channel and Bots
const telegram = new TelegramChannel(BOT_TOKEN);
const bots = [new MenuBot(telegram), new HostBot(telegram), new AgentBot(telegram)];

// Initialize Telegram Menu
telegram
	.setMenu(MenuBot.getAllMenus(bots))
	.then(() => logger.info("Telegram bot menu updated"))
	.catch((err) => logger.error({ err }, "Failed to update Telegram bot menu"));

// Start Mailbox Watcher for proactive messages
const mailboxWatcher = new MailboxWatcher(telegram, GATEWAY_CONSTANTS.CONFIG.IPC_DIR, config.ipcPollInterval);
mailboxWatcher.start();

// Start Task Scheduler for proactive prompts
taskScheduler.start();

// Initialize FileSystemIpc for Stop Hook callbacks
const _fileSystemIpc = new FileSystemIpc({
	baseDir: GATEWAY_CONSTANTS.FILESYSTEM_IPC.BASE_DIR,
});

// Initialize FileCleanupService for automatic cleanup of response files
const fileCleanupService = new FileCleanupService({
	baseDir: GATEWAY_CONSTANTS.FILESYSTEM_IPC.BASE_DIR,
	ttlMs: GATEWAY_CONSTANTS.FILESYSTEM_IPC.DEFAULT_FILE_TTL_MS,
	cleanupIntervalMs: GATEWAY_CONSTANTS.FILESYSTEM_IPC.DEFAULT_CLEANUP_INTERVAL_MS,
	enabled: process.env.FILE_CLEANUP_ENABLED !== "false",
});

// Start file cleanup service
fileCleanupService.start().catch((err) => {
	logger.error({ err }, "Failed to start file cleanup service");
});

// Initialize IdempotencyService for duplicate request detection
const idempotencyService = new IdempotencyService({
	maxSize: 10000,
	ttlMs: 3600000, // 1 hour
	cleanupIntervalMs: 300000, // 5 minutes
});

// Initialize RateLimitService for callback rate limiting
const rateLimitService = new RateLimitService({
	workspaceLimit: 100, // per minute
	ipLimit: 200, // per minute
	windowMs: 60000,
	cleanupIntervalMs: 60000,
	whitelistedIps: process.env.WHITELISTED_IPS?.split(",") || [],
});

// Initialize ResponseFileReader for secure file reading
const responseFileReader = new ResponseFileReader({
	ipcBasePath: GATEWAY_CONSTANTS.FILESYSTEM_IPC.BASE_DIR,
	maxFileSize: GATEWAY_CONSTANTS.FILESYSTEM_IPC.MAX_FILE_SIZE_MB * 1024 * 1024,
	maxReadRetries: 3,
	readRetryDelayMs: 100,
});

// Routes
app.get("/health", authMiddleware, handleHealth);
app.post("/webhook", (c) => handleWebhook(c, { telegram, bots }));
app.post("/claude-callback", (c) =>
	handleClaudeCallback(c, {
		telegram,
		idempotencyService,
		rateLimitService,
		responseFileReader,
	}),
);

// Health check for callback services
app.get("/callback-health", (c) =>
	handleCallbackHealth(c, {
		telegram,
		idempotencyService,
		rateLimitService,
		responseFileReader,
	}),
);

// Initial Discovery - wait for it to complete before accepting requests
logger.info("Starting initial instance discovery");
await instanceManager.refresh();

// Periodic Discovery Refresh
const discoveryInterval = setInterval(async () => {
	logger.debug("Running periodic instance discovery refresh");
	await instanceManager.refresh();
}, GATEWAY_CONSTANTS.INSTANCES.REFRESH_INTERVAL_MS);

// Graceful Shutdown
const shutdown = async (signal: string) => {
	logger.info({ signal }, "Shutdown signal received. Closing resources...");
	clearInterval(discoveryInterval);
	await mailboxWatcher.stop();
	await taskScheduler.stop();
	await fileCleanupService.stop();
	idempotencyService.stopCleanup();
	rateLimitService.stopCleanup();
	rateLimiter.stop();
	persistence.close();
	logger.info("Gateway shutdown complete.");
	process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export default {
	port: PORT,
	fetch: app.fetch,
};
