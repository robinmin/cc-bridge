/**
 * Tool Factory - Create Default Tools for Agent
 *
 * Provides factory functions to create tools for the embedded agent.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBashTool } from "./bash";
import type { ToolPolicyConfig } from "./policy";
import { createReadFileTool } from "./read-file";
import { createWebSearchTool } from "./web-search";
import { createWriteFileTool } from "./write-file";

/**
 * Create all default tools for the agent.
 *
 * @param workspaceDir - Workspace directory for file operations
 * @param policyConfig - Optional tool policy configuration
 * @param chatId - Optional chat ID for per-chat policies
 * @returns Array of tools to register on the agent
 */
export function createDefaultTools(
	workspaceDir: string,
	policyConfig?: ToolPolicyConfig,
	chatId?: string,
): AgentTool<unknown>[] {
	const tools: AgentTool<unknown>[] = [
		createReadFileTool(workspaceDir),
		createWriteFileTool(workspaceDir),
		createBashTool(workspaceDir),
		createWebSearchTool(workspaceDir),
	];

	// Apply tool policy filtering if configured
	if (policyConfig) {
		// Import here to avoid circular dependencies
		const { applyToolPolicy } = require("./policy");
		return applyToolPolicy(tools, policyConfig, chatId);
	}

	return tools;
}

export { createBashTool, createBashTool as BashTool } from "./bash";
export type { ToolPolicyConfig } from "./policy";
export {
	applyToolPolicy,
	ChatToolPolicy,
	createReadOnlyPolicyPipeline,
	createToolPolicyPipeline,
	GlobalToolPolicy,
	ToolGranularPolicy,
	ToolPolicyPipeline,
} from "./policy";
export { createReadFileTool, createReadFileTool as ReadFileTool } from "./read-file";
export { createWebSearchTool, createWebSearchTool as WebSearchTool } from "./web-search";
export { createWriteFileTool, createWriteFileTool as WriteFileTool } from "./write-file";
