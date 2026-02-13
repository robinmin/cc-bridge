/** @jsxImportSource hono/jsx */

import { renderTemplate } from "@/packages/template";
import { Header } from "./common";

interface WorkspaceInfo {
	name: string;
	status: string;
	isActive: boolean;
}

export const WorkspaceList = ({
	workspaces,
	format,
	_currentSession,
}: {
	workspaces: WorkspaceInfo[];
	format: "telegram" | "terminal";
	currentSession?: string | null;
}) => {
	const list = workspaces
		.map((ws) => {
			const statusEmoji = ws.status === "running" && ws.isActive ? "🟢" : "⚪";
			const activeMarker = ws.isActive ? " 📍" : "";
			return {
				statusEmoji,
				name: ws.name,
				activeMarker,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));

	const header = Header({ title: "Available Workspaces", format });
	const hint =
		format === "telegram" ? "Use `/ws_switch <name>` to change." : "Use 'make ws_switch target=<name>' to change.";

	return (
		renderTemplate(WORKSPACE_LIST_TEMPLATE, {
			header,
			list,
			hint,
		}) + "\n"
	);
};

export const WorkspaceStatus = ({
	current,
	status,
	_format,
}: {
	current: string | null;
	status?: string;
	format: "telegram" | "terminal";
}) => {
	if (!current) {
		return renderTemplate(WORKSPACE_STATUS_EMPTY_TEMPLATE, {});
	}

	const statusText = status === "running" ? "🟢 Running" : "🔴 Stopped";
	return renderTemplate(WORKSPACE_STATUS_TEMPLATE, { current, statusText });
};

const WORKSPACE_LIST_TEMPLATE = [
	"{{header}}",
	"",
	"{{#each list}}{{this.statusEmoji}} {{this.name}}{{this.activeMarker}}\n{{/each}}",
	"",
	"{{hint}}",
].join("\n");

const WORKSPACE_STATUS_TEMPLATE = ["📍 **Current Workspace**: {{current}}", "Status: {{statusText}}"].join("\n");

const WORKSPACE_STATUS_EMPTY_TEMPLATE = [
	"📍 **Current Workspace**: None selected.",
	"Use `/ws_list` to see available options.",
].join("\n");
