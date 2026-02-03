---
name: implement_docker_container_discovery
description: Implement Docker container discovery to find Claude Code instances running in containers
status: Done
created_at: 2025-01-28
updated_at: 2026-02-03 15:02:19
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: [0026, 0027, 0028]
tags: [docker, foundation, p0, discovery]
---

## 0029. Implement Docker Container Discovery

### Background

To integrate Docker-based Claude Code instances with cc-bridge server, we need a mechanism to discover running containers that host Claude Code. This discovery system should identify containers by labels, image names, or running processes, similar to how tmux sessions are currently discovered.

### Requirements / Objectives

**Functional Requirements:**
- Discover Docker containers running Claude Code
- Support multiple discovery methods (labels, image names, process inspection)
- Filter containers by configurable criteria
- Map discovered containers to ClaudeInstance records
- Handle container state changes (started/stopped)
- Support periodic refresh of container list

**Non-Functional Requirements:**
- Efficient discovery with minimal Docker API overhead
- Graceful handling of Docker daemon unavailability
- Clear logging for discovery operations
- No impact on existing tmux instance discovery

**Acceptance Criteria:**
- [ ] `DockerDiscoverer` class implemented in `cc_bridge/core/docker_discovery.py`
- [ ] Discovers containers by label filter
- [ ] Discovers containers by image name
- [ ] Creates ClaudeInstance records for discovered containers
- [ ] Handles Docker daemon errors gracefully
- [ ] Logs discovery operations clearly
- [ ] Unit tests for discovery logic
- [ ] Integration test with real Docker containers

#### Q&A

**Q:** How do we identify which containers are running Claude Code?
**A:** Use multiple methods in priority order:
1. Label filter: `cc-bridge.instance=<name>` (most reliable)
2. Image name: Containers using `cc-bridge` or `claude-code` images
3. Process inspection: Check if `claude` process is running in container

**Q:** What happens when a container is discovered but not tracked in instances.json?
**A:** Auto-create a ClaudeInstance record with type="docker" and populate Docker fields. This allows seamless integration with existing containers.

**Q:** How do we handle container name conflicts?
**A:** Use Docker container name as the instance name. If conflict with existing tmux instance, append `-docker` suffix or use container ID as unique identifier.

**Q:** Should discovery be automatic or manual?
**A:** Both: Provide `--auto-discover` configuration option (default: true) for automatic discovery on startup, and a CLI command `cc-bridge docker discover` for manual refresh.

### Solutions / Goals

**Technology Stack:**
- Docker Python SDK (`docker.from_env()`)
- Existing ClaudeInstance model
- Container.labels for metadata
- Container.top() for process inspection

**Implementation Approach:**
1. Create `DockerDiscoverer` class
2. Implement label-based discovery
3. Implement image-based discovery
4. Implement process-based discovery
5. Map containers to ClaudeInstance records
6. Add state change detection
7. Integrate with InstanceManager

#### Plan

1. **Phase 1** - Discoverer Class
   - [ ] Create `cc_bridge/core/docker_discovery.py`
   - [ ] Implement `DockerDiscoverer` class
   - [ ] Add Docker client initialization
   - [ ] Add error handling for Docker unavailability
   - [ ] Add logging infrastructure

2. **Phase 2** - Discovery Methods
   - [ ] Implement label-based discovery
   - [ ] Implement image-based discovery
   - [ ] Implement process-based discovery
   - [ ] Add priority ordering for methods
   - [ ] Add container filtering logic

3. **Phase 3** - Instance Mapping
   - [ ] Map container to ClaudeInstance
   - [ ] Extract container metadata
   - [ ] Handle name conflicts
   - [ ] Populate Docker-specific fields
   - [ ] Merge with existing instances

4. **Phase 4** - State Management
   - [ ] Detect container state changes
   - [ ] Update instance status
   - [ ] Handle removed containers
   - [ ] Handle new containers
   - [ ] Implement periodic refresh

5. **Phase 5** - CLI Integration
   - [ ] Add `docker discover` CLI command
   - [ ] Add `--auto-discover` flag to server startup
   - [ ] Add `--refresh-interval` configuration
   - [ ] Implement manual discovery trigger

6. **Phase 6** - Testing
   - [ ] Unit test for label discovery
   - [ ] Unit test for image discovery
   - [ ] Unit test for process discovery
   - [ ] Unit test for instance mapping
   - [ ] Integration test with real containers
   - [ ] Mock Docker API for CI/CD

### References

- Docker SDK containers API: https://docker-py.readthedocs.io/en/stable/containers.html
- Container labels: https://docs.docker.com/engine/reference/commandline/run/#label
- Current instance discovery: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/instances.py`
- Task 0026: Add Docker Python SDK Dependency
- Task 0027: Extend ClaudeInstance Model for Docker Support
- Task 0028: Create Docker Configuration Section
