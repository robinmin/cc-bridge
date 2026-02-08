import { logger } from "@/packages/logger";
import type { CircuitState, IIpcClient, IpcRequest, IpcResponse } from "./types";

// Circuit breaker configuration
const CIRCUIT_BREAKER_CONFIG = {
	threshold: 5, // Number of failures before opening
	halfOpenTimeoutMs: 60000, // Time before trying again (1 minute)
	resetTimeoutMs: 120000, // Time to fully reset (2 minutes)
};

/**
 * Circuit Breaker wrapper for IPC clients
 * Prevents cascading failures by stopping requests to failing IPC methods
 */
export class CircuitBreakerIpcClient implements IIpcClient {
	private circuitState: CircuitState = {
		failures: 0,
		lastFailureTime: 0,
		state: "closed",
	};

	constructor(private readonly client: IIpcClient) {}

	getMethod(): string {
		return this.client.getMethod();
	}

	isAvailable(): boolean {
		// Check if circuit breaker allows requests
		if (!this.isCircuitAvailable()) {
			return false;
		}
		return this.client.isAvailable();
	}

	async sendRequest(request: IpcRequest, timeout?: number): Promise<IpcResponse> {
		// Check circuit breaker
		if (!this.isCircuitAvailable()) {
			return {
				id: request.id,
				status: 503,
				error: {
					message: "Service temporarily unavailable (circuit breaker open)",
				},
			};
		}

		try {
			const response = await this.client.sendRequest(request, timeout);

			// Record success for circuit breaker
			this.recordSuccess();

			return response;
		} catch (error) {
			// Record failure for circuit breaker
			this.recordFailure();

			return {
				id: request.id,
				status: 500,
				error: {
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}

	private isCircuitAvailable(): boolean {
		const now = Date.now();
		const state = this.circuitState;

		// Reset to closed if enough time has passed
		if (state.state === "open" && now - state.lastFailureTime > CIRCUIT_BREAKER_CONFIG.resetTimeoutMs) {
			logger.info("Circuit breaker reset to closed state");
			state.failures = 0;
			state.state = "closed";
			return true;
		}

		// Try half-open after threshold
		if (state.state === "open" && now - state.lastFailureTime > CIRCUIT_BREAKER_CONFIG.halfOpenTimeoutMs) {
			logger.info("Circuit breaker entering half-open state");
			state.state = "half-open";
			return true;
		}

		return state.state !== "open";
	}

	private recordSuccess() {
		const state = this.circuitState;
		if (state.state === "half-open") {
			logger.info("Circuit breaker recovered, returning to closed state");
			state.failures = 0;
			state.state = "closed";
		} else if (state.state === "closed" && state.failures > 0) {
			// Decay failures on success
			state.failures = Math.max(0, state.failures - 1);
		}
	}

	private recordFailure() {
		const state = this.circuitState;
		state.failures++;
		state.lastFailureTime = Date.now();

		logger.warn(
			{
				method: this.getMethod(),
				failures: state.failures,
				threshold: CIRCUIT_BREAKER_CONFIG.threshold,
			},
			"IPC call failed",
		);

		if (state.failures >= CIRCUIT_BREAKER_CONFIG.threshold) {
			logger.error("Circuit breaker opened due to repeated failures");
			state.state = "open";
		}
	}

	/**
	 * Reset circuit breaker state (useful for testing or manual recovery)
	 */
	resetCircuitBreaker() {
		this.circuitState = {
			failures: 0,
			lastFailureTime: 0,
			state: "closed",
		};
		logger.info("Circuit breaker manually reset");
	}

	/**
	 * Get current circuit breaker state (for monitoring)
	 */
	getCircuitState(): CircuitState {
		return { ...this.circuitState };
	}
}
