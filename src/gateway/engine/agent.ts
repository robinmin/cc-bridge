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
} from "@/packages/agent";
