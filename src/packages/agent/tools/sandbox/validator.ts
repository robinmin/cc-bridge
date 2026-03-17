/**
 * Sandbox Security Validator
 *
 * Validates sandbox configurations and blocks dangerous settings.
 * Inspired by OpenClaw's security-first approach.
 */

import type { ToolSandboxDockerSettings } from "./config";

/**
 * Validation error for sandbox configuration
 */
export class SandboxValidationError extends Error {
	constructor(
		message: string,
		public readonly field: string,
	) {
		super(message);
		this.name = "SandboxValidationError";
	}
}

/**
 * Result of security validation
 */
export interface ValidationResult {
	/** Whether validation passed */
	valid: boolean;
	/** List of errors (if invalid) */
	errors: SandboxValidationError[];
	/** List of warnings (informational) */
	warnings: string[];
}

/**
 * Security validator for sandbox configurations
 */
export class SandboxSecurityValidator {
	constructor() {
		// Explicit constructor for coverage tracking
	}

	/**
	 * Validate Docker sandbox settings
	 */
	validateDockerSettings(settings: ToolSandboxDockerSettings): ValidationResult {
		const errors: SandboxValidationError[] = [];
		const warnings: string[] = [];

		// Block host network mode (runtime defense-in-depth; type system also prevents this)
		if ((settings.network as string) === "host") {
			errors.push(new SandboxValidationError("Host network mode is not allowed for sandbox isolation", "network"));
		}

		// Block unconfined seccomp
		if (settings.seccompProfile === "unconfined") {
			errors.push(new SandboxValidationError("Unconfined seccomp profile is not allowed", "seccompProfile"));
		}

		// Block unconfined AppArmor
		if (settings.apparmorProfile === "unconfined") {
			errors.push(new SandboxValidationError("Unconfined AppArmor profile is not allowed", "apparmorProfile"));
		}

		// Validate bind mounts
		if (settings.binds && settings.binds.length > 0) {
			for (const bind of settings.binds) {
				const validation = this.validateBindMount(bind);
				if (validation.error) {
					errors.push(validation.error);
				}
				if (validation.warning) {
					warnings.push(validation.warning);
				}
			}
		}

		// Warn about potentially dangerous settings
		if (settings.capDrop && settings.capDrop.length === 0) {
			warnings.push("Empty capDrop allows all capabilities");
		}

		if (settings.readOnlyRoot === false) {
			warnings.push("readOnlyRoot=false allows root filesystem writes");
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings,
		};
	}

	/**
	 * Validate a bind mount specification
	 */
	private validateBindMount(bind: string): { error?: SandboxValidationError; warning?: string } {
		const parts = bind.split(":");
		if (parts.length < 2) {
			return {
				error: new SandboxValidationError(`Invalid bind mount format: ${bind}. Use host:container:mode`, "binds"),
			};
		}

		const [hostPath] = parts;

		// Check for absolute path
		if (!hostPath.startsWith("/") && !hostPath.match(/^[A-Za-z]:\\/)) {
			return {
				error: new SandboxValidationError(`Bind mount host path must be absolute: ${hostPath}`, "binds"),
			};
		}

		// Warn about sensitive paths
		const sensitivePaths = ["/etc", "/var", "/usr", "/root", "/home"];
		for (const sensitive of sensitivePaths) {
			if (hostPath.startsWith(sensitive) && hostPath !== sensitive) {
				return {
					warning: `Bind mount to sensitive path: ${hostPath}`,
				};
			}
		}

		return {};
	}

	/**
	 * Validate resource limits
	 */
	validateLimits(limits: { memory?: string; cpus?: number }): ValidationResult {
		const errors: SandboxValidationError[] = [];
		const warnings: string[] = [];

		// Validate memory format
		if (limits.memory) {
			const memoryRegex = /^(\d+)(m|g|k|b)?$/i;
			if (!memoryRegex.test(limits.memory)) {
				errors.push(
					new SandboxValidationError(`Invalid memory format: ${limits.memory}. Use format like 512m, 2g, 1g`, "memory"),
				);
			}
		}

		// Validate CPU value
		if (limits.cpus !== undefined) {
			if (limits.cpus <= 0) {
				errors.push(new SandboxValidationError(`CPU limit must be positive: ${limits.cpus}`, "cpus"));
			}
			if (limits.cpus > 64) {
				warnings.push(`Very high CPU limit: ${limits.cpus}`);
			}
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings,
		};
	}

	/**
	 * Validate complete sandbox config
	 */
	validate(config: {
		docker?: ToolSandboxDockerSettings;
		limits?: { memory?: string; cpus?: number };
	}): ValidationResult {
		const allErrors: SandboxValidationError[] = [];
		const allWarnings: string[] = [];

		if (config.docker) {
			const dockerResult = this.validateDockerSettings(config.docker);
			allErrors.push(...dockerResult.errors);
			allWarnings.push(...dockerResult.warnings);
		}

		if (config.limits) {
			const limitsResult = this.validateLimits(config.limits);
			allErrors.push(...limitsResult.errors);
			allWarnings.push(...limitsResult.warnings);
		}

		return {
			valid: allErrors.length === 0,
			errors: allErrors,
			warnings: allWarnings,
		};
	}
}

/**
 * Default security validator instance
 */
export const sandboxValidator = new SandboxSecurityValidator();

/**
 * Validate and throw on error
 */
export function validateSandboxConfig(config: {
	docker?: ToolSandboxDockerSettings;
	limits?: { memory?: string; cpus?: number };
}): void {
	const result = sandboxValidator.validate(config);
	if (!result.valid) {
		const messages = result.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
		throw new SandboxValidationError(`Invalid sandbox configuration: ${messages}`, "config");
	}
}
