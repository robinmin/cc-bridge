import { Hono } from "hono";
import { pinoLogger } from "hono-pino";
import { logger, setLogLevel } from "@/packages/logger";
import { ConfigLoader } from "@/packages/config";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { TelegramChannel } from "@/gateway/channels/telegram";
import { MenuBot } from "@/gateway/pipeline/menu-bot";
import { HostBot } from "@/gateway/pipeline/host-bot";
import { AgentBot } from "@/gateway/pipeline/agent-bot";
import { instanceManager } from "@/gateway/instance-manager";
import { MailboxWatcher } from "@/gateway/mailbox-watcher";
import { taskScheduler } from "@/gateway/task-scheduler";
import { persistence } from "@/gateway/persistence";

import { handleHealth } from "@/gateway/routes/health";
import { handleWebhook } from "@/gateway/routes/webhook";

const app = new Hono();

// Middleware
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
const bots = [
    new MenuBot(telegram),
    new HostBot(telegram),
    new AgentBot(telegram)
];

// Initialize Telegram Menu
telegram.setMenu(MenuBot.getAllMenus(bots))
    .then(() => logger.info("Telegram bot menu updated"))
    .catch(err => logger.error({ err }, "Failed to update Telegram bot menu"));

// Start Mailbox Watcher for proactive messages
const mailboxWatcher = new MailboxWatcher(telegram, GATEWAY_CONSTANTS.CONFIG.IPC_DIR, config.ipcPollInterval);
mailboxWatcher.start();

// Start Task Scheduler for proactive prompts
taskScheduler.start();

// Routes
app.get("/health", handleHealth);
app.post("/webhook", (c) => handleWebhook(c, { telegram, bots }));

// Initial Discovery
logger.info("Starting initial instance discovery");
instanceManager.refresh();

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
