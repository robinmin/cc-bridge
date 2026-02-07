import fs from "node:fs";
import path from "node:path";
import pino from "pino";

const LOG_DIR = "data/logs";
const LOG_FILE = path.join(LOG_DIR, "combined.log");

// Helper to detect log format from config files early
const detectLogFormat = (): string => {
	if (process.env.LOG_FORMAT) return process.env.LOG_FORMAT;

	const configPaths = ["data/config/gateway.jsonc", "data/config/agent.jsonc"];

	for (const configPath of configPaths) {
		try {
			if (fs.existsSync(configPath)) {
				const content = fs.readFileSync(configPath, "utf-8");
				// Simple regex to find "logFormat": "..." without full JSONC parser to avoid dependencies
				const match = content.match(/"logFormat"\s*:\s*"([^"]+)"/);
				if (match?.[1]) return match[1];
			}
		} catch (_e) {
			// Ignore errors during early detection
		}
	}
	return "json";
};

const detectServiceName = (): string => {
	if (process.env.SERVICE_NAME) return process.env.SERVICE_NAME;

	// Check if we are in a Bun environment and look at the main entry point
	const mainFile = process.argv[1] || "";
	if (mainFile.toLowerCase().includes("gateway")) return "gateway";
	if (mainFile.toLowerCase().includes("agent")) return "agent";

	return "unknown";
};

const serviceName = detectServiceName();
const logFormat = detectLogFormat();

// Map service names to 7-character aligned labels
const SERVICE_LABELS: Record<string, string> = {
	gateway: "Gateway",
	agent: "Agent  ",
	unknown: "Unknown",
};
const workspaceName = process.env.WORKSPACE_NAME;
const label =
	serviceName === "agent" && workspaceName
		? `Agent:${workspaceName}`
		: SERVICE_LABELS[serviceName] || serviceName.padEnd(7).substring(0, 7);

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
	fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Create pino instance
export const logger = pino(
	{
		level: process.env.LOG_LEVEL || "debug",
		base: {
			service: serviceName,
			pid: process.pid,
		},
		serializers: {
			err: pino.stdSerializers.err,
		},
		timestamp: pino.stdTimeFunctions.isoTime,
	},
	logFormat === "text"
		? pino.transport({
				target: "pino-pretty",
				options: {
					destination: LOG_FILE,
					colorize: true,
					translateTime: "SYS:standard",
					singleLine: true,
					mkdir: true,
					ignore: "pid,hostname,service", // Hide these from the trailing metadata block
					// \x1b[0m resets color after the level/time metadata
					messageFormat: `\x1b[0m[${label}] {msg}`,
				},
			})
		: pino.transport({
				target: "pino-roll",
				options: {
					file: LOG_FILE,
					frequency: "daily",
					mkdir: true,
				},
			}),
);

/**
 * Sets the logger level at runtime.
 */
export const setLogLevel = (level: string) => {
	logger.level = level;
};

export default logger;
