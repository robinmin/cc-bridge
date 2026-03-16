/**
 * Tool Factory - Create Default Tools for Agent
 *
 * Provides factory functions to create tools for the embedded agent.
 * Includes enhanced tool system with permission tiers, escalation, audit, and rate limiting.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBashTool } from "./bash";
import type { ToolPolicyConfig } from "./policy";
import { createReadFileTool } from "./read-file";
import { createWebSearchTool } from "./web-search";
import { createWriteFileTool } from "./write-file";

// =============================================================================
// Permission System Exports
// =============================================================================

export type { AuditFilter, AuditSink, ToolAuditEvent, ToolCallResult } from "./permission/audit";
export {
	AuditLogger,
	ConsoleAuditSink,
	createAuditLogger,
	InMemoryAuditSink,
	MultiSinkAuditLogger,
} from "./permission/audit";
export type { EscalationConfig, EscalationRequest, EscalationResult } from "./permission/escalation";
export { PermissionEscalation } from "./permission/escalation";
export type {
	EvaluatorConfig,
	PermissionContext,
	PermissionEvaluationResult,
	SessionStateStore,
} from "./permission/evaluator";
export {
	createPermissionEvaluator,
	InMemorySessionStateStore,
	ToolPermissionEvaluator,
} from "./permission/evaluator";
export type { PermissionTemplate, ToolTierRequirement } from "./permission/tiers";
export {
	DEFAULT_TOOL_TIERS,
	getDefaultTier,
	getTierName,
	hasTierPermission,
	PermissionTier,
} from "./permission/tiers";

// =============================================================================
// Visibility System Exports
// =============================================================================

export type { MetricsSummary, ToolMetrics } from "./visibility/metrics";
export { MetricsCollector } from "./visibility/metrics";
export type { RateLimitResult, ToolRateLimit } from "./visibility/rate-limiter";
export { RateLimiter } from "./visibility/rate-limiter";
export type { ToolCallTrace, TraceFilter, TraceStatus } from "./visibility/tracer";
export { ToolTracer } from "./visibility/tracer";

// =============================================================================
// Policy Exports
// =============================================================================

export type { BashToolOptions } from "./bash";
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

// =============================================================================
// Default Tools Factory
// =============================================================================

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
