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
        WORKSPACE_ROOT: "/Users/robin/xprojects"
    },
    INSTANCES: {
        LABEL: "cc-bridge.workspace",
        REFRESH_INTERVAL_MS: 30000,
    },
    DIAGNOSTICS: {
        URLS: {
            TELEGRAM_API_BASE: "https://api.telegram.org",
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
        serviceName: "gateway"
    }
};
