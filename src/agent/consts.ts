/**
 * Agent-wide constants
 */

export const AGENT_CONSTANTS = {
	// --- Execution Settings ---
	EXECUTION: {
		DEFAULT_TIMEOUT_MS: 120000,
		MAX_OUTPUT_SIZE_BYTES: 10 * 1024 * 1024, // 10MB
		TIMEOUT_EXIT_CODE: 124,
		ERROR_EXIT_CODE: -1,
		IPC_DIR: "data/ipc",
		AGENT_SOCKET: "data/ipc/agent.sock",
		CONFIG_FILE: "data/config/agent.jsonc",
	},

	// --- State Management ---
	STATE_BASE_DIR: "data/state",

	// --- File Operations ---
	FILES: {
		ENCODING_UTF8: "utf-8",
		ENCODING_BASE64: "base64",
	},

	// --- Health Check ---
	HEALTH: {
		STATUS_OK: "ok",
		RUNTIME_BUN: "bun",
	},

	// --- HTTP Status Codes ---
	HTTP: {
		OK: 200,
		BAD_REQUEST: 400,
		INTERNAL_SERVER_ERROR: 500,
	},
	DEFAULT_CONFIG: {
		healthStatus: "ok",
		healthRuntime: "bun",
		logLevel: "debug",
	},
};
