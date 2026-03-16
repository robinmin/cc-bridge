/**
 * Tool Policy Pipeline
 *
 * Multi-stage tool policy system that applies policies at different levels:
 * - Global Policy Layer: Workspace-level defaults (allow/deny lists)
 * - Per-Chat Policy Layer: Session-level overrides
 * - Per-Tool Policy Layer: Granular tool controls (e.g., read-only mode)
 *
 * Policies are evaluated in priority order (lower first) and the pipeline
 * short-circuits on the first non-null result.
 *
 * Configuration via:
 * - ToolPolicyConfig object
 * - Environment variables: ALLOWED_TOOLS, DENIED_TOOLS, READ_ONLY_MODE
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { logger } from "@/packages/logger";
import type { AuditSink } from "./permission/audit";
import type { PermissionTier } from "./permission/tiers";
import type { ToolRateLimit } from "./visibility/rate-limiter";

// =============================================================================
// Types
// =============================================================================

/**
 * Action a policy can take on a tool
 */
export type ToolPolicyAction = "allow" | "deny" | "transform";

/**
 * Result of evaluating a policy on a tool
 */
export interface ToolPolicyResult {
	/** The action to take */
	action: ToolPolicyAction;
	/** Optional reason for the action (for logging/debugging) */
	reason?: string;
	/** Transformed tool instance (only when action is "transform") */
	transformedTool?: AgentTool;
}

/**
 * Interface for a tool policy implementation
 */
export interface ToolPolicy {
	/** Unique name for the policy */
	name: string;
	/** Priority order (lower = evaluated first) */
	priority: number;
	/**
	 * Evaluate the policy for a given tool.
	 * Returns null if the policy doesn't apply (pass-through to next policy).
	 */
	evaluate(toolName: string, tool: AgentTool): ToolPolicyResult | null;
}

/**
 * Configuration for tool policies
 */
export interface ToolPolicyConfig {
	/** Tools to allow (glob patterns, default: ["*"]) */
	allowedTools?: string[];
	/** Tools to deny (glob patterns, default: []) */
	deniedTools?: string[];
	/** Read-only mode (disables write tools) */
	readOnly?: boolean;
	/** Custom tool configurations */
	toolConfig?: Record<string, unknown>;
	/** Per-chat overrides (keyed by chat ID) */
	chatOverrides?: Record<string, ChatPolicyConfig>;

	// =============================================================================
	// Enhanced Tool System Config (Phase 1-3)
	// =============================================================================

	/** Permission tier configuration */

	/** Reference to predefined permission template */
	permissionTemplate?: string;
	/** Base tier for session (default: READ) */
	sessionTier?: PermissionTier;
	/** Allow JIT elevation (default: true) */
	jitEnabled?: boolean;
	/** Default escalation duration in ms (default: 60000) */
	escalationTimeoutMs?: number;

	/** Rate limiting configuration */

	/** Per-tool rate limits */
	rateLimits?: ToolRateLimit[];
	/** Global rate limit: max calls per window (default: 100) */
	globalMaxCalls?: number;
	/** Global rate limit: window in ms (default: 60000) */
	globalWindowMs?: number;

	/** Audit configuration */

	/** Enable audit logging (default: false) */
	auditEnabled?: boolean;
	/** Audit sink for logging (optional, defaults to console) */
	auditSink?: AuditSink;
}

/**
 * Per-chat policy configuration
 */
export interface ChatPolicyConfig {
	/** Additional tools to allow for this chat */
	allowedTools?: string[];
	/** Additional tools to deny for this chat */
	deniedTools?: string[];
	/** Override read-only mode for this chat */
	readOnly?: boolean;
}

// =============================================================================
// Glob Pattern Matching
// =============================================================================

/**
 * Simple glob pattern matcher supporting:
 * - * matches any sequence of characters (except /)
 * - ** matches any sequence of characters including /
 * - ? matches any single character
 * - literal characters match themselves
 */
