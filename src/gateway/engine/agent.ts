/**
 * Gateway Agent Module
 *
 * Centralized re-export of agent functionality from @/packages/agent.
 * This provides a single entry point for gateway code to access agent features.
 *
 * Usage:
 *   import { EmbeddedAgent, createDefaultTools } from "@/gateway/engine/agent";
 */

export {
	type AgentConfig,
	type AgentErrorCategory,
	type AgentResult,
	type AgentRunObservability,
	type AgentTelemetrySpan,
	type AgentTelemetryTracer,
	type AgentUsageSnapshot,
	accumulateUsage,
	applyToolPolicy,
	BashTool,
	type BashToolOptions,
	BOOTSTRAP_FILES,
	type BootstrapFileName,
	type ChatPolicyConfig,
	ChatToolPolicy,
	type CompactionConfig,
	type CompactionResult,
	categorizeAgentError,
	// Context Compaction
	compactMessages,
	compactMessagesSync,
	createBashTool,
	// Tools
	createDefaultTools,
	createObservabilitySnapshot,
	createReadFileTool,
	createReadOnlyPolicyPipeline,
	createRunId,
	createToolPolicyPipeline,
	createWebSearchTool,
	createWriteFileTool,
	discoverSkills,
	// Core
	EmbeddedAgent,
	type EmbeddedAgentObservabilityConfig,
	type EmbeddedAgentObservabilitySnapshot,
	// Events
	EventCollector,
	finishObservabilityRun,
	GlobalToolPolicy,
	isTextContentBlock,
	// Workspace
	loadWorkspaceBootstrap,
	needsCompaction,
	PROVIDER_CONFIGS,
	type PromptOptions,
	type ProviderConfig,
	ReadFileTool,
	recordSpanEvent,
	resolveProviderApiKey,
	// Utils
	resolveWorkspacePath,
	SKILL_DIRS,
	startObservabilityRun,
	type ToolCallRecord,
	ToolGranularPolicy,
	type ToolPolicy,
	type ToolPolicyAction,
	// Tool Policy
	type ToolPolicyConfig,
	ToolPolicyPipeline,
	type ToolPolicyResult,
	USER_SKILLS_DIR,
	usageFromPiUsage,
	WebSearchTool,
	WorkspaceWatcher,
	WriteFileTool,
} from "@/packages/agent";
