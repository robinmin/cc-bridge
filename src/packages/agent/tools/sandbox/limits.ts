/**
 * Resource Limits for Sandbox Execution
 *
 * Defines and parses resource limits for containerized tool execution.
 */

import type { SandboxLimits } from "./config";

/**
 * Parsed resource limits for Docker
 */
export interface ParsedLimits {
	/** Memory limit flag */
	memory?: string;
	/** Memory swap limit flag */
	memorySwap?: string;
	/** CPU shares */
	cpus?: number;
	/** PID limit */
	pidsLimit?: number;
	/** Timeout in ms */
	timeoutMs?: number;
}

/**
 * Parse and validate resource limits
 */
export function parseResourceLimits(limits?: SandboxLimits): ParsedLimits {
	if (!limits) {
		return {};
	}

	const parsed: ParsedLimits = {};

	// Parse memory
	if (limits.memory) {
		parsed.memory = normalizeMemory(limits.memory);
	}

	// Parse memory swap
	if (limits.memorySwap) {
		parsed.memorySwap = normalizeMemory(limits.memorySwap);
	}

	// Parse CPU
	if (limits.cpus !== undefined) {
		if (limits.cpus <= 0) {
			throw new Error(`CPU limit must be positive: ${limits.cpus}`);
		}
		parsed.cpus = limits.cpus;
	}

	// Parse PID limit
	if (limits.pidsLimit !== undefined) {
		if (limits.pidsLimit < 0) {
			throw new Error(`PID limit must be non-negative: ${limits.pidsLimit}`);
		}
		parsed.pidsLimit = limits.pidsLimit;
	}

	// Parse timeout
	if (limits.timeoutMs !== undefined) {
		if (limits.timeoutMs <= 0) {
			throw new Error(`Timeout must be positive: ${limits.timeoutMs}`);
		}
		parsed.timeoutMs = limits.timeoutMs;
	}

	return parsed;
}

/**
 * Normalize memory string to Docker format
 */
export function normalizeMemory(value: string): string {
	// Already has a unit
	if (/^\d+[mMgGbBkK]$/i.test(value)) {
		return value.toLowerCase();
	}

	// Plain number - assume bytes
	const num = parseInt(value, 10);
	if (Number.isNaN(num)) {
		throw new Error(`Invalid memory value: ${value}`);
	}

	// Convert to appropriate unit
	if (num >= 1024 * 1024 * 1024) {
		return `${Math.round(num / (1024 * 1024 * 1024))}g`;
	}
	if (num >= 1024 * 1024) {
		return `${Math.round(num / (1024 * 1024))}m`;
	}
	if (num >= 1024) {
		return `${Math.round(num / 1024)}k`;
	}
	return `${num}b`;
}

/**
 * Convert limits to Docker CLI arguments
 */
export function limitsToDockerArgs(limits: ParsedLimits): string[] {
	const args: string[] = [];

	if (limits.memory) {
		args.push("--memory", limits.memory);
	}

	if (limits.memorySwap) {
		args.push("--memory-swap", limits.memorySwap);
	}

	if (limits.cpus !== undefined) {
		args.push("--cpus", String(limits.cpus));
	}

	if (limits.pidsLimit !== undefined && limits.pidsLimit > 0) {
		args.push("--pids-limit", String(limits.pidsLimit));
	}

	return args;
}

/**
 * Default limits for tool execution
 */
export const DEFAULT_LIMITS: SandboxLimits = {
	memory: "512m",
	cpus: 1,
	pidsLimit: 64,
	timeoutMs: 60000, // 1 minute
};

/**
 * Strict limits - more restrictive
 */
export const STRICT_LIMITS: SandboxLimits = {
	memory: "256m",
	cpus: 0.5,
	pidsLimit: 32,
	timeoutMs: 30000, // 30 seconds
};

/**
 * Lenient limits - for trusted tools
 */
export const LENIENT_LIMITS: SandboxLimits = {
	memory: "2g",
	cpus: 2,
	pidsLimit: 256,
	timeoutMs: 300000, // 5 minutes
};
