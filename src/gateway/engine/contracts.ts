/**
 * Unified Execution Engine - Core Contracts
 *
 * Defines the interfaces and types for the 3-layer execution engine:
 * - In-process (worker thread)
 * - Host IPC (CLI subprocess)
 * - Container (Docker exec / tmux)
 */

import type { AgentInstance } from "@/gateway/instance-manager";

// =============================================================================
// Execution Layer Types
// =============================================================================

/** Available execution layers */
export type ExecutionLayer = "in-process" | "host-ipc" | "container";

/** Execution status */
export type ExecutionStatus = "pending" | "running" | "completed" | "failed" | "timeout";

// =============================================================================
// Execution Request/Result Types
// =============================================================================

/** Configuration for execution */
export interface ExecutionOptions {
	/** Command to execute (default: "claude") */
	command?: string;
	/** Additional command arguments */
	args?: string[];
	/** Request timeout in milliseconds */
	timeout?: number;
	/** Skip permission checks */
	allowDangerouslySkipPermissions?: boolean;
	/** Restrict to specific tools */
	allowedTools?: string;
	/** Current workspace name */
	workspace?: string;
	/** Chat ID for session identification */
	chatId?: string | number;
	/** Use tmux async mode */
	useTmux?: boolean;
	/** Conversation history */
	history?: Array<{ sender: string; text: string; timestamp: string }>;
	/** Wait for completion and return output (synchronous mode) */
	sync?: boolean;
	/** Kill tmux session after execution completes (for one-off runs) */
	ephemeralSession?: boolean;
}

/** Request for execution */
export interface ExecutionRequest {
	/** The prompt to execute */
	prompt: string;
	/** Execution options */
	options?: ExecutionOptions;
	/** Optional: container ID for container layer */
	containerId?: string;
	/** Optional: agent instance */
	instance?: AgentInstance;
}

/** Result of execution */
export interface ExecutionResult {
	/** Execution status */
	status: ExecutionStatus;
	/** Output content */
	output?: string;
	/** Error message if failed */
	error?: string;
	/** Exit code */
	exitCode?: number;
	/** Whether the error is retryable */
	retryable?: boolean;
	/** Whether this is a timeout */
	isTimeout?: boolean;
	/** Request ID for async operations */
	requestId?: string;
	/** Execution mode (sync or tmux async) */
	mode?: "sync" | "tmux";
}

/** Health status for a layer */
export interface LayerHealth {
	layer: ExecutionLayer;
	available: boolean;
	lastCheck: Date;
	error?: string;
}

// =============================================================================
// Engine Interface
// =============================================================================

/**
 * Base interface for all execution engines
 */
export interface IExecutionEngine {
	/** Get the layer type */
	getLayer(): ExecutionLayer;

	/** Check if this engine is available */
	isAvailable(): Promise<boolean>;

	/** Execute a prompt */
	execute(request: ExecutionRequest): Promise<ExecutionResult>;

	/** Get health status */
	getHealth(): Promise<LayerHealth>;
}

// =============================================================================
// Orchestrator Types
// =============================================================================

/** Configuration for the orchestrator */
export interface OrchestratorConfig {
	/** Preferred layer order (tried in order until one succeeds) */
	layerOrder: ExecutionLayer[];
	/** Enable in-process layer */
	enableInProcess: boolean;
	/** Enable host-ipc layer */
	enableHostIpc: boolean;
	/** Enable container layer */
	enableContainer: boolean;
	/** Default timeout in ms */
	defaultTimeoutMs: number;
	/** Max retries per layer */
	maxRetries: number;
	/** Health check interval in ms */
	healthCheckIntervalMs: number;
}

/** Default orchestrator configuration */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
	layerOrder: ["in-process", "host-ipc", "container"],
	enableInProcess: false, // Feature-flagged off by default
	enableHostIpc: true,
	enableContainer: true,
	defaultTimeoutMs: 120000,
	maxRetries: 1,
	healthCheckIntervalMs: 30000,
};

/** Execution context passed to engines */
export interface ExecutionContext {
	/** Request ID */
	requestId: string;
	/** Start timestamp */
	startTime: Date;
	/** Layer being tried */
	currentLayer: ExecutionLayer;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Base error for execution engine errors
 */
export class ExecutionEngineError extends Error {
	constructor(
		message: string,
		public readonly layer: ExecutionLayer,
		public readonly retryable: boolean = false,
		public readonly cause?: Error,
	) {
		super(message);
		this.name = "ExecutionEngineError";
	}
}

/**
 * Error when no layer is available
 */
export class NoLayerAvailableError extends ExecutionEngineError {
	constructor(layers: ExecutionLayer[]) {
		super(`No execution layer available. Tried: ${layers.join(", ")}`, "in-process", false);
		this.name = "NoLayerAvailableError";
	}
}

/**
 * Error when all layers fail
 */
export class AllLayersFailedError extends ExecutionEngineError {
	constructor(public readonly errors: Map<ExecutionLayer, ExecutionResult>) {
		super("All execution layers failed", "in-process", false);
		this.name = "AllLayersFailedError";
	}
}

// =============================================================================
// Backward Compatibility Types (for consumers migrating from claude-executor)
// =============================================================================

/** @deprecated Use ExecutionResult instead */
export type ClaudeExecutionResultOrAsync = ExecutionResult;

/** @deprecated Use ExecutionResult instead */
export type ClaudeAsyncExecutionResult = ExecutionResult & { mode: "tmux"; requestId: string };

/** Configuration for Claude execution (legacy type) */
export interface ClaudeExecutionConfigExtended {
	allowDangerouslySkipPermissions?: boolean;
	allowedTools?: string;
	timeout?: number;
	workspace?: string;
	chatId?: string | number;
	history?: Array<{ sender: string; text: string; timestamp: string }>;
}