function matchGlob(pattern: string, text: string): boolean {
	// Normalize pattern and text to lowercase for case-insensitive matching
	const p = pattern.toLowerCase();
	const t = text.toLowerCase();

	// Handle exact match
	if (p === t) return true;

	// Handle single wildcard
	if (p === "*") return true;

	// Convert glob pattern to regex
	let regexStr = "";
	let i = 0;

	while (i < p.length) {
		const char = p[i];

		if (char === "*" && p[i + 1] === "*") {
			// ** matches anything including path separators
			regexStr += ".*";
			i += 2;
		} else if (char === "*") {
			// * matches anything except path separators
			regexStr += "[^/]*";
			i++;
		} else if (char === "?") {
			// ? matches any single character
			regexStr += ".";
			i++;
		} else if (
			char === "[" ||
			char === "]" ||
			char === "{" ||
			char === "}" ||
			char === "(" ||
			char === ")" ||
			char === "." ||
			char === "+" ||
			char === "^" ||
			char === "$" ||
			char === "|" ||
			char === "\\"
		) {
			// Escape regex special characters
			regexStr += `\\${char}`;
			i++;
		} else {
			regexStr += char;
			i++;
		}
	}

	try {
		const regex = new RegExp(`^${regexStr}$`);
		return regex.test(t);
	} catch {
		// If regex compilation fails, fall back to simple match
		return p === t;
	}
}

/**
 * Check if a tool name matches any pattern in the list
 */
function matchesAnyPattern(toolName: string, patterns: string[]): boolean {
	return patterns.some((pattern) => matchGlob(pattern, toolName));
}

// =============================================================================
// Built-in Policies
// =============================================================================

/**
 * Global policy: apply allowed/denied lists from config
 * Evaluates workspace-level defaults from config and environment variables.
 */
export class GlobalToolPolicy implements ToolPolicy {
	name = "global";
	priority = 10;

	private allowedTools: string[];
	private deniedTools: string[];

	constructor(config?: ToolPolicyConfig) {
		// Load from config or environment variables
		this.allowedTools = this.loadAllowedTools(config);
		this.deniedTools = this.loadDeniedTools(config);

		logger.debug(
			{
				allowedTools: this.allowedTools,
				deniedTools: this.deniedTools,
			},
			"GlobalToolPolicy initialized",
		);
	}

	private loadAllowedTools(config?: ToolPolicyConfig): string[] {
		// Config takes precedence over environment
		if (config?.allowedTools && config.allowedTools.length > 0) {
			return config.allowedTools;
		}

		// Try environment variable
		const envAllowed = process.env.ALLOWED_TOOLS;
		if (envAllowed) {
			return envAllowed
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}

		// Default: allow all
		return ["*"];
	}

	private loadDeniedTools(config?: ToolPolicyConfig): string[] {
		// Config takes precedence over environment
		if (config?.deniedTools && config.deniedTools.length > 0) {
			return config.deniedTools;
		}

		// Try environment variable
		const envDenied = process.env.DENIED_TOOLS;
		if (envDenied) {
			return envDenied
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}

		// Default: deny none
		return [];
	}

	evaluate(toolName: string, _tool: AgentTool): ToolPolicyResult | null {
		// Check deny list first (deny takes precedence)
		if (matchesAnyPattern(toolName, this.deniedTools)) {
			return {
				action: "deny",
				reason: `Tool "${toolName}" is in deny list`,
			};
		}

		// Check allow list
		if (!matchesAnyPattern(toolName, this.allowedTools)) {
			return {
				action: "deny",
				reason: `Tool "${toolName}" is not in allow list`,
			};
		}

		// Tool is allowed, pass through to next policy
		return null;
	}
}

/**
 * Per-chat policy: session-specific overrides
 * Applies additional allow/deny rules for specific chat sessions.
 */
export class ChatToolPolicy implements ToolPolicy {
	name = "chat";
	priority = 20;

	private chatId: string | undefined;
	private config: ChatPolicyConfig | undefined;

	constructor(chatId?: string, config?: ChatPolicyConfig) {
		this.chatId = chatId;
		this.config = config;
	}

	/**
	 * Update the chat ID and config (for reusing the policy instance)
	 */
	updateChat(chatId: string | undefined, config: ChatPolicyConfig | undefined): void {
		this.chatId = chatId;
		this.config = config;
	}

