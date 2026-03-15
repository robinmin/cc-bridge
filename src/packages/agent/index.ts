/**
 * @mariozechner/agent - Reusable AI Agent Package
 *
 * A standalone, reusable agent package built on top of pi-agent-core.
 * Provides:
 * - EmbeddedAgent: High-level agent wrapper with workspace, tools, and events
 * - EventCollector: Event aggregation and result collection
 * - Workspace: Bootstrap file loading and hot reload
 * - ContextCompaction: LLM-powered context management
 * - Tools: Built-in tools (bash, read_file, write_file, web_search)
 * - ToolPolicy: Policy-based tool filtering
 */

// =============================================================================
// Core
// =============================================================================

export {
	type CompactionConfig,
	type CompactionResult,
	compactMessages,
	compactMessagesSync,
	needsCompaction,
} from "./core/context-compaction";
export {
	EmbeddedAgent,
	type EmbeddedAgentConfig,
	PROVIDER_CONFIGS,
	type PromptOptions,
	type ProviderConfig,
	resolveProviderApiKey,
} from "./core/embedded-agent";
export { type AgentResult, EventCollector, isTextContentBlock, type ToolCallRecord } from "./core/event-bridge";
export {
	type AgentErrorCategory,
	type AgentRunObservability,
	type AgentTelemetrySpan,
	type AgentTelemetryTracer,
	type AgentUsageSnapshot,
	accumulateUsage,
	categorizeAgentError,
	cloneUsageSnapshot,
	createObservabilitySnapshot,
	createRunId,
	type EmbeddedAgentObservabilityConfig,
	type EmbeddedAgentObservabilitySnapshot,
	finishObservabilityRun,
	type ObservabilityRunContext,
	recordSpanEvent,
	startObservabilityRun,
	usageFromPiUsage,
} from "./core/observability";
export {
	type AgentOtelConfig,
	type AgentOtelService,
	createAgentOtelService,
	createOtelConfigFromEnv,
} from "./core/otel";
export {
	BOOTSTRAP_FILES,
	type BootstrapFileName,
	discoverSkills,
	loadWorkspaceBootstrap,
	SKILL_DIRS,
	USER_SKILLS_DIR,
	WorkspaceWatcher,
} from "./core/workspace";

// =============================================================================
// Tools
// =============================================================================

export {
	BashTool,
	type BashToolOptions,
	createBashTool,
	createDefaultTools,
	createReadFileTool,
	createWebSearchTool,
	createWriteFileTool,
	ReadFileTool,
	WebSearchTool,
	WriteFileTool,
} from "./tools";

export {
	applyToolPolicy,
	type ChatPolicyConfig,
	ChatToolPolicy,
	createReadOnlyPolicyPipeline,
	createToolPolicyPipeline,
	GlobalToolPolicy,
	ToolGranularPolicy,
	type ToolPolicy,
	type ToolPolicyAction,
	type ToolPolicyConfig,
	ToolPolicyPipeline,
	type ToolPolicyResult,
} from "./tools/policy";

export { resolveWorkspacePath } from "./tools/utils";
