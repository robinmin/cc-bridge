import { Hono } from "hono";
import { pinoLogger } from "hono-pino";
import { logger, setLogLevel } from "@/packages/logger";
import { ConfigLoader } from "@/packages/config";
import { AGENT_CONSTANTS } from "@/agent/consts";
import executeRoute from "@/agent/routes/execute";
import fsRoute from "@/agent/routes/fs";
import readRoute from "@/agent/routes/read";
import writeRoute from "@/agent/routes/write";
import notifyRoute from "@/agent/routes/notify";
import healthHandler from "@/agent/routes/health";

const app = new Hono();

// Redirect console to pino to keep stdout pure for IPC
console.log = (...args) => logger.info(args.length === 1 ? args[0] : args);
console.error = (...args) => logger.error(args.length === 1 ? args[0] : args);
console.warn = (...args) => logger.warn(args.length === 1 ? args[0] : args);
console.debug = (...args) => logger.debug(args.length === 1 ? args[0] : args);

// Middleware
app.use("*", pinoLogger({ pino: logger }));

// Load External Configuration
const config = ConfigLoader.load(AGENT_CONSTANTS.EXECUTION.CONFIG_FILE, AGENT_CONSTANTS.DEFAULT_CONFIG);

// Apply log level from config
setLogLevel(config.logLevel);

// Routes
app.route("/execute", executeRoute);
app.route("/read", readRoute);
app.route("/write", writeRoute);
app.route("/fs", fsRoute);
app.route("/notify", notifyRoute);

app.get("/health", healthHandler);

export { app };
