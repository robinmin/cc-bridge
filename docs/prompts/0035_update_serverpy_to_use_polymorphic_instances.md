---
name: update_serverpy_to_use_polymorphic_instances
description: Update server.py to use polymorphic InstanceInterface for both tmux and Docker instances
status: Backlog
created_at: 2025-01-28
updated_at: 2025-01-28
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: [0030, 0033, 0034]
tags: [docker, core-integration, p0, server]
---

## 0035. Update server.py to Use Polymorphic Instances

### Background

The current `server.py` directly uses tmux-specific operations (`get_session()`) to interact with Claude instances. To support both tmux and Docker instances transparently, we need to update the server to use the polymorphic `InstanceInterface` defined in task 0030.

### Requirements / Objectives

**Functional Requirements:**
- Replace direct tmux calls with InstanceInterface
- Support both tmux and Docker instances
- Select appropriate instance adapter based on instance type
- Handle instance-type-specific errors
- Maintain backward compatibility with tmux
- Support instance selection logic (default vs specific)

**Non-Functional Requirements:**
- No breaking changes to existing tmux behavior
- Clear error messages for instance failures
- Efficient adapter creation and reuse
- Proper resource cleanup

**Acceptance Criteria:**
- [ ] Server uses `get_instance_adapter()` factory
- [ ] Works with tmux instances unchanged
- [ ] Works with Docker instances
- [ ] Handles missing instances gracefully
- [ ] Handles adapter failures gracefully
- [ ] All existing tests pass
- [ ] New tests for Docker instances
- [ ] Integration test with both instance types

#### Q&A

**Q:** How do we select which instance to use?
**A:** Keep existing logic: use first instance from `instance_manager.list_instances()`. The difference now is that the list can include both tmux and Docker instances. The adapter factory will create the appropriate type.

**Q:** What if there are both tmux and Docker instances?
**A:** Prioritize based on configuration: `docker.preferred = true|false` (default: false for backward compatibility). If preferred, use Docker instance if available, otherwise use tmux.

**Q:** How do we handle instance selection errors?
**A:** If no instances available, return error response. If instance type is unknown, log error and skip to next instance. If adapter creation fails, log error and try next instance.

**Q:** Should we cache instance adapters?
**A:** Yes, cache adapters by instance name in a dict. Invalidate cache when instance changes (status update, delete). Use `functools.lru_cache` or simple dict with TTL.

**Q:** What about instance-specific error handling?
**A:** Catch instance-type-specific exceptions and wrap in generic `InstanceOperationError`. Log original exception for debugging. Return user-friendly error message.

### Solutions / Goals

**Technology Stack:**
- `InstanceInterface` from task 0030
- `TmuxInstance` and `DockerContainer` adapters
- `get_instance_adapter()` factory
- Existing server infrastructure

**Implementation Approach:**
1. Import InstanceInterface and factory
2. Replace direct tmux calls with adapter calls
3. Add instance selection logic
4. Add adapter caching
5. Update error handling
6. Add logging for instance type
7. Update tests

#### Plan

1. **Phase 1** - Import and Setup
   - [ ] Import `InstanceInterface` and factory
   - [ ] Import adapter implementations
   - [ ] Add adapter cache dict
   - [ ] Add configuration for instance preference

2. **Phase 2** - Instance Selection
   - [ ] Update instance selection logic
   - [ ] Check Docker preference config
   - [ ] Filter instances by status (running)
   - [ ] Select first available instance
   - [ ] Handle no instances case

3. **Phase 3** - Adapter Creation
   - [ ] Use `get_instance_adapter()` factory
   - [ ] Implement adapter caching
   - [ ] Add cache invalidation logic
   - [ ] Handle adapter creation errors
   - [ ] Log adapter type for debugging

4. **Phase 4** - Replace Tmux Calls
   - [ ] Replace `get_session()` with adapter
   - [ ] Replace `session.send_command_and_wait()` with adapter
   - [ ] Update response handling
   - [ ] Update error handling
   - [ ] Update activity tracking

5. **Phase 5** - Error Handling
   - [ ] Catch adapter-specific exceptions
   - [ ] Wrap in generic `InstanceOperationError`
   - [ ] Log original exceptions
   - [ ] Return user-friendly error messages
   - [ ] Handle adapter failures gracefully

6. **Phase 6** - Testing
   - [ ] Unit test for instance selection
   - [ ] Unit test for tmux instance usage
   - [ ] Unit test for Docker instance usage
   - [ ] Unit test for adapter caching
   - [ ] Unit test for error handling
   - [ ] Integration test with tmux
   - [ ] Integration test with Docker
   - [ ] Integration test with both types

### References

- Current server: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/server.py`
- InstanceInterface: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/instance_interface.py` (from task 0030)
- TmuxInstance adapter (from task 0030)
- DockerContainer adapter: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/docker_container.py` (from task 0033)
- InstanceManager: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/instances.py` (from task 0034)
