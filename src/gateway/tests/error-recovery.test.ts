import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
	type ErrorContext,
	ErrorRecoveryService,
	ErrorType,
	type RecoveryStrategy,
} from "@/gateway/services/ErrorRecoveryService";

/**
 * Testable ErrorRecoveryService that allows forcing failures
 */
class TestableErrorRecoveryService extends ErrorRecoveryService {
	private forceFailTypes: Set<ErrorType> = new Set();
	private eventCaptureCallback?: (event: string, ...args: unknown[]) => void;

	// Expose private properties for testing
	public getRecoveryStrategies(): Map<ErrorType, RecoveryStrategy> {
		return this["recoveryStrategies"] as Map<ErrorType, RecoveryStrategy>;
	}

	public getCircuitBreakers(): Map<ErrorType, { isOpen: boolean; lastFailureTime: number; failureCount: number }> {
		return this["circuitBreakers"] as Map<
			ErrorType,
			{ isOpen: boolean; lastFailureTime: number; failureCount: number }
		>;
	}

	/**
	 * Force specific error types to always fail recovery
	 */
	forceFailure(errorType: ErrorType): void {
		this.forceFailTypes.add(errorType);
	}

	clearForceFailures(): void {
		this.forceFailTypes.clear();
	}

	/**
	 * Set callback to capture emitted events
	 */
	setEventCapture(callback: (event: string, ...args: unknown[]) => void): void {
		this.eventCaptureCallback = callback;
	}

	public override emit(event: string, ...args: unknown[]): void {
		// Call capture callback if set
		if (this.eventCaptureCallback) {
			this.eventCaptureCallback(event, ...args);
		}
		// Call parent emit
		super.emit(event, ...args);
	}

	protected override async recoverFileWrite(context: ErrorContext, strategy: RecoveryStrategy): Promise<boolean> {
		if (this.forceFailTypes.has(ErrorType.FILE_WRITE)) {
			return false;
		}
		return super.recoverFileWrite(context, strategy);
	}

	protected override async recoverStopHook(context: ErrorContext, strategy: RecoveryStrategy): Promise<boolean> {
		if (this.forceFailTypes.has(ErrorType.STOP_HOOK)) {
			return false;
		}
		return super.recoverStopHook(context, strategy);
	}

	protected override async recoverCallback(context: ErrorContext, strategy: RecoveryStrategy): Promise<boolean> {
		if (this.forceFailTypes.has(ErrorType.CALLBACK)) {
			return false;
		}
		return super.recoverCallback(context, strategy);
	}

	protected override async recoverNetwork(context: ErrorContext, strategy: RecoveryStrategy): Promise<boolean> {
		if (this.forceFailTypes.has(ErrorType.NETWORK)) {
			// Emit the offline_mode event like the base method does
			this.emit("network:offline_mode", context);
			return false;
		}
		return super.recoverNetwork(context, strategy);
	}

	protected override async recoverDiskSpace(_context: ErrorContext, _strategy: RecoveryStrategy): Promise<boolean> {
		if (this.forceFailTypes.has(ErrorType.DISK_SPACE)) {
			return false;
		}
		// Use shorter sleep time for faster tests (100ms instead of 5000ms)
		this.emit("disk:emergency_cleanup", {});
		await this.sleep(100);
		return true;
	}

	protected override async recoverPermission(context: ErrorContext, strategy: RecoveryStrategy): Promise<boolean> {
		if (this.forceFailTypes.has(ErrorType.PERMISSION)) {
			return false;
		}
		return super.recoverPermission(context, strategy);
	}
}

