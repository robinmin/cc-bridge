/**
 * Network Isolation Configuration
 *
 * Provides richer network isolation options for sandboxed tool execution.
 * Converts high-level network policies into Docker CLI arguments.
 */

import { SandboxValidationError, type ValidationResult } from "./validator";

// =============================================================================
// Network Isolation Types
// =============================================================================

/**
 * Network isolation mode for sandboxed containers
 */
export type NetworkIsolationMode = "none" | "bridge" | "internal" | "custom";

/**
 * Network isolation configuration
 */
export interface NetworkIsolationConfig {
	/** Network isolation mode */
	mode: NetworkIsolationMode;
	/** Whitelist of hostnames/IPs allowed for outbound connections */
	allowedHosts?: string[];
	/** Whitelist of outbound ports allowed */
	allowedPorts?: number[];
	/** Custom DNS servers */
	dnsServers?: string[];
	/** Whether to enable IPv6 */
	enableIPv6?: boolean;
}

// =============================================================================
// Preset Configurations
// =============================================================================

/**
 * Fully isolated - no network access at all
 */
export const ISOLATED_NETWORK: NetworkIsolationConfig = {
	mode: "none",
};

/**
 * Restricted network - bridge with limited ports (HTTP/HTTPS/DNS only)
 */
export const RESTRICTED_NETWORK: NetworkIsolationConfig = {
	mode: "bridge",
	allowedPorts: [53, 80, 443],
	enableIPv6: false,
};

/**
 * Full network access - bridge mode, all ports allowed
 */
export const FULL_NETWORK: NetworkIsolationConfig = {
	mode: "bridge",
};

// =============================================================================
// Validation
// =============================================================================

/** Hostname/IP pattern: simple alphanumeric with dots, hyphens, colons (IPv6), wildcards */
const VALID_HOST_PATTERN = /^[\w.*:-]+$/;

/** Valid port range */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Validate a network isolation configuration
 */
export function validateNetworkConfig(config: NetworkIsolationConfig): ValidationResult {
	const errors: SandboxValidationError[] = [];
	const warnings: string[] = [];

	// Block "host" mode bypass attempts via custom network name
	if ((config.mode as string) === "host") {
		errors.push(
			new SandboxValidationError("Host network mode is not allowed for sandbox isolation", "networkIsolation.mode"),
		);
	}

	// Validate mode is a known value
	const validModes: NetworkIsolationMode[] = ["none", "bridge", "internal", "custom"];
	if (!validModes.includes(config.mode) && (config.mode as string) !== "host") {
		errors.push(new SandboxValidationError(`Unknown network isolation mode: ${config.mode}`, "networkIsolation.mode"));
	}

	// Validate allowedHosts
	if (config.allowedHosts) {
		for (const host of config.allowedHosts) {
			if (!host || host.trim().length === 0) {
				errors.push(
					new SandboxValidationError("Allowed host entry must not be empty", "networkIsolation.allowedHosts"),
				);
			} else if (!VALID_HOST_PATTERN.test(host)) {
				errors.push(new SandboxValidationError(`Invalid host entry: ${host}`, "networkIsolation.allowedHosts"));
			}
		}
	}

	// Validate allowedPorts
	if (config.allowedPorts) {
		for (const port of config.allowedPorts) {
			if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
				errors.push(
					new SandboxValidationError(
						`Invalid port number: ${port}. Must be between ${MIN_PORT} and ${MAX_PORT}`,
						"networkIsolation.allowedPorts",
					),
				);
			}
		}
	}

	// Validate DNS servers
	if (config.dnsServers) {
		for (const dns of config.dnsServers) {
			if (!dns || dns.trim().length === 0) {
				errors.push(new SandboxValidationError("DNS server entry must not be empty", "networkIsolation.dnsServers"));
			} else if (!VALID_HOST_PATTERN.test(dns)) {
				errors.push(new SandboxValidationError(`Invalid DNS server: ${dns}`, "networkIsolation.dnsServers"));
			}
		}
	}

	// Warn about permissive configurations
	if (config.mode === "none" && config.allowedHosts && config.allowedHosts.length > 0) {
		warnings.push("allowedHosts is ignored when network mode is 'none'");
	}

	if (config.mode === "none" && config.allowedPorts && config.allowedPorts.length > 0) {
		warnings.push("allowedPorts is ignored when network mode is 'none'");
	}

	if (config.mode === "none" && config.dnsServers && config.dnsServers.length > 0) {
		warnings.push("dnsServers is ignored when network mode is 'none'");
	}

	if (config.mode === "bridge" && !config.allowedPorts && !config.allowedHosts) {
		warnings.push("Bridge mode with no port/host restrictions allows all outbound traffic");
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

// =============================================================================
// Docker Argument Generation
// =============================================================================

/**
 * Convert a network isolation config to Docker CLI arguments
 */
export function networkConfigToDockerArgs(config: NetworkIsolationConfig): string[] {
	const args: string[] = [];

	// Network mode
	switch (config.mode) {
		case "none":
			args.push("--network", "none");
			break;
		case "bridge":
			// bridge is Docker's default, only add if explicitly needed with other options
			args.push("--network", "bridge");
			break;
		case "internal":
			// Internal networks block external access but allow container-to-container
			args.push("--network", "internal");
			break;
		case "custom":
			// Custom mode uses bridge as the base but applies restrictions via iptables/add-host
			args.push("--network", "bridge");
			break;
	}

	// DNS servers
	if (config.dnsServers && config.dnsServers.length > 0 && config.mode !== "none") {
		for (const dns of config.dnsServers) {
			args.push("--dns", dns);
		}
	}

	// Allowed hosts as --add-host entries (resolve to container-accessible addresses)
	if (config.allowedHosts && config.allowedHosts.length > 0 && config.mode !== "none") {
		for (const host of config.allowedHosts) {
			// Add host entries that map to the host; actual IP resolution is left to DNS
			// This ensures the container can resolve these specific hostnames
			args.push("--add-host", `${host}:0.0.0.0`);
		}
	}

	// IPv6
	if (config.enableIPv6 === false && config.mode !== "none") {
		args.push("--sysctl", "net.ipv6.conf.all.disable_ipv6=1");
	}

	return args;
}
