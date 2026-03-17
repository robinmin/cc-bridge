# Tool Sandboxing Comparative Analysis

## Overview

This document compares the tool sandboxing implementations in **OpenClaw** and **Pi-mono (MOM)** vendors, analyzing their approaches, strengths, and trade-offs.

---

## Implementation Summary

| Aspect | OpenClaw | Pi-mono (MOM) |
|--------|----------|----------------|
| **Architecture** | Multi-mode Docker + Browser sandbox | Simple host vs Docker toggle |
| **Complexity** | High (extensive config) | Low (minimal config) |
| **Security Model** | Explicit allowlists + security blocks | Volume mount isolation |
| **Per-Agent Config** | Yes | No |
| **Browser Isolation** | Dedicated browser sandbox | Not implemented |

---

## OpenClaw Implementation

### Key Features

**1. Docker Sandbox Configuration** (`types.sandbox.ts`)
```typescript
export type SandboxDockerSettings = {
  image?: string;           // Docker image
  container?: string;       // Container name
  network?: SandboxNetworkMode;  // "bridge" | "none" | custom
  security?: SandboxSecurity;
  limits?: SandboxLimits;
  mounts?: SandboxMount[];
  // ... more options
}
```

**2. Security-First Design**
- Explicitly blocks dangerous configurations:
  - `network: "host"` blocked
  - `seccomp: "unconfined"` blocked
  - `apparmor: "unconfined"` blocked
- Requires absolute paths for bind mounts
- Validation at config resolution time

**3. Per-Agent Sandbox Configuration**
```typescript
// Each agent can have its own sandbox
sandbox?: {
  docker?: SandboxDockerSettings;
  browser?: SandboxBrowserSettings;
  prune?: SandboxPruneSettings;
}
```

**4. Browser Sandbox**
- Separate Chrome/Chromium sandbox configuration
- CDP (Chrome DevTools Protocol) port management
- Network isolation for browser

### Pros

1. **Comprehensive Security** - Explicit blocks prevent dangerous configs
2. **Granular Control** - Per-agent, per-tool sandbox policies
3. **Resource Limits** - Memory, CPU, disk limits per sandbox
4. **Browser Isolation** - Dedicated Chrome sandbox with network controls
5. **Schema Validation** - Zod schemas enforce correct configuration
6. **Production-Ready** - Designed for multi-tenant environments

### Cons

1. **High Complexity** - Requires understanding of Docker, security profiles
2. **Configuration Overhead** - Many options to configure correctly
3. **Learning Curve** - Developers need to understand security concepts
4. **Less Flexible** - Security blocks may limit valid use cases

---

## Pi-mono (MOM) Implementation

### Key Features

**1. Simple Two-Mode Approach** (`sandbox.ts`)
```typescript
export type SandboxConfig = { type: "host" } | { type: "docker"; container: string };
```

**2. Container Pre-Creation**
- User creates container manually: `./docker.sh create ./data`
- Container must exist and be running before mom starts
- Uses `docker exec` to run commands in container

**3. Workspace Isolation**
- Only `/workspace` directory mounted from host
- Container has its own "personal computer" model
- Mom can install tools inside container

**4. CLI Integration**
```bash
mom --sandbox=host ./data           # No isolation
mom --sandbox=docker:mom-sandbox ./data  # Docker isolation
```

### Pros

1. **Simple to Understand** - Just "host" vs "docker" toggle
2. **Easy Setup** - Minimal configuration required
3. **Clear Security Model** - Only /workspace is accessible
4. **Container Persistence** - Tools/credentials persist across runs
5. **Good UX Documentation** - Explains why sandboxing matters

### Cons

1. **No Per-Tool Granularity** - All or nothing
2. **No Resource Limits** - No CPU/memory constraints
3. **No Browser Sandbox** - Browser tools run in same container
4. **Manual Container Management** - User must manage container lifecycle
5. **Security Depends on User** - No validation of dangerous configs
6. **No Network Isolation** - Full network access in container

---

## Comparison Matrix

| Feature | OpenClaw | Pi-mono |
|---------|----------|---------|
| **Isolation Level** | Container + optional browser | Container only |
| **Resource Limits** | CPU, Memory, Disk | None |
| **Network Control** | Configurable bridge/none | Full access |
| **Security Validation** | Schema + runtime blocks | None |
| **Per-Agent Config** | Yes | No |
| **Per-Tool Config** | Via tool policy | No |
| **Browser Sandbox** | Yes (Chrome) | No |
| **Setup Complexity** | High | Low |
| **Operational Complexity** | Medium | Low |

---

## Recommendation for CC-Bridge

### Approach: Hybrid (OpenClaw-style for built-ins, Pi-mono for external)

Given the requirement that **built-in/allowed external tools** don't need sandboxing but **other tools** do, a hybrid approach works best:

#### Phase 1: Core Infrastructure (OpenClaw-inspired)
1. Define `SandboxConfig` types with Docker configuration
2. Add security validation (block dangerous configs)
3. Implement per-tool sandbox policy
4. Add resource limits support

#### Phase 2: Default Behavior (Pi-mono-inspired)
1. Default: No sandbox for built-in tools (bash, read-file, write-file, web-search)
2. Enable sandbox for unknown/external tools
3. Simple CLI flag: `--sandbox=strict` vs `--sandbox=permissive`

#### Phase 3: Advanced Features
1. Browser sandbox (OpenClaw-style)
2. Network isolation options
3. Resource quota enforcement

### Example Configuration

```typescript
// cc-bridge tool sandbox config
interface ToolSandboxConfig {
  // Default: no sandbox for built-in tools
  defaultMode: "host" | "docker";

  // Docker configuration for sandboxed tools
  docker?: {
    image: string;
    network: "bridge" | "none";
    memoryLimit?: string;
    cpuLimit?: number;
    mounts?: { source: string; target: string }[];
  };

  // Per-tool policy
  toolPolicy?: {
    [toolName: string]: {
      sandbox: boolean;
      timeout?: number;
      maxMemory?: string;
    };
  };
}
```

---

## Conclusion

| Vendor | Best For | Trade-off |
|--------|----------|-----------|
| **OpenClaw** | Enterprise/Production | Security over simplicity |
| **Pi-mono** | Developer/Personal | Simplicity over control |

For **cc-bridge**, I recommend adopting OpenClaw's security-first approach with Pi-mono's simplicity for the default case. This gives:
- Security validation for production use
- Simple default behavior for developers
- Gradual complexity for advanced users
