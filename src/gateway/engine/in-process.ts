/**
 * In-Process Execution Engine
 *
 * Worker-thread based pi-mono execution.
 * Feature-flagged and disabled by default until fully implemented.
 *
 * TODO: Full implementation requirements:
 * - Bun worker thread support for pi-mono runtime
 * - Clean termination on timeout
 * - Memory limit enforcement
 * - Structured clone for message passing
 * - Error isolation from worker crashes
 *
 * If Bun workers are insufficient, use Bun.spawn with the same binary as subprocess.
 */

import type { ExecutionRequest, ExecutionResult, IExecutionEngine, LayerHealth } from "./contracts";

/**
 * In-process execution engine (stub)
 *
 * This is a feature-flagged stub that returns unavailable.
 * Full implementation is deferred to a follow-up task.
 */
export class InProcessEngine implements IExecutionEngine {
	private readonly enabled: boolean;

	constructor(enabled: boolean = false) {
		this.enabled = enabled;
	}

	getLayer(): "in-process" {
		return "in-process";
	}

	async isAvailable(): Promise<boolean> {
		// TODO: When implementing full version, check:
		// - Bun worker thread support
		// - Worker thread availability
		// - pi-mono runtime availability
		return this.enabled && false; // Always returns false until fully implemented
	}

	async execute(_request: ExecutionRequest): Promise<ExecutionResult> {
		const available = await this.isAvailable();

		if (!available) {
			return {
				status: "failed",
				error: "In-process engine is not available. Enable via config or use another layer.",
				retryable: false,
			};
		}

		// TODO: Full implementation:
		// 1. Create worker thread with pi-mono
		// 2. Send prompt via structured clone
		// 3. Handle worker messages for output
		// 4. Implement timeout handling
		// 5. Implement memory limit enforcement
		// 6. Handle worker crashes

		return {
			status: "failed",
			error: "In-process engine not yet implemented",
			retryable: false,
		};
	}

	async getHealth(): Promise<LayerHealth> {
		const available = await this.isAvailable();
		return {
			layer: "in-process",
			available,
			lastCheck: new Date(),
			error: available ? undefined : "Feature-flagged and not yet implemented",
		};
	}
}