	evaluate(toolName: string, _tool: AgentTool): ToolPolicyResult | null {
		if (!this.config) {
			return null;
		}

		// Check deny list
		if (this.config.deniedTools && matchesAnyPattern(toolName, this.config.deniedTools)) {
			return {
				action: "deny",
				reason: `Tool "${toolName}" is denied for chat "${this.chatId}"`,
			};
		}

		// Check allow list (if specified, it overrides global)
		if (this.config.allowedTools && !matchesAnyPattern(toolName, this.config.allowedTools)) {
			return {
				action: "deny",
				reason: `Tool "${toolName}" is not allowed for chat "${this.chatId}"`,
			};
		}

		// Pass through to next policy
		return null;
	}
}

/**
 * Per-tool policy: granular controls (e.g., sandbox paths, read-only mode)
 * Applies tool-specific transformations and restrictions.
 */
export class ToolGranularPolicy implements ToolPolicy {
	name = "granular";
	priority = 30;

	private readOnly: boolean;
	private toolConfig: Record<string, unknown>;

	constructor(config?: ToolPolicyConfig) {
		this.readOnly = this.loadReadOnlyMode(config);
		this.toolConfig = config?.toolConfig ?? {};

		logger.debug({ readOnly: this.readOnly, toolConfig: this.toolConfig }, "ToolGranularPolicy initialized");
	}

	private loadReadOnlyMode(config?: ToolPolicyConfig): boolean {
		// Config takes precedence over environment
		if (config?.readOnly !== undefined) {
			return config.readOnly;
		}

		// Try environment variable
		const envReadOnly = process.env.READ_ONLY_MODE;
		if (envReadOnly) {
			return envReadOnly === "true" || envReadOnly === "1";
		}

		return false;
	}

	evaluate(toolName: string, tool: AgentTool): ToolPolicyResult | null {
		// Apply read-only mode
		if (this.readOnly && this.isWriteTool(toolName)) {
			return {
				action: "deny",
				reason: `Tool "${toolName}" is disabled in read-only mode`,
			};
		}

		// Apply tool-specific configurations
		const toolCfg = this.toolConfig[toolName];
		if (toolCfg && typeof toolCfg === "object") {
			// Check if tool should be transformed
			const transformedTool = this.applyToolConfig(tool, toolCfg as Record<string, unknown>);
			if (transformedTool) {
				return {
					action: "transform",
					reason: `Applied custom configuration to tool "${toolName}"`,
					transformedTool,
				};
			}
		}

		// No transformation needed, allow the tool
		return null;
	}

	/**
	 * Check if a tool is a write tool (should be blocked in read-only mode)
	 */
	private isWriteTool(toolName: string): boolean {
		const writeToolPatterns = [
			"write_file",
			"write*",
			"*write*",
			"delete*",
			"remove*",
			"bash", // Bash can write files
		];
		return matchesAnyPattern(toolName, writeToolPatterns);
	}

	/**
	 * Apply tool-specific configuration to transform a tool
	 */
	private applyToolConfig(tool: AgentTool, config: Record<string, unknown>): AgentTool | null {
		// Currently supports:
		// - disabled: true -> deny the tool
		// - sandbox: string -> transform sandbox path
		// - timeout: number -> transform timeout

		if (config.disabled === true) {
			// Return a special marker that the pipeline will interpret as deny
			return {
				...tool,
				_name: "__disabled__",
			};
		}

		// For future: support sandbox path transformation
		// For future: support timeout transformation

		return null;
	}
}

// =============================================================================
// Pipeline
// =============================================================================

/**
 * Tool policy pipeline that evaluates policies in priority order.
 * Short-circuits on the first non-null result.
 */
export class ToolPolicyPipeline {
	private policies: ToolPolicy[] = [];

	/**
	 * Add a policy to the pipeline.
	 * Policies are sorted by priority after insertion.
	 */
	addPolicy(policy: ToolPolicy): void {
		this.policies.push(policy);
		this.policies.sort((a, b) => a.priority - b.priority);
		logger.debug({ policyName: policy.name, priority: policy.priority }, "Policy added to pipeline");
	}

