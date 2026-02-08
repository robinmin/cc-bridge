/**
 * Error type categories for recovery strategies
 */
export enum ErrorType {
	FILE_WRITE = "file_write",
	STOP_HOOK = "stop_hook",
	CALLBACK = "callback",
	NETWORK = "network",
	DISK_SPACE = "disk_space",
	PERMISSION = "permission",
}

import { EventEmitter } from "node:events";

/**
 * Recovery event types
 */
export type RecoveryEvent =
	| "error:recovered"
	| "error:failed"
	| "health:check"
	| "session:restarted"
	| "container:restarted";

/**
 * Recovery action types
 */
export enum RecoveryAction {
	RETRY = "retry",
	FALLBACK = "fallback",
	NOTIFY = "notify",
	DEGRADE = "degrade",
	CIRCUIT_BREAK = "circuit_break",
}

/**
 * Error context for recovery handling
 */
export interface ErrorContext {
	errorType: ErrorType;
	requestId: string;
	workspace: string;
	error: Error;
	attemptCount: number;
	metadata?: Record<string, unknown>;
}

/**
 * Recovery strategy configuration
 */
export interface RecoveryStrategy {
	maxRetries: number;
	backoffMs: number;
	fallbackAction?: () => Promise<void>;
	circuitBreakerThreshold?: number;
	circuitBreakResetMs?: number;
}

/**
 * Circuit breaker state
 */
interface CircuitBreakerState {
	isOpen: boolean;
	lastFailureTime: number;
	failureCount: number;
}

/**
 * Error recovery service with circuit breakers and retry logic
 */
export class ErrorRecoveryService {
	private failureCounters: Map<ErrorType, number> = new Map();
	private circuitBreakers: Map<ErrorType, CircuitBreakerState> = new Map();
	private lastFailures: Map<ErrorType, number> = new Map();
	private recoveryStrategies: Map<ErrorType, RecoveryStrategy> = new Map();
	private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
	private readonly HEALTH_CHECK_INTERVAL = 60000; // 60 seconds
	private events: EventEmitter;

	constructor() {
		// Create native EventEmitter instance
		this.events = new EventEmitter();

		// Set max listeners to accommodate multiple recovery strategies
		this.events.setMaxListeners(50);

		// Initialize recovery strategies for each error type
		this.recoveryStrategies = new Map([
			[
				ErrorType.FILE_WRITE,
				{
					maxRetries: 3,
					backoffMs: 1000,
					circuitBreakerThreshold: 10,
					circuitBreakResetMs: 300000, // 5 minutes
				},
			],
			[
				ErrorType.STOP_HOOK,
				{
					maxRetries: 3,
					backoffMs: 2000,
					circuitBreakerThreshold: 5,
					circuitBreakResetMs: 300000,
				},
			],
			[
				ErrorType.CALLBACK,
				{
					maxRetries: 3,
					backoffMs: 1000,
					circuitBreakerThreshold: 10,
					circuitBreakResetMs: 300000,
				},
			],
			[
				ErrorType.NETWORK,
				{
					maxRetries: 5,
					backoffMs: 500,
					circuitBreakerThreshold: 20,
					circuitBreakResetMs: 300000,
				},
			],
			[
				ErrorType.DISK_SPACE,
				{
					maxRetries: 2,
					backoffMs: 5000,
					circuitBreakerThreshold: 3,
					circuitBreakResetMs: 600000, // 10 minutes
				},
			],
			[
				ErrorType.PERMISSION,
				{
					maxRetries: 1,
					backoffMs: 0,
					circuitBreakerThreshold: 5,
					circuitBreakerResetMs: 300000,
				},
			],
		]);
	}

	/**
	 * Start the error recovery service
	 */
	start(): void {
		// Clear existing timer if any
		this.stopHealthCheck();

		this.healthCheckTimer = setInterval(() => {
			this.resetCircuitBreakers().catch((err) => {
				this.logger.error({ error: err }, "Health check failed");
			});
		}, this.HEALTH_CHECK_INTERVAL);

		this.logger.info("Error recovery service started");
	}