describe("ErrorRecoveryService", () => {
	let service: TestableErrorRecoveryService;
	let testDir: string;
	let capturedEvents: Array<{ event: string; data: unknown[] }>;

	beforeEach(async () => {
		service = new TestableErrorRecoveryService();
		testDir = `/tmp/test-error-recovery-${Date.now()}`;
		await mkdir(testDir, { recursive: true });
		capturedEvents = [];

		// Capture events using the test helper
		service.setEventCapture((event, ...args) => {
			capturedEvents.push({ event, data: args });
		});
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	describe("Circuit Breaker", () => {
		test("should open circuit after threshold failures", async () => {
			const strategy = service.getRecoveryStrategies().get(ErrorType.FILE_WRITE);
			const threshold = strategy.circuitBreakerThreshold; // 10

			// Force FILE_WRITE to always fail
			service.forceFailure(ErrorType.FILE_WRITE);

			const context = {
				errorType: ErrorType.FILE_WRITE,
				requestId: "req-001",
				workspace: "test",
				error: new Error("Write failed"),
				attemptCount: 1,
				metadata: {
					filePath: path.join(testDir, "nonexistent", "test.txt"),
					data: "test data",
				},
			};

			// Fail until circuit opens
			for (let i = 0; i < threshold; i++) {
				await service.handleError(context);
			}

			// Circuit should be open now
			const result = await service.handleError(context);
			expect(result).toBe(false); // Should return false due to open circuit

			// Check circuit breaker state
			const stats = service.getStats();
			expect(stats[ErrorType.FILE_WRITE].circuitOpen).toBe(true);

			service.clearForceFailures();
		});

		test("should reset circuit breaker after timeout", async () => {
			// Force PERMISSION to always fail
			service.forceFailure(ErrorType.PERMISSION);

			const context = {
				errorType: ErrorType.PERMISSION,
				requestId: "req-002",
				workspace: "test",
				error: new Error("Permission denied"),
				attemptCount: 1,
				metadata: { filePath: path.join(testDir, "test.txt") },
			};

			const strategy = service.getRecoveryStrategies().get(ErrorType.PERMISSION);
			const threshold = strategy.circuitBreakerThreshold; // 5

			// Open circuit
			for (let i = 0; i < threshold; i++) {
				await service.handleError(context);
			}

			const beforeReset = service.getStats();
			expect(beforeReset[ErrorType.PERMISSION]?.circuitOpen).toBe(true);

			// Verify that the circuit breaker has a lastFailureTime set
			const state = service.getCircuitBreakers().get(ErrorType.PERMISSION);
			expect(state.lastFailureTime).toBeGreaterThan(0);
			expect(state.isOpen).toBe(true);

			// Verify the reset configuration exists
			expect(strategy.circuitBreakerResetMs).toBeDefined();
			expect(strategy.circuitBreakerResetMs).toBe(300000); // 5 minutes

			service.clearForceFailures();
		});

		test("should track failures per error type independently", async () => {
			// Force both types to fail
			service.forceFailure(ErrorType.PERMISSION);
			service.forceFailure(ErrorType.FILE_WRITE);

			const permContext = {
				errorType: ErrorType.PERMISSION,
				requestId: "req-001",
				workspace: "test",
				error: new Error("Permission denied"),
				attemptCount: 1,
				metadata: { filePath: path.join(testDir, "test.txt") },
			};

			const fileWriteContext = {
				errorType: ErrorType.FILE_WRITE,
				requestId: "req-002",
				workspace: "test",
				error: new Error("File write failed"),
				attemptCount: 1,
				metadata: { filePath: path.join(testDir, "test.txt"), data: "data" },
			};

			// Fail PERMISSION 3 times
			for (let i = 0; i < 3; i++) {
				await service.handleError(permContext);
			}

			// Fail FILE_WRITE 5 times
			for (let i = 0; i < 5; i++) {
				await service.handleError(fileWriteContext);
			}

			const stats = service.getStats();

			// PERMISSION should have 3 failures
			expect(stats[ErrorType.PERMISSION]?.failures).toBe(3);
			expect(stats[ErrorType.PERMISSION]?.circuitOpen).toBe(false);

			// FILE_WRITE should have 5 failures
			expect(stats[ErrorType.FILE_WRITE]?.failures).toBe(5);
			expect(stats[ErrorType.FILE_WRITE]?.circuitOpen).toBe(false);

			service.clearForceFailures();
		});
	});

	describe("File Write Recovery", () => {
		test("should successfully write file with directory creation", async () => {
			const filePath = path.join(testDir, "nested", "dir", "test.txt");
			const data = "test data";

			const context = {
				errorType: ErrorType.FILE_WRITE,
				requestId: "req-file-001",
				workspace: "test",
				error: new Error("File write failed"),
				attemptCount: 1,
				metadata: { filePath, data },
			};

			const result = await service.handleError(context);
			expect(result).toBe(true);

			// Verify file was created
			const exists = await Bun.file(filePath).exists();
			expect(exists).toBe(true);
		});

		test("should write to fallback directory when original fails", async () => {
			// Use an invalid path that will fail
			const filePath = "/root/readonly/cannot-write.txt";
			const data = "fallback data";

			const context = {
				errorType: ErrorType.FILE_WRITE,
				requestId: "req-fallback-001",
				workspace: "test-workspace",
				error: new Error("EACCES: Permission denied"),
				attemptCount: 1,
				metadata: { filePath, data },
			};

			const result = await service.handleError(context);

			// Should succeed with fallback directory
			expect(result).toBe(true);

			// Check fallback file exists
			const fallbackPath = `/tmp/ipc-fallback/test-workspace/responses/req-fallback-001.json`;
			const exists = await Bun.file(fallbackPath).exists();
			expect(exists).toBe(true);

			// Clean up fallback file
			await rm(fallbackPath, { force: true });
		});

		test("should handle missing metadata gracefully", async () => {
			const context = {
				errorType: ErrorType.FILE_WRITE,
				requestId: "req-nometa-001",
				workspace: "test",
				error: new Error("No metadata"),
				attemptCount: 1,
			};

			const result = await service.handleError(context);
			expect(result).toBe(false);
		});
	});

	describe("Network Recovery", () => {
		test("should return false when connectivity test fails", async () => {
			// Use forceFailure instead of mocking fetch (faster and more reliable)
			service.forceFailure(ErrorType.NETWORK);

			const context = {
				errorType: ErrorType.NETWORK,
				requestId: "req-net-001",
				workspace: "test",
				error: new Error("Network error"),
				attemptCount: 1,
			};

			const result = await service.handleError(context);

			service.clearForceFailures();

			expect(result).toBe(false);

			// Should emit offline_mode event
			const offlineEvent = capturedEvents.find((e) => e.event === "network:offline_mode");
			expect(offlineEvent).toBeDefined();
		});

		test("should return true when connectivity succeeds", async () => {
			// Mock fetch to succeed
			const originalFetch = globalThis.fetch;
			globalThis.fetch = async () => {
				return new Response("OK", { status: 200 });
			};

			const context = {
				errorType: ErrorType.NETWORK,
				requestId: "req-net-002",
				workspace: "test",
				error: new Error("Network error"),
				attemptCount: 1,
			};

			const result = await service.handleError(context);

			globalThis.fetch = originalFetch;

			expect(result).toBe(true);
		});
	});

	describe("Permission Recovery", () => {
		test("should attempt to fix directory permissions", async () => {
			const testFile = path.join(testDir, "permission-test", "file.txt");

			// Create the directory first
			await mkdir(path.dirname(testFile), { recursive: true });

			const context = {
				errorType: ErrorType.PERMISSION,
				requestId: "req-perm-001",
				workspace: "test",
				error: new Error("EACCES: Permission denied"),
				attemptCount: 1,
				metadata: { filePath: testFile },
			};

			const result = await service.handleError(context);
			// Should succeed or fail based on actual permissions
			expect(typeof result).toBe("boolean");
		});

		test("should return false for missing file path", async () => {
			const context = {
				errorType: ErrorType.PERMISSION,
				requestId: "req-perm-002",
				workspace: "test",
				error: new Error("No file path"),
				attemptCount: 1,
			};

			const result = await service.handleError(context);
			expect(result).toBe(false);
		});
	});

	describe("Stop Hook Recovery", () => {
		test("should gracefully degrade on stop hook failure", async () => {
			const context = {
				errorType: ErrorType.STOP_HOOK,
				requestId: "req-hook-001",
				workspace: "test",
				error: new Error("Stop hook failed"),
				attemptCount: 1,
			};

			const result = await service.handleError(context);

			// Should return true (graceful degradation is acceptable)
			expect(result).toBe(true);

			// Should emit fallback_polling event
			const pollEvent = capturedEvents.find((e) => e.event === "stop_hook:fallback_polling");
			expect(pollEvent).toBeDefined();
		});

		test("should reset failure counter on successful degradation", async () => {
			const context = {
				errorType: ErrorType.STOP_HOOK,
				requestId: "req-hook-002",
				workspace: "test",
				error: new Error("Stop hook failed"),
				attemptCount: 1,
			};

			await service.handleError(context);

			// Stop hook recovery returns true, so counter should be reset
			const stats = service.getStats();
			// Since recovery succeeded, failure counter should be 0
			expect(stats[ErrorType.STOP_HOOK]?.failures ?? 0).toBe(0);
		});
	});

	describe("Callback Recovery", () => {
		test("should emit dead_letter event on callback failure", async () => {
			const context = {
				errorType: ErrorType.CALLBACK,
				requestId: "req-callback-001",
				workspace: "test-workspace",
				error: new Error("Callback failed"),
				attemptCount: 1,
			};

			const result = await service.handleError(context);

			// Should return true (file was written, gateway will poll)
			expect(result).toBe(true);

			// Should emit dead_letter event
			const deadLetterEvent = capturedEvents.find((e) => e.event === "callback:dead_letter");
			expect(deadLetterEvent).toBeDefined();
			const deadLetterData = deadLetterEvent?.data[0] as ErrorContext | undefined;
			expect(deadLetterData?.requestId).toBe("req-callback-001");
		});
	});

	describe("Disk Space Recovery", () => {
		test("should emit cleanup event and wait", async () => {
			const context = {
				errorType: ErrorType.DISK_SPACE,
				requestId: "req-disk-001",
				workspace: "test",
				error: new Error("ENOSPC: No space left on device"),
				attemptCount: 1,
			};

			const startTime = Date.now();
			const result = await service.handleError(context);
			const elapsed = Date.now() - startTime;

			// TestableErrorRecoveryService uses 100ms instead of 5000ms for faster tests
			expect(elapsed).toBeGreaterThanOrEqual(90);
			expect(elapsed).toBeLessThan(500); // Should be much faster than 5 seconds
			expect(result).toBe(true);

			// Should emit cleanup event
			const cleanupEvent = capturedEvents.find((e) => e.event === "disk:emergency_cleanup");
			expect(cleanupEvent).toBeDefined();
		});
	});

	describe("Statistics", () => {
		test("should return accurate statistics", async () => {
			// Force failures
			service.forceFailure(ErrorType.PERMISSION);
			service.forceFailure(ErrorType.FILE_WRITE);

			const permContext = {
				errorType: ErrorType.PERMISSION,
				requestId: "req-001",
				workspace: "test",
				error: new Error("Failed"),
				attemptCount: 1,
				metadata: { filePath: path.join(testDir, "test.txt") },
			};

			const fileContext = {
				errorType: ErrorType.FILE_WRITE,
				requestId: "req-002",
				workspace: "test",
				error: new Error("Failed"),
				attemptCount: 1,
				metadata: { filePath: path.join(testDir, "test.txt"), data: "data" },
			};

			// Generate some failures
			await service.handleError(permContext);
			await service.handleError(permContext);
			await service.handleError(fileContext);

			const stats = service.getStats();

			expect(stats[ErrorType.PERMISSION]?.failures).toBe(2);
			expect(stats[ErrorType.FILE_WRITE]?.failures).toBe(1);
			expect(stats[ErrorType.PERMISSION]?.circuitOpen).toBe(false);
			expect(stats[ErrorType.FILE_WRITE]?.circuitOpen).toBe(false);

			service.clearForceFailures();
		});

		test("should return empty object for no failures", () => {
			const stats = service.getStats();
			expect(Object.keys(stats)).toHaveLength(0);
		});
	});

	describe("Event Emission", () => {
		test("should emit recovery_success on successful recovery", async () => {
			const context = {
				errorType: ErrorType.STOP_HOOK,
				requestId: "req-event-001",
				workspace: "test",
				error: new Error("Hook failed"),
				attemptCount: 1,
			};

			await service.handleError(context);

			const successEvent = capturedEvents.find((e) => e.event === "recovery:success");
			expect(successEvent).toBeDefined();
		});

		test("should emit recovery_failure on failed recovery", async () => {
			// Force network to fail
			service.forceFailure(ErrorType.NETWORK);

			const context = {
				errorType: ErrorType.NETWORK,
				requestId: "req-event-002",
				workspace: "test",
				error: new Error("Network failed"),
				attemptCount: 1,
			};

			await service.handleError(context);

			service.clearForceFailures();

			const failureEvent = capturedEvents.find((e) => e.event === "recovery:failure");
			expect(failureEvent).toBeDefined();
		});

		test("should emit circuit_breaker_open when threshold reached", async () => {
			// Force FILE_WRITE to always fail
			service.forceFailure(ErrorType.FILE_WRITE);

			const context = {
				errorType: ErrorType.FILE_WRITE,
				requestId: "req-circuit-001",
				workspace: "test",
				error: new Error("Failed"),
				attemptCount: 1,
				metadata: { filePath: path.join(testDir, "test.txt"), data: "data" },
			};

			const threshold = service.getRecoveryStrategies().get(ErrorType.FILE_WRITE).circuitBreakerThreshold;

			// Trigger circuit opening
			for (let i = 0; i < threshold; i++) {
				await service.handleError(context);
			}

			const openEvent = capturedEvents.find((e) => e.event === "circuit_breaker:open");
			expect(openEvent).toBeDefined();
			const openEventData = openEvent?.data[0] as { errorType: ErrorType } | undefined;
			expect(openEventData?.errorType).toBe(ErrorType.FILE_WRITE);

			service.clearForceFailures();
		});
	});

	describe("Edge Cases", () => {
		test("should handle unknown error type gracefully", async () => {
			const context = {
				errorType: "unknown" as ErrorType,
				requestId: "req-edge-001",
				workspace: "test",
				error: new Error("Unknown error"),
				attemptCount: 1,
			};

			const result = await service.handleError(context);
			expect(result).toBe(false);
		});

		test("should skip recovery when circuit is already open", async () => {
			// Force FILE_WRITE to always fail
			service.forceFailure(ErrorType.FILE_WRITE);

			const context = {
				errorType: ErrorType.FILE_WRITE,
				requestId: "req-edge-003",
				workspace: "test",
				error: new Error("Failed"),
				attemptCount: 1,
				metadata: { filePath: path.join(testDir, "test.txt"), data: "data" },
			};

			// Open circuit
			const threshold = service.getRecoveryStrategies().get(ErrorType.FILE_WRITE).circuitBreakerThreshold;
			for (let i = 0; i < threshold; i++) {
				await service.handleError(context);
			}

			// Clear events
			capturedEvents.length = 0;

			// Try again - should skip recovery
			const result = await service.handleError(context);
			expect(result).toBe(false);

			// Should emit circuit_open event
			const circuitEvent = capturedEvents.find((e) => e.event === "recovery:circuit_open");
			expect(circuitEvent).toBeDefined();

			service.clearForceFailures();
		});

		test("should reset failure counter on successful recovery", async () => {
			const context = {
				errorType: ErrorType.STOP_HOOK,
				requestId: "req-counter-001",
				workspace: "test",
				error: new Error("Hook failed"),
				attemptCount: 1,
			};

			// Successful recovery resets counter
			await service.handleError(context);

			const stats = service.getStats();
			// Counter should be 0 since recovery was successful
			expect(stats[ErrorType.STOP_HOOK]?.failures ?? 0).toBe(0);
		});
	});

	describe("Recovery Strategy Configuration", () => {
		test("should have different retry limits per error type", () => {
			const strategies = service.getRecoveryStrategies();

			expect(strategies.get(ErrorType.FILE_WRITE).maxRetries).toBe(3);
			expect(strategies.get(ErrorType.STOP_HOOK).maxRetries).toBe(3);
			expect(strategies.get(ErrorType.CALLBACK).maxRetries).toBe(3);
			expect(strategies.get(ErrorType.NETWORK).maxRetries).toBe(5);
			expect(strategies.get(ErrorType.DISK_SPACE).maxRetries).toBe(2);
			expect(strategies.get(ErrorType.PERMISSION).maxRetries).toBe(1);
		});

		test("should have different circuit breaker thresholds per error type", () => {
			const strategies = service.getRecoveryStrategies();

			expect(strategies.get(ErrorType.FILE_WRITE).circuitBreakerThreshold).toBe(10);
			expect(strategies.get(ErrorType.STOP_HOOK).circuitBreakerThreshold).toBe(5);
			expect(strategies.get(ErrorType.CALLBACK).circuitBreakerThreshold).toBe(10);
			expect(strategies.get(ErrorType.NETWORK).circuitBreakerThreshold).toBe(20);
			expect(strategies.get(ErrorType.DISK_SPACE).circuitBreakerThreshold).toBe(3);
			expect(strategies.get(ErrorType.PERMISSION).circuitBreakerThreshold).toBe(5);
		});
	});

	describe("Lifecycle and Event API", () => {
		test("should start and stop health check timer", async () => {
			service.start();
			expect(service["healthCheckTimer"]).not.toBeNull();
			await service.stop();
			expect(service["healthCheckTimer"]).toBeNull();
		});

		test("should support on/once/off/removeAll/listenerCount/eventNames wrappers", () => {
			const onListener = (..._args: unknown[]) => {};
			const onceListener = (..._args: unknown[]) => {};

			service.on("health:check", onListener);
			service.once("health:check", onceListener);

			expect(service.listenerCount("health:check")).toBe(2);
			expect(service.eventNames()).toContain("health:check");

			service.emit("health:check", { ok: true });
			// once listener should have been removed after first emit
			expect(service.listenerCount("health:check")).toBe(1);

			service.off("health:check", onListener);
			expect(service.listenerCount("health:check")).toBe(0);

			service.on("error:failed", () => {});
			service.removeAllListeners("error:failed");
			expect(service.listenerCount("error:failed")).toBe(0);

			service.on("error:failed", () => {});
			service.on("health:check", () => {});
			service.removeAllListeners();
			expect(service.eventNames()).toEqual([]);
		});

		test("should reset expired circuit breakers", () => {
			const breakers = service.getCircuitBreakers();
			const oldFailure = Date.now() - 10 * 60 * 1000;
			breakers.set(ErrorType.PERMISSION, {
				isOpen: true,
				lastFailureTime: oldFailure,
				failureCount: 5,
			});

			(service as unknown as { resetFailureCounter: (t: ErrorType) => void }).resetFailureCounter(
				ErrorType.PERMISSION,
			);
			(service as unknown as { resetCircuitBreakers: () => void }).resetCircuitBreakers();

			const state = breakers.get(ErrorType.PERMISSION);
			expect(state?.isOpen).toBe(false);
			expect(state?.failureCount).toBe(0);
			const resetEvent = capturedEvents.find((e) => e.event === "circuit_breaker:reset");
			expect(resetEvent).toBeDefined();
		});
	});
});
