/**
 * Tool Factory
 *
 * Creates the default set of AgentTools for an EmbeddedAgent,
 * each configured with the workspace directory for sandboxing.
 * Supports optional policy-based filtering via ToolPolicyPipeline.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBashTool } from "./bash";
import {
	applyToolPolicy,
	type ChatPolicyConfig,
	ChatToolPolicy,
	createReadOnlyPolicyPipeline,
	createToolPolicyPipeline,
	GlobalToolPolicy,
	ToolGranularPolicy,
	type ToolPolicy,
	type ToolPolicyAction,
	type ToolPolicyConfig,
	ToolPolicyPipeline,
	type ToolPolicyResult,
} from "./policy";
import { createReadFileTool } from "./read-file";
import { createWebSearchTool } from "./web-search";
import { createWriteFileTool } from "./write-file";

/**
 * Create the default tool set for an EmbeddedAgent.
 *
 * All file-system tools are sandboxed to the given workspace directory.
 * The bash tool runs commands with cwd set to the workspace.
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @param policyConfig - Optional policy configuration for tool filtering
 * @param chatId - Optional chat ID for per-chat policy overrides
 * @returns Array of AgentTool instances ready for registration
 */
export function createDefaultTools(
	workspaceDir: string,
	policyConfig?: ToolPolicyConfig,
	chatId?: string,
): AgentTool[] {
	const tools: AgentTool[] = [
		createReadFileTool(workspaceDir),
		createWriteFileTool(workspaceDir),
		createBashTool(workspaceDir),
		createWebSearchTool(workspaceDir),
	];

	// Apply policy pipeline if config is provided
	if (policyConfig) {
		return applyToolPolicy(tools, policyConfig, chatId);
	}

	return tools;
}

// Re-export tool creators
export { createBashTool } from "./bash";
export { createReadFileTool } from "./read-file";
export { resolveWorkspacePath } from "./utils";
export { createWebSearchTool } from "./web-search";
export { createWriteFileTool } from "./write-file";

// Re-export policy types and utilities
export {
	// Classes
	ChatToolPolicy,
	GlobalToolPolicy,
	ToolGranularPolicy,
	ToolPolicyPipeline,
	// Factory functions
	applyToolPolicy,
	createReadOnlyPolicyPipeline,
	createToolPolicyPipeline,
	// Types (re-exported for convenience)
	type ChatPolicyConfig,
	type ToolPolicy,
	type ToolPolicyAction,
	type ToolPolicyConfig,
	type ToolPolicyResult,
};
