import path from "node:path";

export const GATEWAY_CONSTANTS = {
  HEALTH: {
    STATUS_OK: "ok",
    RUNTIME_BUN: "bun",
  },
  CONFIG: {
    DEFAULT_PORT: 8080,
    IPC_DIR: "data/ipc",
    IPC_POLL_INTERVAL_MS: 1000,
    CONFIG_FILE: "data/config/gateway.jsonc",
    // Root directory containing all project workspaces (default: ~/xprojects)
    // Can be set via environment variable PROJECTS_ROOT or PROJECTS_ROOT
    // Can also be set in gateway.jsonc config file as "projectsRoot"
    PROJECTS_ROOT:
      process.env.PROJECTS_ROOT ||
      process.env.PROJECTS_ROOT ||
      path.join(
        process.env.HOME || process.env.USERPROFILE || ".",
        "xprojects",
      ),
    // Read from environment variable with fallback to current directory parent
    WORKSPACE_ROOT:
      process.env.WORKSPACE_ROOT ||
      process.env.PROJECTS_ROOT ||
      path.resolve(".."),
  },
  INSTANCES: {
    LABEL: "cc-bridge.workspace",
    REFRESH_INTERVAL_MS: 30000,
  },
  DIAGNOSTICS: {
    URLS: {
      TELEGRAM_API_BASE: "https://api.telegram.org",
      FEISHU_API_BASE: "https://open.feishu.cn",
      LARK_API_BASE: "https://open.larksuite.com",
      ANTHROPIC_API_BASE: "https://api.anthropic.com",
    },
    DAEMONS: {
      CC_BRIDGE: {
        ID: "com.cc-bridge.daemon",
        PATTERN: "src/gateway/index.ts",
      },
      CLOUDFLARED: {
        ID: "com.cloudflare.cloudflared.daemon",
        PATTERN: "cloudflared",
      },
      ORBSTACK: {
        ID: "dev.orbstack.OrbStack.privhelper",
        PATTERN: "OrbStack",
      },
    },
    FILESYSTEM: {
      PERSISTENCE: "data/gateway.db",
      LOGS: "data/logs",
    },
    TIMEOUT_MS: 3000,
  },
  DEFAULT_CONFIG: {
    port: 8080,
    ipcPollInterval: 1000,
    refreshInterval: 30000,
    logLevel: "debug",
    logFormat: "json",
    serviceName: "gateway",
    projectsRoot:
      process.env.PROJECTS_ROOT ||
      path.join(
        process.env.HOME || process.env.USERPROFILE || ".",
        "xprojects",
      ),
    feishu: {
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
      domain: (process.env.FEISHU_DOMAIN as "feishu" | "lark") || "feishu",
      encryptKey: process.env.FEISHU_ENCRYPT_KEY || "",
    },
    uploads: {
      enabled: true,
      allowedMimeTypes: [
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/json",
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
      maxTextBytes: 5 * 1024 * 1024,
      maxImageBytes: 20 * 1024 * 1024,
      retentionHours: 24,
      storageDir: "data/uploads",
    },
  },
  FILESYSTEM_IPC: {
    BASE_DIR: process.env.IPC_BASE_DIR || "data/ipc",
    RESPONSE_DIR: "responses",
    REQUEST_DIR: "requests",
    DEFAULT_RESPONSE_TIMEOUT_MS: 30000, // 30 seconds
    DEFAULT_CLEANUP_INTERVAL_MS: 300000, // 5 minutes
    DEFAULT_FILE_TTL_MS: 3600000, // 1 hour
    RETRY_DELAY_MS: 100,
    MAX_FILE_SIZE_MB: 100, // 100MB max file size
    // Prefer callback payload output over filesystem when enabled
    USE_CALLBACK_PAYLOAD:
      process.env.IPC_MODE === "callback_payload" ||
      process.env.AGENT_MODE === "callback_payload" ||
      process.env.IPC_MODE === "hybrid" ||
      process.env.AGENT_MODE === "hybrid",
  },
  TMUX: {
    SESSION_PREFIX: "claude",
    MAX_SESSIONS_PER_CONTAINER: 10,
    DEFAULT_IDLE_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes
    SESSION_NAME_SEPARATOR: "-",
    ENABLED: process.env.ENABLE_TMUX === "true", // Global tmux mode flag
  },
};
