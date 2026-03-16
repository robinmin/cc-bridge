/**
 * Permission Tiers
 *
 * Defines hierarchical permission tiers for the enhanced tool system.
 * Higher tiers include all permissions from lower tiers.
 *
 * This is a simple tier model inspired by AWS IAM:
 * - READ: Read-only access to non-sensitive resources
 * - WRITE: Write access to workspace files
 * - EXECUTE: Execute commands with restrictions
 * - ADMIN: Full administrative access
 */

/**
 * Permission tiers define hierarchical access levels.
 * Order matters: higher values include lower tier permissions.
 */
export enum PermissionTier {
	/** Read-only access to non-sensitive resources */
	READ = 1,
	/** Write access to workspace files */
	WRITE = 2,
	/** Execute commands with restrictions */
	EXECUTE = 3,
	/** Full administrative access */
	ADMIN = 4,
}

/**
 * Default tier requirements for built-in tools.
 * These can be overridden in tool configuration.
 */
export const DEFAULT_TOOL_TIERS: Record<string, PermissionTier> = {
	read_file: PermissionTier.READ,
	web_search: PermissionTier.READ,
	write_file: PermissionTier.WRITE,
	bash: PermissionTier.EXECUTE,
};

/**
 * Check if a tier has sufficient permission for another tier.
 */
export function hasTierPermission(userTier: PermissionTier, requiredTier: PermissionTier): boolean {
	return userTier >= requiredTier;
}

/**
 * Get the default tier requirement for a tool by name.
 */
export function getDefaultTier(toolName: string): PermissionTier {
	// Normalize tool name (handle both "bash" and "BashTool" formats)
	const normalized = toolName.toLowerCase().replace(/tool$/, "");
	return DEFAULT_TOOL_TIERS[normalized] ?? PermissionTier.READ;
}

/**
 * Get tier name for logging/display
 */
export function getTierName(tier: PermissionTier): string {
	switch (tier) {
		case PermissionTier.READ:
			return "READ";
		case PermissionTier.WRITE:
			return "WRITE";
		case PermissionTier.EXECUTE:
			return "EXECUTE";
		case PermissionTier.ADMIN:
			return "ADMIN";
		default:
			return "UNKNOWN";
	}
}
