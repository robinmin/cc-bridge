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

// Consolidated agent module - re-exports all agent functionality
export {
	type AgentResult,
	applyToolPolicy,
	BashTool,
	type BashToolOptions,
	BOOTSTRAP_FILES,
	type BootstrapFileName,
	type ChatPolicyConfig,
	ChatToolPolicy,
	type CompactionConfig,
	type CompactionResult,
	// Context Compaction
	compactMessages,
	compactMessagesSync,
	createBashTool,
	// Tools
	createDefaultTools,
	createReadFileTool,
	createReadOnlyPolicyPipeline,
	createToolPolicyPipeline,
	createWebSearchTool,
	createWriteFileTool,
	discoverSkills,
	// Core
	EmbeddedAgent,
	type EmbeddedAgentConfig,
	// Events
	EventCollector,
	GlobalToolPolicy,
	isTextContentBlock,
	// Workspace
	loadWorkspaceBootstrap,
	needsCompaction,
	PROVIDER_CONFIGS,
	type PromptOptions,
	type ProviderConfig,
	ReadFileTool,
	resolveProviderApiKey,
	// Utils
	resolveWorkspacePath,
	SKILL_DIRS,
	type ToolCallRecord,
	ToolGranularPolicy,
	type ToolPolicy,
	type ToolPolicyAction,
	// Tool Policy
	type ToolPolicyConfig,
	ToolPolicyPipeline,
	type ToolPolicyResult,
	USER_SKILLS_DIR,
	WebSearchTool,
	WorkspaceWatcher,
	WriteFileTool,
} from "./agent";
export { AgentSessionManager, type AgentSessionManagerConfig } from "./agent-sessions";
export { ContainerEngine, createContainerEngine, TmuxManagerWrapper } from "./container";

export { createHostIpcEngine, type HostEngineType, type HostIpcConfig, HostIpcEngine } from "./host-ipc";
export { InProcessEngine } from "./in-process";

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
