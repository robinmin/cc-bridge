/** @jsxImportSource hono/jsx */

import { renderTemplate } from "@/packages/template";
import { Header, Section, StatusIcon } from "./common";

interface HealthData {
	time: string;
	status?: string;
	runtime?: string;
	version?: string;
	env: Record<string, { sensitive: boolean; status?: boolean; value?: string }>;
	connectivity: Record<string, boolean>;
	daemons: Record<string, { status?: string }>;
	filesystem: Record<string, { status?: string; path?: string }>;
	instances: { running: number; total: number };
	mailbox_stats: { pending_proactive_messages: number } | string;
	docker: Array<{ name: string; image: string; status: string }>;
	[key: string]: unknown;
}

export const HealthReport = ({ data, format }: { data: HealthData; format: "telegram" | "terminal" }) => {
	const conn = data.connectivity || {};
	const env = data.env || {};
	const fs = data.filesystem || {};
	const daemons = data.daemons || {};
	const insts = data.instances || { running: 0, total: 0 };
	const stats = data.mailbox_stats || { pending_proactive_messages: 0 };
	const docker = data.docker || [];

	const RED = "\x1b[31m";
	const GREEN = "\x1b[32m";
	const YELLOW = "\x1b[33m";
	const BLUE = "\x1b[34m";
	const MAGENTA = "\x1b[35m";
	const RESET = "\x1b[0m";

	const colorStatus = (s: string) => {
		if (format === "telegram") return s.toUpperCase();
		if (s === "ok") return `${GREEN}${s.toUpperCase()}${RESET}`;
		if (s === "warn") return `${YELLOW}${s.toUpperCase()}${RESET}`;
		return `${RED}${s.toUpperCase()}${RESET}`;
	};

	const subtitle =
		format === "terminal"
			? [
					`Time: ${BLUE}${data.time || new Date().toISOString()}${RESET}`,
					`Gateway: ${colorStatus(data.status || "unknown")} (v${data.version || "???"} on ${data.runtime || "???"})`,
				].join("\n")
			: [
					`**Status**: ${(data.status || "unknown").toUpperCase()} ${StatusIcon({ status: data.status, format })}`,
					`**Time**: \`${data.time || new Date().toISOString()}\``,
				].join("\n");

	const isStale = !data.connectivity || !data.filesystem;
	const summary = isStale
		? format === "terminal"
			? `${YELLOW}注意: 网关运行的是旧版本，请运行 'make gateway-restart' 获取详细报告。${RESET}`
			: "⚠️ 注意: 网关运行的是旧版本。"
		: data.status === "ok"
			? format === "terminal"
				? `${GREEN}一切正常: 系统状态良好!${RESET}`
				: "✅ 一切正常: 系统状态良好!"
			: format === "terminal"
				? `${YELLOW}注意: 系统运行正常，但存在一些警告或错误。${RESET}`
				: "⚠️ 注意: 系统运行正常，但存在一些警告或错误。";

	const renderEnv = (key: string, info: { sensitive: boolean; status?: boolean | string; value?: string }) => {
		if (info.sensitive) {
			return `${key.padEnd(16)} ${StatusIcon({ status: info.status, format })}`;
		}
		const val = format === "terminal" ? `${BLUE}${info.value}${RESET}` : `\`${info.value}\``;
		return `${key.padEnd(16)} ${val}`;
	};

	const renderFs = (name: string, info: { status?: boolean | string; path: string }) => {
		const icon = StatusIcon({ status: info.status, format });
		const pathStr = format === "terminal" ? `${YELLOW}${info.path}${RESET}` : `\`${info.path}\``;
		return `  ${name.padEnd(12)} ${icon} ${pathStr}`;
	};

	const header = Header({ title: "CC-Bridge System Health", format, subtitle });

	const sections = [
		Section({
			title: "Connectivity",
			format,
			children: [
				`  Telegram API:   ${StatusIcon({ status: conn.telegram, format })}`,
				`  Anthropic API:  ${StatusIcon({ status: conn.anthropic, format })}`,
			],
		}),
		Section({
			title: "Environment",
			format,
			emoji: "📦",
			children: [
				`  ${renderEnv("Bot Token", env.TELEGRAM_BOT_TOKEN)}`,
				`  ${renderEnv("Anthropic Auth", env.ANTHROPIC_AUTH)}`,
				`  ${renderEnv("Port", env.PORT)}`,
				`  ${renderEnv("Node Env", env.NODE_ENV)}`,
				`  ${renderEnv("Server URL", env.URL)}`,
			],
		}),
		Section({
			title: "Filesystem",
			format,
			emoji: "📂",
			children: [
				renderFs("Persistence", fs.persistence),
				renderFs("Logs", fs.logs),
				renderFs("Mailbox", fs.mailbox),
				renderFs("Config", fs.config),
			],
		}),
		Section({
			title: "Daemons",
			format,
			emoji: "⚙️",
			children: [
				`  Gateway:        ${StatusIcon({ status: daemons["cc-bridge"]?.status, format })}`,
				`  Cloudflared:    ${StatusIcon({ status: daemons.cloudflared?.status, format })}`,
				`  OrbStack:       ${StatusIcon({ status: daemons.orbstack?.status, format })}`,
			],
		}),
		docker.length > 0 &&
			Section({
				title: "Docker Instances",
				format,
				emoji: "🐳",
				children: docker.map((d: { name: string; image: string; status: string }) => {
					const name = d.name;
					const img = format === "terminal" ? `${MAGENTA}${d.image}${RESET}` : `\`${d.image}\``;
					const st = d.status.includes("Up")
						? format === "terminal"
							? `${GREEN}${d.status}${RESET}`
							: `🟢 ${d.status}`
						: format === "terminal"
							? `${RED}${d.status}${RESET}`
							: `🔴 ${d.status}`;
					return `  ${name}: [${img}] -> ${st}`;
				}),
			}),
		Section({
			title: "Resources",
			format,
			emoji: "🤖",
			children: [
				format === "terminal"
					? `  Workspaces:     ${MAGENTA}${insts.running}/${insts.total}${RESET} active`
					: `  Workspaces: \`${insts.running}/${insts.total}\``,
				format === "terminal"
					? `  Pending Msgs:   ${YELLOW}${typeof stats === "object" ? stats.pending_proactive_messages : stats}${RESET}`
					: `  Pending Msgs: \`${typeof stats === "object" ? stats.pending_proactive_messages : stats}\``,
			],
		}),
	].filter(Boolean) as string[];

	return `${renderTemplate(HEALTH_TEMPLATE, {
		header,
		sections,
		summary,
	})}\n`;
};

const HEALTH_TEMPLATE = ["{{header}}", "", "{{#each sections}}{{this}}\n{{/each}}", "{{summary}}"].join("\n");
