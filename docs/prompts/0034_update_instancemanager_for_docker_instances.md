---
name: update_instancemanager_for_docker_instances
description: Update InstanceManager to support Docker instances alongside tmux instances
status: Backlog
created_at: 2025-01-28
updated_at: 2025-01-28
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: [0027, 0029, 0033]
tags: [docker, core-integration, p0, instance-management]
---

## 0034. Update InstanceManager for Docker Instances

### Background

The current `InstanceManager` in `/Users/robin/xprojects/cc-bridge/cc_bridge/core/instances.py` is designed exclusively for tmux-based instances. With the introduction of Docker instances, we need to update the manager to handle both instance types, including creation, listing, status checking, and deletion operations.

### Requirements / Objectives

**Functional Requirements:**
- Support creating Docker instance records
- Support listing both tmux and Docker instances
- Support updating Docker instance metadata
- Support deleting Docker instance records
- Integrate with DockerDiscoverer for auto-discovery
- Maintain backward compatibility with tmux instances
- Provide type-specific operations

**Non-Functional Requirements:**
- No breaking changes to existing tmux functionality
- Clear separation of tmux and Docker logic
- Efficient discovery and caching
- Robust error handling for Docker failures
- Clear logging for debugging

**Acceptance Criteria:**
- [ ] `InstanceManager.create_instance()` supports Docker instances
- [ ] `InstanceManager.list_instances()` returns both types
- [ ] `InstanceManager.update_instance()` handles Docker fields
- [ ] `InstanceManager.delete_instance()` works for both types
- [ ] Auto-discovery integration on startup
- [ ] All existing tmux operations unchanged
- [ ] Unit tests for Docker operations
- [ ] Integration test with real containers

#### Q&A

**Q:** How do we distinguish between creating tmux vs Docker instances?
**A:** Add `instance_type` parameter to `create_instance()`. If not provided, default to "tmux" for backward compatibility. For Docker instances, require Docker-specific fields (container_id, container_name).

**Q:** Should auto-discovery happen automatically or on-demand?
**A:** Both: Run auto-discovery on InstanceManager initialization (if Docker enabled in config). Also provide a `refresh_discovery()` method for manual refresh. Add a `--skip-discovery` flag to disable on startup.

**Q:** How do we handle name conflicts between tmux and Docker instances?
**A:** Enforce unique names across all instance types. If conflict detected during discovery, append `-docker` suffix or use container ID as name. Log a warning about the conflict.

**Q:** What about Docker instances that are no longer running?
**A:** During discovery, update instance status to "stopped" for containers that no longer exist. Keep the instance record (don't auto-delete) to preserve history. Add a `--cleanup-stopped` flag to remove stopped instances.

**Q:** Should we add Docker-specific methods to InstanceManager?
**A:** Yes, add convenience methods:
- `create_docker_instance(container_id, name, ...)`
- `list_docker_instances()`
- `get_docker_instance(name)`
These wrap the generic methods with Docker-specific logic.

### Solutions / Goals

**Technology Stack:**
- Existing `InstanceManager` class
- `DockerDiscoverer` from task 0029
- Extended `ClaudeInstance` model from task 0027
- Configuration from `[docker]` section

**Implementation Approach:**
1. Update `create_instance()` to support Docker
2. Integrate DockerDiscoverer for auto-discovery
3. Add Docker-specific helper methods
4. Update `list_instances()` to handle both types
5. Add status checking for Docker instances
6. Add cleanup methods for stopped instances
7. Update persistence for Docker fields

#### Plan

1. **Phase 1** - Instance Creation
   - [ ] Update `create_instance()` signature
   - [ ] Add `instance_type` parameter
   - [ ] Add Docker-specific fields
   - [ ] Validate Docker instance fields
   - [ ] Add `create_docker_instance()` helper
   - [ ] Test creation of both types

2. **Phase 2** - Discovery Integration
   - [ ] Import `DockerDiscoverer`
   - [ ] Run discovery on initialization
   - [ ] Merge discovered instances with existing
   - [ ] Handle name conflicts
   - [ ] Update instance statuses
   - [ ] Add `refresh_discovery()` method

3. **Phase 3** - Instance Listing
   - [ ] Update `list_instances()` to return both types
   - [ ] Add `list_tmux_instances()` helper
   - [ ] Add `list_docker_instances()` helper
   - [ ] Add filtering by status
   - [ ] Add sorting options

4. **Phase 4** - Status and Updates
   - [ ] Update `get_instance_status()` for Docker
   - [ ] Check container status via Docker SDK
   - [ ] Update `update_instance()` for Docker fields
   - [ ] Add `update_docker_instance()` helper
   - [ ] Handle container state changes

5. **Phase 5** - Cleanup and Deletion
   - [ ] Update `delete_instance()` for both types
   - [ ] Add `cleanup_stopped_instances()` method
   - [ ] Add `prune_discovered_instances()` method
   - [ ] Handle Docker-specific cleanup

6. **Phase 6** - Testing
   - [ ] Unit test for Docker instance creation
   - [ ] Unit test for discovery integration
   - [ ] Unit test for listing both types
   - [ ] Unit test for status checking
   - [ ] Unit test for cleanup operations
   - [ ] Integration test with real containers
   - [ ] Test backward compatibility with tmux

### References

- Current InstanceManager: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/instances.py`
- DockerDiscoverer: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/docker_discovery.py` (from task 0029)
- Extended ClaudeInstance model: `/Users/robin/xprojects/cc-bridge/cc_bridge/models/instances.py` (from task 0027)
- Task 0028: Create Docker Configuration Section
- Task 0029: Implement Docker Container Discovery
