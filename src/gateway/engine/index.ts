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

export { AgentSessionManager, type AgentSessionManagerConfig } from "./agent-sessions";
export { ContainerEngine, createContainerEngine, TmuxManagerWrapper } from "./container";
export {
	type CompactionConfig,
	type CompactionResult,
	compactMessages,
	compactMessagesSync,
	needsCompaction,
} from "./context-compaction";
export {
	EmbeddedAgent,
	type EmbeddedAgentConfig,
	PROVIDER_CONFIGS,
	type PromptOptions,
	type ProviderConfig,
	resolveProviderApiKey,
} from "./embedded-agent";
export { type AgentResult, EventCollector, isTextContentBlock, type ToolCallRecord } from "./event-bridge";
export { createHostIpcEngine, type HostEngineType, type HostIpcConfig, HostIpcEngine } from "./host-ipc";
export { InProcessEngine } from "./in-process";
export {
	applyToolPolicy,
	type ChatPolicyConfig,
	// Policy exports
	ChatToolPolicy,
	createBashTool,
	createDefaultTools,
	createReadFileTool,
	createReadOnlyPolicyPipeline,
	createToolPolicyPipeline,
	createWebSearchTool,
	createWriteFileTool,
	GlobalToolPolicy,
	ToolGranularPolicy,
	type ToolPolicy,
	type ToolPolicyAction,
	type ToolPolicyConfig,
	ToolPolicyPipeline,
	type ToolPolicyResult,
} from "./tools";
export {
	BOOTSTRAP_FILES,
	type BootstrapFileName,
	discoverSkills,
	loadWorkspaceBootstrap,
	SKILL_DIRS,
	USER_SKILLS_DIR,
	WorkspaceWatcher,
} from "./workspace";

// =============================================================================
// Orchestrator
// =============================================================================

export {
	createOrchestrator,
	ExecutionOrchestrator,
	getDefaultOrchestrator,
	getExecutionOrchestrator,
	setDefaultOrchestrator,
} from "./orchestrator";

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
