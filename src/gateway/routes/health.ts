import { type Context } from "hono";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { instanceManager } from "@/gateway/instance-manager";
import { TelegramChannel } from "@/gateway/channels/telegram";
import { HealthReport } from "@/gateway/output/HealthReport";
import { prefersJson, getOutputFormat } from "@/gateway/utils/request-utils";
import fs from "node:fs/promises";
import path from "node:path";

export const handleHealth = async (c: Context) => {
    const instances = instanceManager.getInstances();
    const runningInstances = instances.filter((i) => i.status === "running");

    const fsCfg = GATEWAY_CONSTANTS.DIAGNOSTICS.FILESYSTEM;
    const ipcDir = GATEWAY_CONSTANTS.CONFIG.IPC_DIR;
    const configPath = GATEWAY_CONSTANTS.CONFIG.CONFIG_FILE;

    const diagnostics: any = {
        time: new Date().toISOString(),
        env: {
            TELEGRAM_BOT_TOKEN: { sensitive: true, status: !!process.env.TELEGRAM_BOT_TOKEN },
            ANTHROPIC_AUTH: {
                sensitive: true,
                status: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
            },
            PORT: { sensitive: false, value: process.env.PORT || "8080" },
            NODE_ENV: { sensitive: false, value: process.env.NODE_ENV || "development" },
            URL: { sensitive: false, value: process.env.CC_BRIDGE_SERVER_URL || "http://localhost:8080" },
        },
        connectivity: {},
        daemons: {},
        filesystem: {},
        instances: {
            total: instances.length,
            running: runningInstances.length,
            names: instances.map((i) => i.name),
        },
        docker: [],
    };

    const timeout = GATEWAY_CONSTANTS.DIAGNOSTICS.TIMEOUT_MS;

    // 1. External Connectivity Checks
    try {
        const tgRes = await fetch(GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE, {
            signal: AbortSignal.timeout(timeout),
        });
        diagnostics.connectivity.telegram = tgRes.ok;
    } catch {
        diagnostics.connectivity.telegram = false;
    }

    const anthropicUrl =
        process.env.ANTHROPIC_BASE_URL || GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.ANTHROPIC_API_BASE;
    try {
        const antRes = await fetch(anthropicUrl, { signal: AbortSignal.timeout(timeout) });
        diagnostics.connectivity.anthropic = antRes.status < 500;
    } catch {
        diagnostics.connectivity.anthropic = false;
    }

    // 2. Webhook Info
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
        try {
            const channel = new TelegramChannel(botToken);
            const whData = await channel.getStatus();
            diagnostics.webhook = {
                url: whData.result?.url || "Not set",
                pending_updates: whData.result?.pending_update_count || 0,
            };
        } catch {
            diagnostics.webhook = "Error fetching info";
        }
    }

    // 3. System Daemons
    const checkDaemon = async (name: string, pattern: string) => {
        try {
            if (name.includes(".")) {
                const lProc = Bun.spawn(["launchctl", "list", name], { stderr: "pipe" });
                const lExit = await lProc.exited;
                if (lExit === 0) return { status: "running" };
            }
            const pProc = Bun.spawn(["pgrep", "-f", pattern], { stderr: "pipe" });
            const pExit = await pProc.exited;
            return { status: pExit === 0 ? "running" : "stopped" };
        } catch {
            return { status: "unknown" };
        }
    };

    const daemons = GATEWAY_CONSTANTS.DIAGNOSTICS.DAEMONS;
    diagnostics.daemons["cc-bridge"] = await checkDaemon(daemons.CC_BRIDGE.ID, daemons.CC_BRIDGE.PATTERN);
    diagnostics.daemons["cloudflared"] = await checkDaemon(
        daemons.CLOUDFLARED.ID,
        daemons.CLOUDFLARED.PATTERN,
    );
    diagnostics.daemons["orbstack"] = await checkDaemon(daemons.ORBSTACK.ID, daemons.ORBSTACK.PATTERN);

    // 3.5 Docker Instance List
    try {
        const dProc = Bun.spawn(
            ["docker", "ps", "-a", "--filter", "name=claude-cc-bridge", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}"],
            { stderr: "pipe" },
        );
        const dOut = await new Response(dProc.stdout).text();
        diagnostics.docker = dOut
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const [name, image, status] = line.split("\t");
                return { name, image, status };
            });
    } catch {
        diagnostics.docker = [];
    }

    // 4. Filesystem
    const checkFs = async (target: string) => {
        try {
            await fs.access(target, fs.constants.R_OK | fs.constants.W_OK);
            return "ok";
        } catch {
            try {
                await fs.access(target, fs.constants.R_OK);
                return "read-only";
            } catch {
                return "missing/no-access";
            }
        }
    };

    diagnostics.filesystem = {
        persistence: { path: fsCfg.PERSISTENCE, status: await checkFs(fsCfg.PERSISTENCE) },
        logs: { path: fsCfg.LOGS, status: await checkFs(fsCfg.LOGS) },
        mailbox: { path: ipcDir, status: await checkFs(ipcDir) },
        config: { path: configPath, status: await checkFs(configPath) },
    };

    // 5. Mailbox Stats
    let pendingCount = 0;
    try {
        const instanceDirs = await fs.readdir(ipcDir);
        for (const inst of instanceDirs) {
            const msgDir = path.join(ipcDir, inst, "messages");
            try {
                const files = await fs.readdir(msgDir);
                pendingCount += files.filter((f) => f.endsWith(".json")).length;
            } catch {
                // Skip missing msg dirs
            }
        }
        diagnostics.mailbox_stats = {
            pending_proactive_messages: pendingCount,
        };
    } catch {
        diagnostics.mailbox_stats = "error reading mailbox";
    }

    // Overall Status Logic
    let status = GATEWAY_CONSTANTS.HEALTH.STATUS_OK;
    const fsStatus = diagnostics.filesystem;
    if (
        diagnostics.instances.total === 0 ||
        !diagnostics.env.TELEGRAM_BOT_TOKEN.status ||
        fsStatus.persistence.status !== "ok" ||
        fsStatus.mailbox.status !== "ok"
    ) {
        status = "warn";
    }
    if (!diagnostics.connectivity.telegram) {
        status = "error";
    }

    const data = {
        status,
        runtime: GATEWAY_CONSTANTS.HEALTH.RUNTIME_BUN,
        version: Bun.version,
        ...diagnostics,
    };

    if (prefersJson(c) && !c.req.query("format")) {
        return c.json(data);
    }

    const format = getOutputFormat(c);
    const report = HealthReport({ data, format });
    return c.text(report);
};
