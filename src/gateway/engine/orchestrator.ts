/**
 * Execution Orchestrator
 *
 * Coordinates layer selection, fallback, and health monitoring
 * for the unified 3-layer execution engine.
 */

import crypto from "node:crypto";
import { logger } from "@/packages/logger";
import { createContainerEngine } from "./container";
import type {
	ExecutionLayer,
	ExecutionRequest,
	ExecutionResult,
	IExecutionEngine,
	LayerHealth,
	OrchestratorConfig,
} from "./contracts";
import { AllLayersFailedError, DEFAULT_ORCHESTRATOR_CONFIG, NoLayerAvailableError } from "./contracts";
import { createHostIpcEngine } from "./host-ipc";
import { InProcessEngine } from "./in-process";

/**
 * Execution orchestrator
 * Manages layer selection, fallback, and execution
 */
export class ExecutionOrchestrator {
	private readonly config: OrchestratorConfig;
	private readonly engines: Map<ExecutionLayer, IExecutionEngine>;
	private readonly healthCache: Map<ExecutionLayer, LayerHealth>;
	private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: Partial<OrchestratorConfig> = {}) {
		this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
		this.engines = new Map();
		this.healthCache = new Map();

		// Initialize engines based on config
		this.initializeEngines();
	}

	/**
	 * Initialize available engines
	 */
	private initializeEngines(): void {
		// In-process engine (feature-flagged)
		if (this.config.enableInProcess) {
			this.engines.set("in-process", new InProcessEngine(this.config.enableInProcess));
		}

		// Host IPC engine
		if (this.config.enableHostIpc) {
			this.engines.set("host-ipc", createHostIpcEngine("claude_host"));
		}

		// Container engine
		if (this.config.enableContainer) {
			this.engines.set("container", createContainerEngine());
		}

		// Start health monitoring
		this.startHealthMonitoring();
	}

	/**
	 * Execute a prompt with automatic layer selection and fallback
	 */
	async execute(request: ExecutionRequest): Promise<ExecutionResult> {
		const requestId = request.options?.chatId
			? `${request.options.chatId}-${crypto.randomUUID().slice(0, 8)}`
			: crypto.randomUUID();

		const _startTime = new Date();
		const errors: Map<ExecutionLayer, ExecutionResult> = new Map();

		logger.info(
			{ requestId, layerOrder: this.config.layerOrder, promptLength: request.prompt.length },
			"Starting orchestrated execution",
		);

		// Try each layer in order
		for (const layer of this.config.layerOrder) {
			const engine = this.engines.get(layer);

			if (!engine) {
				logger.debug({ requestId, layer }, "Engine not initialized, skipping");
				continue;
			}

			// Check availability
			const available = await engine.isAvailable();
			if (!available) {
				logger.debug({ requestId, layer }, "Layer not available, skipping");
				continue;
			}

			logger.info({ requestId, layer }, "Attempting execution on layer");
			const layerStartTime = Date.now();

			try {
				const result = await engine.execute(request);
				const durationMs = Date.now() - layerStartTime;

				if (result.status === "completed") {
					logger.info({ requestId, layer, durationMs, exitCode: result.exitCode }, "Execution succeeded on layer");
					return {
						...result,
						requestId,
					};
				}

				// Record failure
				logger.warn(
					{ requestId, layer, status: result.status, error: result.error, durationMs },
					"Execution failed on layer",
				);
				errors.set(layer, result);

				// If not retryable, don't retry this layer
				if (!result.retryable) {
					continue;
				}

				// Retry the same layer
				for (let retry = 0; retry < this.config.maxRetries; retry++) {
					logger.info({ requestId, layer, retry: retry + 1 }, "Retrying layer");
					const retryResult = await engine.execute(request);

					if (retryResult.status === "completed") {
						logger.info({ requestId, layer, retry: retry + 1 }, "Retry succeeded");
						return {
							...retryResult,
							requestId,
						};
					}

					errors.set(layer, retryResult);
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				logger.error({ requestId, layer, error: errorMsg }, "Layer threw exception");
				errors.set(layer, {
					status: "failed",
					error: errorMsg,
					retryable: false,
				});
			}
		}

		// All layers failed
		logger.error({ requestId, layersAttempted: Array.from(errors.keys()) }, "All layers failed");

		if (errors.size === 0) {
			throw new NoLayerAvailableError(this.config.layerOrder);
		}

		throw new AllLayersFailedError(errors);
	}

	/**
	 * Get health status for all layers
	 */
	async getHealthStatus(): Promise<LayerHealth[]> {
		const results: LayerHealth[] = [];

		for (const [layer, engine] of this.engines) {
			const health = await engine.getHealth();
			this.healthCache.set(layer, health);
			results.push(health);
		}

		return results;
	}

	/**
	 * Get the best available layer (for direct execution without fallback)
	 */
	async getBestLayer(): Promise<ExecutionLayer | null> {
		for (const layer of this.config.layerOrder) {
			const engine = this.engines.get(layer);
			if (engine && (await engine.isAvailable())) {
				return layer;
			}
		}
		return null;
	}

	/**
	 * Execute on a specific layer (bypass fallback)
	 */
	async executeOnLayer(request: ExecutionRequest, layer: ExecutionLayer): Promise<ExecutionResult> {
		const engine = this.engines.get(layer);

		if (!engine) {
			return {
				status: "failed",
				error: `Layer ${layer} not available`,
				retryable: false,
			};
		}

		const available = await engine.isAvailable();
		if (!available) {
			return {
				status: "failed",
				error: `Layer ${layer} is not available`,
				retryable: false,
			};
		}

		return engine.execute(request);
	}

	/**
	 * Stop health monitoring
	 */
	stop(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}
	}

	/**
	 * Start periodic health monitoring
	 */
	private startHealthMonitoring(): void {
		if (this.healthCheckTimer) {
			return;
		}

		this.healthCheckTimer = setInterval(async () => {
			try {
				await this.getHealthStatus();
			} catch (error) {
				logger.error({ error }, "Health check failed");
			}
		}, this.config.healthCheckIntervalMs);
	}

	/**
	 * Get cached health status
	 */
	getCachedHealth(layer: ExecutionLayer): LayerHealth | undefined {
		return this.healthCache.get(layer);
	}

	/**
	 * Get all initialized layers
	 */
	getLayers(): ExecutionLayer[] {
		return Array.from(this.engines.keys());
	}
}

/**
 * Factory function to create orchestrator
 */
export function createOrchestrator(config?: Partial<OrchestratorConfig>): ExecutionOrchestrator {
	return new ExecutionOrchestrator(config);
}

// Lazy-loaded default orchestrator instance
let _defaultOrchestrator: ExecutionOrchestrator | null = null;

export function getExecutionOrchestrator(): ExecutionOrchestrator {
	if (!_defaultOrchestrator) {
		_defaultOrchestrator = createOrchestrator();
	}
	return _defaultOrchestrator;
}

/**
 * Default orchestrator instance (singleton)
 */
let defaultOrchestrator: ExecutionOrchestrator | null = null;

export function getDefaultOrchestrator(): ExecutionOrchestrator {
	if (!defaultOrchestrator) {
		defaultOrchestrator = createOrchestrator();
	}
	return defaultOrchestrator;
}

export function setDefaultOrchestrator(orchestrator: ExecutionOrchestrator): void {
	defaultOrchestrator = orchestrator;
}
