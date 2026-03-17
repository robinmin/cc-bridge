/**
 * Sandbox Configuration Types
 *
 * Type definitions for tool sandboxing system.
 * Combines OpenClaw-style comprehensive config with Pi-mono simplicity.
 */

import type { NetworkIsolationConfig } from "./network";

// =============================================================================
// Sandbox Mode
// =============================================================================

/**
 * Sandbox execution mode
 */
export type SandboxMode = "host" | "docker";

/**
 * CLI sandbox mode: strict (all external tools sandboxed) vs permissive (only dangerous tools)
 */
export type SandboxStrictness = "strict" | "permissive";

/**
 * Parsed sandbox argument from CLI
 */
export type SandboxArgument =
	| { type: "host" }
	| { type: "docker"; container: string }
	| { type: "strict" }
	| { type: "permissive" };

// =============================================================================
// Docker Settings (OpenClaw-inspired)
// =============================================================================

/**
 * Docker sandbox settings for tool execution
 */
export interface ToolSandboxDockerSettings {
	/** Docker image to use for sandbox containers */
	image?: string;
	/** Container name prefix */
	containerPrefix?: string;
	/** Container workdir mount path (default: /workspace) */
	workdir?: string;
	/** Run container rootfs read-only */
	readOnlyRoot?: boolean;
	/** Extra tmpfs mounts */
	tmpfs?: string[];
	/** Container network mode (bridge|none) - "host" is blocked for security */
	network?: "bridge" | "none";
	/** Container user (uid:gid) */
	user?: string;
	/** Drop Linux capabilities */
	capDrop?: string[];
	/** Environment variables */
	env?: Record<string, string>;
	/** Limit container PIDs */
	pidsLimit?: number;
	/** Limit container memory (e.g. 512m, 2g) */
	memory?: string;
	/** Limit container memory swap */
	memorySwap?: string;
	/** Limit container CPU shares */
	cpus?: number;
	/** Seccomp profile - "unconfined" is blocked */
	seccompProfile?: string;
	/** AppArmor profile - "unconfined" is blocked */
	apparmorProfile?: string;
	/** DNS servers */
	dns?: string[];
	/** Extra host mappings */
	extraHosts?: string[];
	/** Bind mounts (host:container:mode) */
	binds?: string[];
	/** Rich network isolation config (takes precedence over network field) */
	networkIsolation?: NetworkIsolationConfig;
}

// =============================================================================
// Resource Limits
// =============================================================================

/**
 * Resource limits for sandboxed execution
 */
export interface SandboxLimits {
	/** Memory limit (e.g., "512m", "2g") */
	memory?: string;
	/** CPU limit (e.g., 0.5, 1, 2) */
	cpus?: number;
	/** PID limit */
	pidsLimit?: number;
	/** Memory swap limit */
	memorySwap?: string;
	/** Timeout in milliseconds */
	timeoutMs?: number;
}

// =============================================================================
// Tool Sandbox Policy
// =============================================================================

/**
 * Per-tool sandbox configuration
 */
export interface ToolSandboxPolicy {
	/** Tool name pattern (glob) */
	pattern: string;
	/** Whether this tool requires sandboxing */
	sandbox: boolean;
	/** Optional timeout override */
	timeoutMs?: number;
	/** Optional memory limit override */
	memory?: string;
	/** Optional docker settings override */
	docker?: Partial<ToolSandboxDockerSettings>;
}

/**
 * Default built-in tools that don't require sandboxing
 */
export const BUILT_IN_TOOLS = [
	"bash",
	"read_file",
	"read-file",
	"write_file",
	"write-file",
	"web_search",
	"web-search",
	"glob",
	"grep",
] as const;

export type BuiltInTool = (typeof BUILT_IN_TOOLS)[number];

// =============================================================================
// Main Configuration
// =============================================================================

/**
 * Complete sandbox configuration for the tool system
 */
export interface ToolSandboxConfig {
	/** Default sandbox mode */
	defaultMode: SandboxMode;
	/** Sandbox strictness level */
	strictness: SandboxStrictness;
	/** Docker settings (used when mode is docker) */
	docker?: ToolSandboxDockerSettings;
	/** Resource limits */
	limits?: SandboxLimits;
	/** Per-tool policy overrides */
	toolPolicy?: ToolSandboxPolicy[];
	/** Built-in tools that don't need sandboxing */
	builtInTools?: readonly string[];
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Default sandbox configuration
 */
export const DEFAULT_SANDBOX_CONFIG: ToolSandboxConfig = {
	defaultMode: "host",
	strictness: "permissive",
	builtInTools: BUILT_IN_TOOLS,
};

/**
 * Strict sandbox configuration - all external tools sandboxed
 */
export const STRICT_SANDBOX_CONFIG: ToolSandboxConfig = {
	...DEFAULT_SANDBOX_CONFIG,
	strictness: "strict",
};

// =============================================================================
// CLI Parsing
// =============================================================================

/**
 * Parse sandbox argument from CLI
 * @param value - CLI argument value (host, docker:<container>, strict, permissive)
 */
export function parseSandboxArg(value: string): SandboxArgument {
	if (value === "host") {
		return { type: "host" };
	}
	if (value === "strict") {
		return { type: "strict" };
	}
	if (value === "permissive") {
		return { type: "permissive" };
	}
	if (value.startsWith("docker:")) {
		const container = value.slice("docker:".length);
		if (!container) {
			throw new Error("Docker sandbox requires container name (e.g., docker:my-container)");
		}
		return { type: "docker", container };
	}
	throw new Error(`Invalid sandbox type '${value}'. Use: host, docker:<name>, strict, permissive`);
}

/**
 * Convert CLI argument to sandbox config
 */
export function argToSandboxConfig(arg: SandboxArgument): ToolSandboxConfig {
	switch (arg.type) {
		case "host":
			return { ...DEFAULT_SANDBOX_CONFIG, defaultMode: "host" };
		case "docker":
			return { ...DEFAULT_SANDBOX_CONFIG, defaultMode: "docker" };
		case "strict":
			return { ...STRICT_SANDBOX_CONFIG };
		case "permissive":
			return { ...DEFAULT_SANDBOX_CONFIG, strictness: "permissive" };
	}
}
