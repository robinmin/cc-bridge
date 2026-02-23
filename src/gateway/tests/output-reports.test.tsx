import { describe, expect, test } from "bun:test";
import { HealthReport } from "@/gateway/output/HealthReport";
import { WorkspaceList, WorkspaceStatus } from "@/gateway/output/WorkspaceReport";

describe("output reports", () => {
	test("renders health report in telegram and terminal formats", () => {
		const data = {
			time: "2026-02-22T10:00:00.000Z",
			status: "ok",
			runtime: "bun",
			version: "1.0.0",
			env: {
				TELEGRAM_BOT_TOKEN: { sensitive: true, status: true },
				ANTHROPIC_AUTH: { sensitive: true, status: true },
				PORT: { sensitive: false, value: "8080" },
				NODE_ENV: { sensitive: false, value: "test" },
				URL: { sensitive: false, value: "http://localhost:8080" },
			},
			connectivity: { telegram: true, anthropic: true },
			daemons: { "cc-bridge": { status: "ok" }, cloudflared: { status: "warn" }, orbstack: { status: "ok" } },
			filesystem: {
				persistence: { status: "ok", path: "/tmp/p" },
				logs: { status: "ok", path: "/tmp/l" },
				mailbox: { status: "ok", path: "/tmp/m" },
				config: { status: "ok", path: "/tmp/c" },
			},
			instances: { running: 1, total: 2 },
			mailbox_stats: { pending_proactive_messages: 0 },
			docker: [{ name: "agent-a", image: "img:latest", status: "Up 1h" }],
		};

		const telegram = HealthReport({ data, format: "telegram" });
		const terminal = HealthReport({ data, format: "terminal" });

		expect(telegram).toContain("CC-BRIDGE SYSTEM HEALTH");
		expect(telegram).toContain("Docker Instances");
		expect(terminal).toContain("Gateway:");
		expect(terminal).toContain("Workspaces:");
	});

	test("renders workspace list and status variants", () => {
		const list = WorkspaceList({
			workspaces: [
				{ name: "zeta", status: "stopped", isActive: false },
				{ name: "alpha", status: "running", isActive: true },
			],
			format: "telegram",
			currentSession: "alpha",
		});
		expect(list).toContain("alpha");
		expect(list).toContain("/ws_switch");

		const statusRunning = WorkspaceStatus({
			current: "alpha",
			status: "running",
			format: "terminal",
		});
		const statusNone = WorkspaceStatus({
			current: null,
			status: "stopped",
			format: "telegram",
		});

		expect(statusRunning).toContain("Running");
		expect(statusNone).toContain("None selected");
	});
});