	/**
	 * Remove a policy by name.
	 */
	removePolicy(name: string): void {
		const index = this.policies.findIndex((p) => p.name === name);
		if (index !== -1) {
			this.policies.splice(index, 1);
			logger.debug({ policyName: name }, "Policy removed from pipeline");
		}
	}

	/**
	 * Get a policy by name.
	 */
	getPolicy(name: string): ToolPolicy | undefined {
		return this.policies.find((p) => p.name === name);
	}

	/**
	 * Clear all policies from the pipeline.
	 */
	clearPolicies(): void {
		this.policies = [];
	}

	/**
	 * Evaluate all tools through the policy pipeline.
	 * Returns the filtered and transformed list of tools.
	 */
	evaluate(tools: AgentTool[]): AgentTool[] {
		const result: AgentTool[] = [];

		for (const tool of tools) {
			const toolName = tool.name;
			let finalTool: AgentTool | null = tool;
			let denied = false;
			let denyReason = "";

			// Evaluate each policy in priority order
			for (const policy of this.policies) {
				const policyResult = policy.evaluate(toolName, tool);

				if (policyResult === null) {
					// Policy doesn't apply, continue to next
					continue;
				}

				logger.debug(
					{
						toolName,
						policyName: policy.name,
						action: policyResult.action,
						reason: policyResult.reason,
					},
					"Policy evaluation result",
				);

				switch (policyResult.action) {
					case "deny":
						denied = true;
						denyReason = policyResult.reason || `Denied by policy "${policy.name}"`;
						break;

					case "transform":
						if (policyResult.transformedTool) {
							// Check if this is a disabled marker
							if ((policyResult.transformedTool as { _name?: string })._name === "__disabled__") {
								denied = true;
								denyReason = policyResult.reason || `Tool disabled by policy "${policy.name}"`;
							} else {
								finalTool = policyResult.transformedTool;
							}
						}
						break;

					case "allow":
						// Explicit allow, stop evaluating
						break;
				}

				// Short-circuit if we have a definitive result
				if (denied || policyResult.action === "allow") {
					break;
				}
			}

			if (!denied && finalTool) {
				result.push(finalTool);
			} else if (denied) {
				logger.debug({ toolName, reason: denyReason }, "Tool denied by policy pipeline");
			}
		}

		logger.info(
			{
				inputCount: tools.length,
				outputCount: result.length,
				deniedCount: tools.length - result.length,
			},
			"Tool policy pipeline evaluation complete",
		);

		return result;
	}
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a tool policy pipeline with the standard policy stack.
 *
 * @param config - Optional policy configuration
 * @param chatId - Optional chat ID for per-chat policies
 * @returns Configured ToolPolicyPipeline instance
 */
export function createToolPolicyPipeline(config?: ToolPolicyConfig, chatId?: string): ToolPolicyPipeline {
	const pipeline = new ToolPolicyPipeline();

	// Add global policy (workspace-level defaults)
	pipeline.addPolicy(new GlobalToolPolicy(config));

	// Add per-chat policy if chat ID is provided
	if (chatId) {
		const chatConfig = config?.chatOverrides?.[chatId];
		pipeline.addPolicy(new ChatToolPolicy(chatId, chatConfig));
	}

	// Add granular policy (tool-specific controls)
	pipeline.addPolicy(new ToolGranularPolicy(config));

	return pipeline;
}

/**
 * Create a read-only tool policy pipeline.
 * Convenience function for quickly creating a read-only configuration.
 */
export function createReadOnlyPolicyPipeline(): ToolPolicyPipeline {
	return createToolPolicyPipeline({ readOnly: true });
}

/**
 * Apply policy pipeline to a set of tools.
 * Convenience function for one-off policy application.
 *
 * @param tools - Tools to filter
 * @param config - Policy configuration
 * @param chatId - Optional chat ID
 * @returns Filtered tools
 */
export function applyToolPolicy(tools: AgentTool[], config?: ToolPolicyConfig, chatId?: string): AgentTool[] {
	const pipeline = createToolPolicyPipeline(config, chatId);
	return pipeline.evaluate(tools);
}
