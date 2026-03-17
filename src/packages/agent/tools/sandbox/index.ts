/**
 * Tool Sandboxing System
 *
 * Hybrid sandbox implementation combining OpenClaw security with Pi-mono simplicity.
 *
 * @example
 * ```typescript
 * import { createSandboxPolicyEvaluator, needsSandbox } from "./sandbox";
 *
 * // Check if a tool needs sandboxing
 * const needs = needsSandbox("bash", { defaultMode: "host", strictness: "strict" });
 * console.log(needs); // true for external tools in strict mode
 * ```
 */

export {
	type BrowserSandboxConfig,
	BrowserSandboxExecutor,
	type BrowserValidationResult,
	buildChromeFlags,
	CdpPortAllocator,
	createBrowserSandboxExecutor,
	DEFAULT_BROWSER_SANDBOX_CONFIG,
	getCdpPort,
	validateBrowserSandboxConfig,
} from "./browser";
export {
	argToSandboxConfig,
	BUILT_IN_TOOLS,
	DEFAULT_SANDBOX_CONFIG,
	parseSandboxArg,
	type SandboxArgument,
	type SandboxLimits,
	type SandboxMode,
	type SandboxStrictness,
	STRICT_SANDBOX_CONFIG,
	type ToolSandboxConfig,
	type ToolSandboxDockerSettings,
	type ToolSandboxPolicy,
} from "./config";
export {
	createDockerExecutor,
	createSandboxExecutor,
	DockerExecutor,
	type ExecOptions,
	type ExecResult,
	HostExecutor,
	type SandboxExecutor,
} from "./executor";
export {
	DEFAULT_LIMITS,
	LENIENT_LIMITS,
	limitsToDockerArgs,
	normalizeMemory,
	type ParsedLimits,
	parseResourceLimits,
	STRICT_LIMITS,
} from "./limits";
export {
	FULL_NETWORK,
	ISOLATED_NETWORK,
	type NetworkIsolationConfig,
	type NetworkIsolationMode,
	networkConfigToDockerArgs,
	RESTRICTED_NETWORK,
	validateNetworkConfig,
} from "./network";
export {
	createSandboxPolicyEvaluator,
	needsSandbox,
	type SandboxPolicyResult,
	ToolSandboxPolicyEvaluator,
} from "./policy";
export {
	DEFAULT_QUOTA,
	type ExecutionRecord,
	QuotaEnforcer,
	type QuotaStatus,
	type QuotaUsageSummary,
	type ResourceQuota,
	STRICT_QUOTA,
	UNLIMITED_QUOTA,
} from "./quota";
export {
	SandboxSecurityValidator,
	SandboxValidationError,
	sandboxValidator,
	type ValidationResult,
	validateSandboxConfig,
} from "./validator";
