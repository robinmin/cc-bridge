/** @jsxImportSource hono/jsx */

// Shared UI components for Terminal/Telegram

export interface BaseProps {
	format: "telegram" | "terminal";
}

export const StatusIcon = ({
	status,
	format,
}: {
	status: boolean | string | undefined;
	format: "telegram" | "terminal";
}) => {
	const isOk = status === true || status === "ok" || status === "running";
	const isWarn = status === "warn" || status === "read-only";
	const isUnknown = status === undefined;

	if (format === "terminal") {
		const GREEN = "\x1b[32m";
		const YELLOW = "\x1b[33m";
		const RED = "\x1b[31m";
		const RESET = "\x1b[0m";

		if (isUnknown) return "❔";
		if (isOk) return `${GREEN}✓${RESET}`;
		if (isWarn) return `${YELLOW}⚠${RESET}`;
		return `${RED}✗${RESET}`;
	} else {
		if (isUnknown) return "❔";
		if (isOk) return "✅";
		if (isWarn) return "⚠️";
		return "❌";
	}
};

export const Section = ({
	title,
	format,
	emoji = "🌐",
	children,
}: {
	title: string;
	format: "telegram" | "terminal";
	emoji?: string;
	children: string | string[];
}) => {
	const CYAN = "\x1b[36m";
	const RESET = "\x1b[0m";

	const content = Array.isArray(children) ? children.join("\n") : children;

	if (format === "terminal") {
		return ["", `${CYAN}━━━ ${title} ━━━${RESET}`, content].join("\n");
	} else {
		return ["", `${emoji} **${title}**`, content].join("\n");
	}
};

export const Header = ({
	title,
	format,
	subtitle,
}: {
	title: string;
	format: "telegram" | "terminal";
	subtitle?: string;
}) => {
	const CYAN = "\x1b[36m";
	const RESET = "\x1b[0m";

	if (format === "terminal") {
		return [
			`${CYAN}╔══════════════════════════════════════════════════════╗${RESET}`,
			`${CYAN}║${title.padStart(Math.floor((54 + title.length) / 2)).padEnd(54)}║${RESET}`,
			`${CYAN}╚══════════════════════════════════════════════════════╝${RESET}`,
			subtitle || "",
		]
			.filter(Boolean)
			.join("\n");
	} else {
		return [`🛰️ **${title.toUpperCase()}**`, "━━━━━━━━━━━━━━━━━━━", subtitle || ""].filter(Boolean).join("\n");
	}
};
