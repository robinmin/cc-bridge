---
name: enhance tool system
description: Task: Enhance embedded agent tool system with permission escalation, dynamic permissions, and visibility
status: Completed
created_at: 2026-03-15
updated_at: 2026-03-15
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

## 0167. enhance tool system

### Background

As described in section "11.1 Enhanced Tool System" of file `docs/06_EMBEDDED_AGENT_SPEC.md`, we need to enhance the current tool system with additional capabilities. Additionally, section "11.6 Security" specifies requirements for "Tool permission escalation" and "Dynamic tool permissions".

The current tool system (`src/packages/agent/tools/`) provides:
- Tool factory functions for creating default tools (bash, read-file, write-file, web-search)
- Policy system with allow/deny lists and read-only mode
- Basic dangerous pattern blocking for bash commands

**Current Gap**: The system lacks:
1. Permission escalation mechanism (tools can only be allowed/denied, not progressively elevated)
2. Dynamic runtime permission changes based on context
3. Tool call visibility and audit logging
4. Granular per-operation permissions beyond just tool names

### Requirements

#### Phase 1: Tool Permission Escalation

| # | Requirement | Description |
|---|------------|-------------|
| R1 | Tier-based permissions | Tools grouped into permission tiers (read, write, execute, admin) |
| R2 | Just-in-time elevation | Request elevated permissions for specific operations |
| R3 | Permission inheritance | Sessions inherit base permissions with optional escalation |
| R4 | Permission templates | Predefined permission profiles (e.g., "read-only", "developer", "admin") |
| R5 | Time-bounded access | Permissions can expire after configurable duration |

#### Phase 2: Dynamic Tool Permissions

| # | Requirement | Description |
|---|------------|-------------|
| R6 | Runtime permission evaluation | Evaluate permissions at call time, not just registration |
| R7 | Context-aware permissions | Consider session state, user identity, operation context |
| R8 | Permission chaining | Combine multiple permission sources (global → session → operation) |
| R9 | Permission revocation | Dynamically revoke previously granted permissions |
| R10 | Consent-based escalation | Require user confirmation for elevated permissions |

#### Phase 3: Tool Call Visibility

| # | Requirement | Description |
|---|------------|-------------|
| R11 | Structured audit logging | Log all tool invocations with metadata |
| R12 | Tool execution tracing | Track tool call chain for debugging |
| R13 | Visibility API | Programmatically query tool call history |
| R14 | Rate limiting per tool | Configure rate limits at tool level |
| R15 | Tool usage metrics | Track tool usage patterns for observability |

### STOA Techniques

Based on industry best practices for AI agent tool security:

1. **Tier-based Permission Model** (inspired by AWS IAM)
   - Define permission tiers: `read` < `write` < `execute` < `admin`
   - Tools declare required tier in their metadata
   - Agents request appropriate tier for operation

2. **Just-in-Time (JIT) Permission Elevation** (inspired by PAM)
   - Permissions granted for limited duration
   - Auto-expiry after operation or timeout
   - Audit trail of all elevation requests

3. **Policy-as-Code for Tools** (inspired by Open Policy Agent)
   - Declarative policy definitions
   - Policy evaluation at tool registration and call time
   - Policy versioning and rollback

4. **Observer Pattern for Visibility** (standard pattern)
   - Tool execution events emitted to subscribers
   - Centralized audit log sink
   - Real-time visibility via event streaming

### Design

#### Architecture

```
src/packages/agent/tools/
├── permission/
│   ├── tiers.ts              # NEW: Permission tier definitions
│   ├── evaluator.ts          # NEW: Runtime permission evaluation
│   ├── escalation.ts         # NEW: JIT permission escalation
│   ├── policy.ts             # EXISTING: Enhance with escalation support
│   └── audit.ts              # NEW: Audit logging
├── visibility/
│   ├── tracer.ts             # NEW: Tool call tracing
│   ├── metrics.ts            # NEW: Usage metrics
│   └── rate-limiter.ts      # NEW: Per-tool rate limiting
├── bash.ts                   # EXISTING: Enhance with tier requirements
├── read-file.ts              # EXISTING: Enhance with tier requirements
├── write-file.ts             # EXISTING: Enhance with tier requirements
├── web-search.ts             # EXISTING: Enhance with tier requirements
├── index.ts                  # MODIFY: Export new components
└── utils.ts                  # EXISTING: May need extensions
```

#### Core Types

```typescript
// src/packages/agent/tools/permission/tiers.ts

/**
 * Permission tiers define hierarchical access levels.
 * Higher tiers include all permissions from lower tiers.
 */
export enum PermissionTier {
  /** Read-only access to non-sensitive resources */
  READ = 1,
  /** Write access to workspace files */
  WRITE = 2,
  /** Execute commands with restrictions */
  EXECUTE = 3,
  /** Full administrative access */
  ADMIN = 4,
}

/**
 * Tool declares its required permission tier
 */
export interface ToolTierRequirement {
  /** Minimum tier required to use this tool */
  minTier: PermissionTier;
  /** Specific operations that need higher tier */
  operationTiers?: Record<string, PermissionTier>;
  /** Whether this tool can be used with JIT elevation */
  allowJitElevation?: boolean;
}

/**
 * Permission template for common use cases
 */
export interface PermissionTemplate {
  name: string;
  description: string;
  tier: PermissionTier;
  allowedTools: string[];
  deniedTools: string[];
  maxDurationMs?: number;
}
```

