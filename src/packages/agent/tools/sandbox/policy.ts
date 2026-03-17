/**
 * Per-Tool Sandbox Policy
 *
 * Determines which tools require sandboxing based on:
 * - Built-in tool list (no sandbox needed)
 * - Strictness mode (strict vs permissive)
 * - Custom tool policy overrides
 */

import type { ToolSandboxConfig, ToolSandboxPolicy } from "./config";
import { BUILT_IN_TOOLS } from "./config";

/**
 * Result of checking if a tool needs sandboxing
 */
export interface SandboxPolicyResult {
	/** Whether the tool needs sandboxing */
	needsSandbox: boolean;
	/** Reason for the decision */
	reason: string;
	/** Optional timeout override */
	timeoutMs?: number;
	/** Optional memory limit */
	memory?: string;
}

/**
 * Tool sandbox policy evaluator
 */
export class ToolSandboxPolicyEvaluator {
	private config: ToolSandboxConfig;
	private toolPolicies: ToolSandboxPolicy[];

	constructor(config: ToolSandboxConfig) {
		this.config = config;
		this.toolPolicies = config.toolPolicy || [];
	}

	/**
	 * Check if a tool requires sandboxing
	 */
	evaluate(toolName: string): SandboxPolicyResult {
		// Check built-in tools first
		if (this.isBuiltInTool(toolName)) {
			return {
				needsSandbox: false,
				reason: "Built-in tool - no sandbox required",
			};
		}

		// Check custom tool policies
		const customPolicy = this.findMatchingPolicy(toolName);
		if (customPolicy) {
			return {
				needsSandbox: customPolicy.sandbox,
				reason: customPolicy.sandbox
					? `Custom policy: ${toolName} requires sandboxing`
					: `Custom policy: ${toolName} exempted from sandboxing`,
				timeoutMs: customPolicy.timeoutMs,
				memory: customPolicy.memory,
			};
		}

		// Apply strictness mode
		return this.evaluateByStrictness(toolName);
	}

	/**
	 * Check if tool is in the built-in list
	 */
	private isBuiltInTool(toolName: string): boolean {
		const builtIn = this.config.builtInTools || BUILT_IN_TOOLS;
		const normalizedTool = toolName.toLowerCase().replace(/_/g, "-");

		for (const builtin of builtIn) {
			if (this.matchPattern(builtin, normalizedTool)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Find matching custom policy for a tool
	 */
	private findMatchingPolicy(toolName: string): ToolSandboxPolicy | undefined {
		const normalizedTool = toolName.toLowerCase().replace(/_/g, "-");

		for (const policy of this.toolPolicies) {
			if (this.matchPattern(policy.pattern, normalizedTool)) {
				return policy;
			}
		}

		return undefined;
	}

	/**
	 * Evaluate based on strictness mode
	 */
	private evaluateByStrictness(toolName: string): SandboxPolicyResult {
		const strictness = this.config.strictness || "permissive";

		switch (strictness) {
			case "strict":
				// Strict mode: all external tools require sandboxing
				return {
					needsSandbox: true,
					reason: "Strict mode: external tools require sandboxing",
				};

			case "permissive":
				// Permissive mode: only dangerous tools need sandboxing
				return this.evaluatePermissiveMode(toolName);
		}
	}

	/**
	 * Evaluate permissive mode - only dangerous tools need sandboxing
	 */
	private evaluatePermissiveMode(toolName: string): SandboxPolicyResult {
		const dangerousPatterns = [
			"bash",
			"shell",
			"exec",
			"execute",
			"run",
			"cmd",
			"command",
			"http",
			"request",
			"fetch",
			"network",
			"socket",
		];

		const normalizedTool = toolName.toLowerCase().replace(/_/g, "-");

		for (const pattern of dangerousPatterns) {
			if (normalizedTool.includes(pattern)) {
				return {
					needsSandbox: true,
					reason: `Permissive mode: ${toolName} matches dangerous pattern "${pattern}"`,
				};
			}
		}

		// Safe external tools don't need sandboxing in permissive mode
		return {
			needsSandbox: false,
			reason: "Permissive mode: tool appears safe",
		};
	}

	/**
	 * Match a glob pattern against a tool name
	 */
	private matchPattern(pattern: string, toolName: string): boolean {
		// Exact match
		if (pattern === toolName) return true;

		// Wildcard patterns
		if (pattern === "*") return true;

		// Simple wildcard at end
		if (pattern.endsWith("*")) {
			const prefix = pattern.slice(0, -1);
			return toolName.startsWith(prefix);
		}

		// Simple wildcard at start
		if (pattern.startsWith("*")) {
			const suffix = pattern.slice(1);
			return toolName.endsWith(suffix);
		}

		return false;
	}
}

/**
 * Create a policy evaluator from config
 */
export function createSandboxPolicyEvaluator(config: ToolSandboxConfig): ToolSandboxPolicyEvaluator {
	return new ToolSandboxPolicyEvaluator(config);
}

/**
 * Check if a tool needs sandboxing (convenience function)
 */
export function needsSandbox(toolName: string, config: ToolSandboxConfig): boolean {
	const evaluator = createSandboxPolicyEvaluator(config);
	return evaluator.evaluate(toolName).needsSandbox;
}
