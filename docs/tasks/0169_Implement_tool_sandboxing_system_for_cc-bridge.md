---
name: Implement tool sandboxing system for cc-bridge
description: Task: Implement tool sandboxing system for cc-bridge
status: Done
created_at: 2026-03-16 14:45:57
updated_at: 2026-03-17
impl_progress:
  planning: done
  design: done
  implementation: done
  review: done
  testing: done
---

## 0169. Implement tool sandboxing system for cc-bridge

### Background

Based on analysis in docs/tool-sandboxing-analysis.md, implement hybrid sandbox system combining OpenClaw security with Pi-mono simplicity

### Requirements

1. Define SandboxConfig types with Docker config 2. Add security validation (block dangerous configs) 3. Implement per-tool sandbox policy 4. Support resource limits 5. Default: no sandbox for built-in tools, enable for external 6. CLI flag: --sandbox=strict vs --sandbox=permissive

### Q&A

[Clarifications added during planning phase]

### Design


### Design

## Architecture

```
src/packages/agent/tools/
├── sandbox/
│   ├── config.ts           # SandboxConfig types (Docker settings, limits)
│   ├── validator.ts        # Security validation (block dangerous configs)
│   ├── executor.ts        # Docker/host execution
│   ├── policy.ts          # Per-tool policy (which tools need sandbox)
│   └── limits.ts          # Resource limits (memory, CPU)
└── index.ts               # Export new components
```

## Key Components

1. **SandboxConfig**: Type definitions for Docker sandbox settings
2. **SecurityValidator**: Validates and blocks dangerous configurations
3. **SandboxExecutor**: Runs commands in host or Docker container
4. **ToolSandboxPolicy**: Determines which tools require sandboxing
5. **ResourceLimits**: Memory, CPU, PID limits for containers

## Security Model

- Block: host network mode
- Block: unconfined seccomp profile
- Block: unconfined AppArmor profile
- Require absolute paths for bind mounts
- Default: no sandbox for built-in tools

## CLI Integration

- `--sandbox=host` - No isolation (default for built-in tools)
- `--sandbox=docker:<container>` - Docker isolation
- `--sandbox=strict` - All external tools sandboxed
- `--sandbox=permissive` - Only dangerous tools sandboxed

### Plan



## Task Decomposition

Parent epic decomposed into 9 subtasks across 3 phases.

### Phase 1: Core Infrastructure (OpenClaw-inspired) -- PRIMARY DELIVERABLE

| WBS | Task | Est. Hours | Dependencies | Priority |
|-----|------|------------|-------------|----------|
| 0170 | Define SandboxConfig types and Docker configuration interface | 3h | None | High |
| 0171 | Implement security validation for sandbox configurations | 4h | 0170 | High |
| 0172 | Implement per-tool sandbox policy engine | 4h | 0170 | High |
| 0173 | Implement resource limits support for sandboxed tools | 3h | 0170 | High |
| 0174 | Implement sandbox executor for host and Docker modes | 6h | 0171, 0172, 0173 | High |
| 0175 | Integrate sandbox module with tool system and add CLI flags | 5h | 0174 | High |

### Phase 3: Advanced Features

| WBS | Task | Est. Hours | Dependencies | Priority |
|-----|------|------------|-------------|----------|
| 0176 | Add browser sandbox support (OpenClaw-style) | 5h | 0175 | Medium |
| 0177 | Implement network isolation options | 4h | 0175 | Medium |
| 0178 | Implement resource quota enforcement and monitoring | 5h | 0175 | Low |

### Dependency Graph

```
0170 (SandboxConfig types)
 ├── 0171 (Security validation)
 ├── 0172 (Per-tool policy)
 └── 0173 (Resource limits)
       ↓ (all three)
     0174 (Sandbox executor)
       ↓
     0175 (Integration + CLI flags)
      ├── 0176 (Browser sandbox)
      ├── 0177 (Network isolation)
      └── 0178 (Resource quotas)
```

**Critical Path:** 0170 -> 0171/0172/0173 -> 0174 -> 0175 (25h)
**Parallel Opportunities:** 0171 || 0172 || 0173 (after 0170); 0176 || 0177 || 0178 (after 0175)
**Total Estimated Effort:** 39h (Phase 1: 25h, Phase 3: 14h)

### Notes

- Phase 2 (Default Behavior) is folded into tasks 0172 (per-tool policy defaults) and 0175 (CLI flags)
- Existing code in src/packages/agent/tools/sandbox/ provides initial implementations that need review, testing, and integration
- All Phase 1 tasks are high priority; Phase 3 tasks are medium/low priority follow-ups

### Solution

## Approach

Implement a hybrid sandboxing system combining OpenClaw-style security with Pi-mono simplicity:

1. **Core Infrastructure** (OpenClaw-inspired):
   - Define SandboxConfig types with Docker configuration
   - Add security validation (block dangerous configs)
   - Implement per-tool sandbox policy
   - Add resource limits support

2. **Default Behavior** (Pi-mono-inspired):
   - Default: No sandbox for built-in tools (bash, read-file, write-file, web-search)
   - Enable sandbox for external/unknown tools
   - CLI flag: --sandbox=strict vs --sandbox=permissive

## Key Technical Decisions

1. **Hybrid Config Model**: Use OpenClaw's comprehensive types with Pi-mono's simple CLI
2. **Tool Classification**: Built-in tools exempt from sandbox; external tools require sandbox
3. **Security First**: Block dangerous Docker configs (host network, unconfined seccomp)
4. **Per-Tool Policy**: Each tool can have custom sandbox requirements

## Files to Create/Modify

- `src/packages/agent/tools/sandbox/config.ts` - SandboxConfig types (NEW)
- `src/packages/agent/tools/sandbox/validator.ts` - Security validation (NEW)
- `src/packages/agent/tools/sandbox/executor.ts` - Docker/host execution (NEW)
- `src/packages/agent/tools/sandbox/policy.ts` - Per-tool sandbox policy (NEW)
- `src/packages/agent/tools/sandbox/limits.ts` - Resource limits (NEW)
- `src/packages/agent/tools/index.ts` - Export new components (MODIFY)

## Acceptance Criteria

1. SandboxConfig types defined and validated
2. Security validator blocks dangerous configs (host network, unconfined seccomp)
3. Per-tool policy correctly identifies which tools need sandboxing
4. Built-in tools (bash, read-file, write-file, web-search) exempted by default
5. CLI flag --sandbox=strict vs --sandbox=permissive works correctly
6. Resource limits (memory, CPU) configurable
7. Executor supports both host and Docker modes

### Artifacts

| Type | Path | Generated By | Date |
|------|------|--------------|------|

### References

[Links to docs, related tasks, external resources]
