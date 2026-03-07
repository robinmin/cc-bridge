/**
 * Unified Execution Engine
 *
 * A unified 3-layer execution engine for LLM query execution:
 * - In-Process: Worker-thread based (feature-flagged, disabled by default)
 * - Host IPC: CLI subprocess on host OS
 * - Container: Docker exec / tmux
 *
 * This package replaces:
 * - claude-executor.ts (container execution)
 * - execution-engine.ts (mini-app execution)
 * - IPC package (communication layer)
 *
 * Usage:
 * ```typescript
 * import { createOrchestrator } from "@/gateway/engine";
 *
 * const orchestrator = createOrchestrator();
 * const result = await orchestrator.execute({
 *   prompt: "Hello, world!",
 *   options: { workspace: "my-project" }
 * });
 * ```
 */

// =============================================================================
// Contracts & Types
// =============================================================================

export type {
	ClaudeAsyncExecutionResult,
	ClaudeExecutionConfigExtended,
	ClaudeExecutionResultOrAsync,
	ExecutionContext,
	ExecutionLayer,
	ExecutionOptions,
	ExecutionRequest,
	ExecutionResult,
	ExecutionStatus,
	LayerHealth,
	OrchestratorConfig,
} from "./contracts";

export {
	AllLayersFailedError,
	DEFAULT_ORCHESTRATOR_CONFIG,
	ExecutionEngineError,
	NoLayerAvailableError,
} from "./contracts";

// =============================================================================
// Engines
// =============================================================================

export { ContainerEngine, createContainerEngine, TmuxManagerWrapper } from "./container";
export { createHostIpcEngine, type HostEngineType, type HostIpcConfig, HostIpcEngine } from "./host-ipc";
export { InProcessEngine } from "./in-process";

// =============================================================================
// Orchestrator
// =============================================================================

import { createOrchestrator as _createOrchestrator, type ExecutionOrchestrator } from "./orchestrator";

export {
	createOrchestrator,
	ExecutionOrchestrator,
	getDefaultOrchestrator,
	setDefaultOrchestrator,
} from "./orchestrator";

// Lazy-loaded default orchestrator instance - use getExecutionOrchestrator() to access
let _orchestrator: ExecutionOrchestrator | null = null;

export function getExecutionOrchestrator(): ExecutionOrchestrator {
	if (!_orchestrator) {
		_orchestrator = _createOrchestrator();
	}
	return _orchestrator;
}

// =============================================================================
// Utilities
// =============================================================================

export {
	buildClaudePrompt,
	buildPlainContextPrompt,
	escapeXml,
	interpolateArg,
	isAsyncResult,
	type PromptValidationResult,
	validateAndSanitizePrompt,
} from "./prompt-utils";

// =============================================================================
// Re-export for convenience
// =============================================================================

// Re-export common types for external consumers
export type { AgentInstance } from "@/gateway/instance-manager";