	/**
	 * Stop the error recovery service
	 */
	async stop(): Promise<void> {
		this.logger.info("Stopping error recovery service");

		// Stop health check timer
		this.stopHealthCheck();

		this.logger.info("Error recovery service stopped");
	}

	/**
	 * Stop health check timer
	 */
	private stopHealthCheck(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
			this.logger.debug("Health check timer stopped");
		}
	}

	/**
	 * Handle error with automatic recovery
	 */
	async handleError(context: ErrorContext): Promise<boolean> {
		const { errorType, requestId } = context;

		// Check circuit breaker
		if (this.isCircuitOpen(errorType)) {
			this.logger.warn({ errorType, requestId }, "Circuit breaker open, skipping recovery");
			this.emit("recovery:circuit_open", context);
			return false;
		}

		// Get recovery strategy
		const strategy = this.recoveryStrategies.get(errorType);
		if (!strategy) {
			this.logger.error({ errorType }, "No recovery strategy defined");
			return false;
		}

		// Attempt recovery based on error type
		try {
			const recovered = await this.attemptRecovery(context, strategy);

			if (recovered) {
				this.resetFailureCounter(errorType);
				this.emit("recovery:success", context);
				return true;
			}

			// Increment failure counter
			this.incrementFailureCounter(errorType);

			// Check if we should open circuit breaker
			if (strategy.circuitBreakerThreshold) {
				const failures = this.failureCounters.get(errorType) || 0;
				if (failures >= strategy.circuitBreakerThreshold) {
					this.openCircuitBreaker(errorType);
				}
			}

			this.emit("recovery:failure", context);
			return false;
		} catch (err) {
			this.logger.error({ err, context }, "Recovery attempt failed");
			this.emit("recovery:error", context);
			return false;
		}
	}

	/**
	 * Attempt recovery based on error type
	 */
	private async attemptRecovery(context: ErrorContext, strategy: RecoveryStrategy): Promise<boolean> {
		switch (context.errorType) {
			case ErrorType.FILE_WRITE:
				return this.recoverFileWrite(context, strategy);
			case ErrorType.STOP_HOOK:
				return this.recoverStopHook(context, strategy);
			case ErrorType.CALLBACK:
				return this.recoverCallback(context, strategy);
			case ErrorType.NETWORK:
				return this.recoverNetwork(context, strategy);
			case ErrorType.DISK_SPACE:
				return this.recoverDiskSpace(context, strategy);
			case ErrorType.PERMISSION:
				return this.recoverPermission(context, strategy);
			default:
				this.logger.warn({ errorType: context.errorType }, "Unknown error type");
				return false;
		}
	}

	/**
	 * Recover from file write failure
	 */
	protected async recoverFileWrite(context: ErrorContext, strategy: RecoveryStrategy): Promise<boolean> {
		const { requestId, workspace, metadata } = context;
		const filePath = metadata?.filePath as string;
		const data = metadata?.data as string;

		if (!filePath || !data) {
			this.logger.error("Missing file path or data for recovery");
			return false;
		}

		// Retry write with exponential backoff
		for (let attempt = 1; attempt <= strategy.maxRetries; attempt++) {
			try {
				const fs = await import("node:fs/promises");
				const path = await import("node:path");

				await fs.mkdir(path.dirname(filePath), { recursive: true });
				const tempPath = `${filePath}.tmp`;
				await fs.writeFile(tempPath, data, "utf-8");
				await fs.rename(tempPath, filePath);

				this.logger.info({ requestId, filePath, attempt }, "File write recovered");
				return true;
			} catch (err) {
				this.logger.warn({ err, attempt, maxRetries: strategy.maxRetries }, "File write retry failed");
				if (attempt < strategy.maxRetries) {
					await this.sleep(strategy.backoffMs * attempt);
				}
			}
		}

		// Try fallback directory
		return this.tryFallbackDirectory(requestId, workspace, data);
	}

	/**
	 * Recover from Stop Hook failure
	 */
	protected async recoverStopHook(context: ErrorContext, _strategy: RecoveryStrategy): Promise<boolean> {
		this.logger.warn({ context }, "Stop Hook failed, entering offline mode");
		this.emit("stop_hook:fallback_polling", context);
		return true; // Graceful degradation - offline mode is OK
	}

	/**
	 * Recover from callback failure
	 */
	protected async recoverCallback(context: ErrorContext, _strategy: RecoveryStrategy): Promise<boolean> {
		const { requestId, workspace } = context;

		this.emit("callback:dead_letter", {
			requestId,
			workspace,
			retryAfter: Date.now() + 60000,
		});

		return true; // File was written, gateway will poll
	}

	/**
	 * Recover from network failure
	 */
	protected async recoverNetwork(context: ErrorContext, strategy: RecoveryStrategy): Promise<boolean> {
		for (let attempt = 1; attempt <= strategy.maxRetries; attempt++) {
			try {
				await this.testConnectivity();
				this.logger.info({ attempt }, "Network connectivity restored");
				return true;
			} catch (_err) {
				if (attempt < strategy.maxRetries) {
					const delay = strategy.backoffMs * 2 ** (attempt - 1);
					await this.sleep(delay);
				}
			}
		}

		this.emit("network:offline_mode", context);
		return false;
	}

	/**
	 * Recover from disk space issue
	 */
	protected async recoverDiskSpace(_context: ErrorContext, _strategy: RecoveryStrategy): Promise<boolean> {
		this.emit("disk:emergency_cleanup", {});
		await this.sleep(5000);
		return true;
	}

	/**
	 * Recover from permission error
	 */
	protected async recoverPermission(context: ErrorContext, _strategy: RecoveryStrategy): Promise<boolean> {
		const filePath = context.metadata?.filePath as string;
		if (!filePath) return false;

		try {
			const fs = await import("node:fs/promises");
			const path = await import("node:path");

			await fs.chmod(path.dirname(filePath), 0o755);
			return true;
		} catch (_err) {
			return false;
		}
	}

	/**
	 * Try writing to fallback directory
	 */
	private async tryFallbackDirectory(requestId: string, workspace: string, data: string): Promise<boolean> {
		try {
			const fs = await import("node:fs/promises");
			const path = await import("node:path");

			const fallbackPath = `/tmp/ipc-fallback/${workspace}/responses/${requestId}.json`;
			await fs.mkdir(path.dirname(fallbackPath), { recursive: true });
			await fs.writeFile(fallbackPath, data, "utf-8");

			this.emit("file:fallback_directory", {
				requestId,
				workspace,
				fallbackPath,
			});
			return true;
		} catch (err) {
			this.logger.error({ err, requestId, workspace }, "Fallback directory write failed");
			return false;
		}
	}

	/**
	 * Test network connectivity
	 */
	private async testConnectivity(): Promise<void> {
		// Simple connectivity check - can be enhanced
		const response = await fetch("http://localhost:8080/health", {
			method: "GET",
			signal: AbortSignal.timeout(5000),
		}).catch(() => null);

		if (!response || !response.ok) {
			throw new Error("Connectivity test failed");
		}
	}

	/**
	 * Increment failure counter for error type
	 */
	private incrementFailureCounter(errorType: ErrorType): void {
		const current = this.failureCounters.get(errorType) || 0;
		this.failureCounters.set(errorType, current + 1);
		this.lastFailures.set(errorType, Date.now());
	}

	/**
	 * Reset failure counter for error type
	 */
	private resetFailureCounter(errorType: ErrorType): void {
		this.failureCounters.set(errorType, 0);
	}

	/**
	 * Check if circuit breaker is open for error type
	 */
	private isCircuitOpen(errorType: ErrorType): boolean {
		const state = this.circuitBreakers.get(errorType);
		return state?.isOpen ?? false;
	}

	/**
	 * Open circuit breaker for error type
	 */
	private openCircuitBreaker(errorType: ErrorType): void {
		this.circuitBreakers.set(errorType, {
			isOpen: true,
			lastFailureTime: Date.now(),
			failureCount: this.failureCounters.get(errorType) || 0,
		});
		this.emit("circuit_breaker:open", { errorType });
		this.logger.warn({ errorType }, "Circuit breaker opened");
	}

	/**
	 * Reset circuit breakers that have expired their reset time
	 */
	private resetCircuitBreakers(): void {
		const now = Date.now();

		for (const [errorType, state] of this.circuitBreakers.entries()) {
			if (!state.isOpen) continue;

			const strategy = this.recoveryStrategies.get(errorType);
			const resetThreshold = strategy?.circuitBreakerResetMs || 300000;

			if (now - state.lastFailureTime > resetThreshold) {
				this.circuitBreakers.set(errorType, {
					isOpen: false,
					lastFailureTime: 0,
					failureCount: 0,
				});
				this.resetFailureCounter(errorType);
				this.emit("circuit_breaker:reset", { errorType });
				this.logger.info({ errorType }, "Circuit breaker reset");
			}
		}
	}

	/**
	 * Sleep utility
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Get statistics
	 */
	getStats(): Record<
		string,
		{
			failures: number;
			circuitOpen: boolean;
			lastFailure: number;
		}
	> {
		const stats: Record<string, { failures: number; circuitOpen: boolean; lastFailure: number }> = {};

		for (const [errorType, count] of this.failureCounters.entries()) {
			const state = this.circuitBreakers.get(errorType);
			stats[errorType] = {
				failures: count,
				circuitOpen: state?.isOpen ?? false,
				lastFailure: this.lastFailures.get(errorType) || 0,
			};
		}

		return stats;
	}

	/**
	 * Logger (placeholder - would use injected logger)
	 */
	private logger = {
		info: (msg: string, meta?: Record<string, unknown>) => {
			if (process.env.NODE_ENV !== "test") {
				console.log(`[ErrorRecovery] INFO ${msg}`, meta || "");
			}
		},
		warn: (msg: string, meta?: Record<string, unknown>) => {
			if (process.env.NODE_ENV !== "test") {
				console.warn(`[ErrorRecovery] WARN ${msg}`, meta || "");
			}
		},
		error: (msg: string, meta?: Record<string, unknown>) => {
			console.error(`[ErrorRecovery] ERROR ${msg}`, meta || "");
		},
		debug: (msg: string, meta?: Record<string, unknown>) => {
			if (process.env.NODE_ENV !== "test") {
				console.debug(`[ErrorRecovery] DEBUG ${msg}`, meta || "");
			}
		},
	};

	/**
	 * Register event listener
	 */
	on(event: RecoveryEvent | string, listener: (...args: unknown[]) => void): void {
		this.events.on(event, listener);
		this.logger.debug({ event }, "Event listener registered");
	}

	/**
	 * Register one-time event listener
	 */
	once(event: RecoveryEvent | string, listener: (...args: unknown[]) => void): void {
		this.events.once(event, listener);
		this.logger.debug({ event }, "One-time event listener registered");
	}

	/**
	 * Remove event listener
	 */
	off(event: RecoveryEvent | string, listener: (...args: unknown[]) => void): void {
		this.events.off(event, listener);
		this.logger.debug({ event }, "Event listener removed");
	}

	/**
	 * Remove all listeners for an event or all events
	 */
	removeAllListeners(event?: RecoveryEvent | string): void {
		if (event) {
			this.events.removeAllListeners(event);
			this.logger.debug({ event }, "All listeners removed for event");
		} else {
			this.events.removeAllListeners();
			this.logger.debug("All listeners removed");
		}
	}

	/**
	 * Get listener count for event
	 */
	listenerCount(event: RecoveryEvent | string): number {
		return this.events.listenerCount(event);
	}

	/**
	 * Get event names
	 */
	eventNames(): (string | symbol)[] {
		return this.events.eventNames();
	}

	/**
	 * Emit event
	 */
	emit(event: RecoveryEvent | string, ...args: unknown[]): void {
		this.events.emit(event, ...args);
	}
}