```typescript
// src/packages/agent/tools/permission/escalation.ts

/**
 * JIT permission elevation request
 */
export interface EscalationRequest {
  sessionId: string;
  toolName: string;
  operation?: string;
  reason: string;
  requestedTier: PermissionTier;
  durationMs?: number;
}

/**
 * Permission escalation manager
 */
export class PermissionEscalation {
  /** Request JIT elevation for a tool */
  requestEscalation(request: EscalationRequest): Promise<EscalationResult>;

  /** Check if current session has required tier */
  hasTier(sessionId: string, requiredTier: PermissionTier): boolean;

  /** Revoke elevated permissions for session */
  revokeEscalation(sessionId: string, toolName?: string): void;

  /** Get active escalations for session */
  getActiveEscalations(sessionId: string): EscalationResult[];
}
```

```typescript
// src/packages/agent/tools/permission/audit.ts

/**
 * Tool call audit event
 */
export interface ToolAuditEvent {
  timestamp: number;
  sessionId: string;
  toolName: string;
  operation: string;
  params: Record<string, unknown>;
  result: "success" | "failure" | "denied";
  tier: PermissionTier;
  escalated: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Audit log sink interface
 */
export interface AuditSink {
  log(event: ToolAuditEvent): void;
  query(filter: AuditFilter): ToolAuditEvent[];
}
```

```typescript
// src/packages/agent/tools/visibility/rate-limiter.ts

/**
 * Per-tool rate limit configuration
 */
export interface ToolRateLimit {
  toolName: string;
  /** Max calls per window */
  maxCalls: number;
  /** Window duration in ms */
  windowMs: number;
  /** Burst allowance */
  burst?: number;
}
```

#### Integration Points

1. **Tool Registration**: Tools declare tier requirements at creation
2. **Tool Execution**: Permission evaluator checks tier before execution
3. **Session Management**: Sessions track current tier and active escalations
4. **Audit**: All tool calls emit audit events

#### Enhanced ToolPolicy

```typescript
// Extend existing ToolPolicyConfig
export interface ToolPolicyConfig {
  // ... existing fields

  // NEW: Permission tier configuration
  permissionTemplate?: string; // Reference to predefined template
  sessionTier?: PermissionTier; // Base tier for session
  jitEnabled?: boolean; // Allow JIT elevation
  escalationTimeoutMs?: number; // Default escalation duration

  // NEW: Rate limiting
  rateLimits?: ToolRateLimit[];

  // NEW: Audit configuration
  auditEnabled?: boolean;
  auditSink?: AuditSink;
}
```

### Plan

| Step | Task | Description |
|------|------|-------------|
| 1 | Create permission tiers | Define tier enum and tool requirement types |
| 2 | Enhance tool definitions | Add tier requirements to existing tools |
| 3 | Create evaluator | Runtime permission evaluation logic |
| 4 | Create escalation | JIT permission elevation system |
| 5 | Create audit logging | Structured tool call audit events |
| 6 | Create visibility | Tracer and metrics collection |
| 7 | Create rate limiter | Per-tool rate limiting |
| 8 | Integrate with policy | Extend ToolPolicy with new config |
| 9 | Write tests | Unit tests for all new components |
| 10 | Update docs | Document new capabilities |

### Artifacts

| Type | Path | Notes |
|------|------|-------|
| New file | `src/packages/agent/tools/permission/tiers.ts` | Tier definitions |
| New file | `src/packages/agent/tools/permission/evaluator.ts` | Permission evaluation |
| New file | `src/packages/agent/tools/permission/escalation.ts` | JIT elevation |
| New file | `src/packages/agent/tools/permission/audit.ts` | Audit logging |
| New file | `src/packages/agent/tools/visibility/tracer.ts` | Call tracing |
| New file | `src/packages/agent/tools/visibility/metrics.ts` | Usage metrics |
| New file | `src/packages/agent/tools/visibility/rate-limiter.ts` | Rate limiting |
| Modify | `src/packages/agent/tools/index.ts` | Export new components |
| Modify | Individual tool files | Add tier requirements |
| Tests | `src/packages/tests/tool-permission.test.ts` | Permission tests |
| Tests | `src/packages/tests/tool-audit.test.ts` | Audit tests |

### References

- Existing tool system: `src/packages/agent/tools/`
- Current policy: `src/packages/agent/tools/policy.ts`
- EmbeddedAgent: `src/packages/agent/core/embedded-agent.ts`
- Spec section: `docs/06_EMBEDDED_AGENT_SPEC.md` sections 11.1, 11.6
- AWS IAM tier model: Industry standard for hierarchical permissions
- Open Policy Agent (OPA): Policy-as-code pattern
- Just-in-Time Access (JIT): Cloud provider privilege management pattern
