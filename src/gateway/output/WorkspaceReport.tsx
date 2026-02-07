/** @jsxImportSource hono/jsx */
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
			return `${statusEmoji} ${ws.name}${activeMarker}`;
		})
		.join("\n");

	return `${[
		Header({ title: "Available Workspaces", format }),
		"",
		list,
		"",
		format === "telegram"
			? "Use `/ws_switch <name>` to change."
			: "Use 'make ws_switch target=<name>' to change.",
	].join("\n")}\n`;
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
		return "📍 **Current Workspace**: None selected.\nUse `/ws_list` to see available options.";
	}

	const statusText = status === "running" ? "🟢 Running" : "🔴 Stopped";
	return `📍 **Current Workspace**: ${current}\nStatus: ${statusText}`;
};
