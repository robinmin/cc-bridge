---
wbs: "0110"
title: "Phase 1.1: Docker + tmux Infrastructure Setup"
status: "pending"
priority: "critical"
complexity: "medium"
estimated_hours: 4
phase: "phase-1-core-persistent-sessions"
dependencies: []
created: 2026-02-07
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

# Phase 1.1: Docker + tmux Infrastructure Setup

## Description

Set up Docker containers with tmux support and configure the base infrastructure for persistent Claude sessions. This task establishes the foundation for running tmux inside Docker containers.

## Requirements

### Functional Requirements

1. **Docker Image with tmux**
   - Install tmux in Docker image
   - Configure tmux for non-interactive startup
   - Verify tmux server can start automatically

2. **Shared Volume Structure**
   - Create `/ipc/{workspace}/` directory structure
   - Set up proper permissions for file-based IPC
   - Configure volumes in docker-compose.yml

3. **Environment Variables**
   - Add `GATEWAY_CALLBACK_URL` for Stop Hook
   - Add workspace identification variables
   - Configure tmux session naming

### Non-Functional Requirements

- tmux must start reliably on container startup
- File permissions must allow read/write from both Gateway and Agent
- Container must survive tmux session crashes

## Design

### Docker Configuration Changes

**File**: `src/dockers/Dockerfile.agent`
```dockerfile
# Add tmux installation
RUN apt-get update && apt-get install -y tmux && rm -rf /var/lib/apt/lists/*

# Create IPC directories
RUN mkdir -p /ipc/responses /ipc/requests
```

**File**: `src/dockers/docker-compose.yml`
```yaml
services:
  claude-agent:
    # ... existing config ...
    volumes:
      # Add IPC shared volume
      - ../../data/ipc/${WORKSPACE_NAME:-cc-bridge}:/ipc/${WORKSPACE_NAME:-cc-bridge}:rw
    environment:
      # Add callback URL
      - GATEWAY_CALLBACK_URL=http://host.docker.internal:8080/claude-callback
      - WORKSPACE_NAME=${WORKSPACE_NAME:-cc-bridge}
    # Start tmux server on container startup
    command: >
      sh -c "
        tmux start-server &&
        bun run src/agent/index.ts
      "
```

### Directory Structure

```
data/ipc/
  └── {workspace}/          # e.g., cc-bridge, another-project
      ├── responses/        # Agent writes Claude outputs here
      │   └── {requestId}.json
      └── requests/         # Reserved for future use
          └── {requestId}.json
```

## Acceptance Criteria

- [ ] Docker image builds successfully with tmux installed
- [ ] tmux server starts automatically when container launches
- [ ] `docker exec {container} tmux ls` shows tmux server running
- [ ] IPC directories exist and are writable from both host and container
- [ ] Environment variable `GATEWAY_CALLBACK_URL` is accessible inside container
- [ ] Container restarts successfully after `docker restart`
- [ ] No permission errors when writing to `/ipc/` directories

## File Changes

### New Files
- None

### Modified Files
1. `src/dockers/Dockerfile.agent` - Add tmux installation
2. `src/dockers/docker-compose.yml` - Add volumes, env vars, startup command

### Deleted Files
- None

## Test Scenarios

### Test 1: tmux Installation
```bash
# Build and start container
docker-compose -f src/dockers/docker-compose.yml up -d

# Verify tmux is installed
docker exec claude-cc-bridge tmux -V
# Expected: tmux 3.x

# Verify tmux server is running
docker exec claude-cc-bridge tmux ls
# Expected: No error (may show "no sessions")
```

### Test 2: IPC Directory Permissions
```bash
# Test write from container
docker exec claude-cc-bridge sh -c "echo 'test' > /ipc/cc-bridge/responses/test.json"

# Test read from host
cat data/ipc/cc-bridge/responses/test.json
# Expected: "test"

# Test write from host
echo '{"status":"ok"}' > data/ipc/cc-bridge/responses/host-test.json

# Test read from container
docker exec claude-cc-bridge cat /ipc/cc-bridge/responses/host-test.json
# Expected: {"status":"ok"}
```

### Test 3: Environment Variables
```bash
# Verify callback URL is set
docker exec claude-cc-bridge printenv GATEWAY_CALLBACK_URL
# Expected: http://host.docker.internal:8080/claude-callback

# Verify workspace name
docker exec claude-cc-bridge printenv WORKSPACE_NAME
# Expected: cc-bridge
```

### Test 4: Container Restart Stability
```bash
# Restart container
docker restart claude-cc-bridge

# Wait for startup
sleep 5

# Verify tmux is still running
docker exec claude-cc-bridge tmux ls
# Expected: No error
```

## Dependencies

- Docker Engine 20.10+
- docker-compose 2.0+
- Existing Docker infrastructure

## Notes

- tmux server runs in background, separate from Claude sessions
- IPC directories use shared volumes (not bind mounts) for better cross-platform support
- `host.docker.internal` works on Docker Desktop (Mac/Windows); may need `172.17.0.1` on Linux
- Consider using `tmpfs` for `/ipc/` if performance becomes an issue

## Rollback Plan

If issues occur:
1. Revert `Dockerfile.agent` and `docker-compose.yml` changes
2. Rebuild image: `docker-compose build`
3. Restart with old configuration

## Success Metrics

- Container starts within 10 seconds
- tmux server accessible via `docker exec`
- File writes complete in <100ms
- Zero permission errors in container logs
