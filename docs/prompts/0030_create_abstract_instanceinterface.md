---
name: create_abstract_instanceinterface
description: Create abstract InstanceInterface to polymorphically handle tmux and Docker instances
status: Done
created_at: 2025-01-28
updated_at: 2026-02-03 15:03:06
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: [0026, 0027]
tags: [docker, foundation, p0, architecture]
---

## 0030. Create Abstract InstanceInterface

### Background

The current cc-bridge server directly uses tmux-specific operations (`get_session()`, `send_command_and_wait()`) to interact with Claude instances. To support Docker instances alongside tmux, we need a polymorphic interface that abstracts the differences between instance types while providing a consistent API for the server.

### Requirements / Objectives

**Functional Requirements:**
- Define abstract `InstanceInterface` base class
- Implement `TmuxInstance` adapter for tmux sessions
- Implement `DockerInstance` adapter for Docker containers
- Provide factory method to create appropriate instance type
- Support common operations: send command, wait for response, check status
- Handle instance-type-specific error conditions

**Non-Functional Requirements:**
- Clean separation of instance-type logic
- No changes to existing tmux behavior
- Type-safe with clear interface contracts
- Easy to test with mock implementations
- Extensible for future instance types (e.g., Kubernetes pods)

**Acceptance Criteria:**
- [ ] Abstract `InstanceInterface` defined in `cc_bridge/core/instance_interface.py`
- [ ] `TmuxInstance` implements interface with existing tmux logic
- [ ] `DockerInstance` implements interface stub (full impl in task 0032)
- [ ] Factory method creates correct instance type
- [ ] Server updated to use interface instead of direct tmux calls
- [ ] All existing tests pass
- [ ] New tests for polymorphic behavior

#### Q&A

**Q:** What methods should the interface define?
**A:** Core methods needed by server:
- `send_command(text: str) -> AsyncIterator[str]` - Send command and stream response
- `send_command_and_wait(text: str, timeout: float) -> tuple[bool, str]` - Send and wait for completion
- `is_running() -> bool` - Check if instance is active
- `get_info() -> dict[str, Any]` - Get instance metadata
- `cleanup() -> None` - Release resources

**Q:** How do we handle the transition from direct tmux calls?
**A:** Extract existing tmux logic from `cc_bridge/core/tmux.py` into `TmuxInstance` class. Update server to use `get_instance_adapter(instance)` factory. Keep backward compatibility by defaulting to tmux for instances without explicit type.

**Q:** Should we use Protocol or ABC?
**A:** Use `abc.ABC` with `@abstractmethod` decorators for clear interface definition and enforcement. This is more explicit than Protocol and provides better error messages.

**Q:** How do we handle instance-type-specific features?
**A:** Keep core interface minimal. Add type-specific methods in subclasses (e.g., `TmuxInstance.attach_session()`, `DockerInstance.exec_raw()`). Use `isinstance()` checks when needed.

### Solutions / Goals

**Technology Stack:**
- Python's `abc.ABC` and `@abstractmethod`
- `asyncio` for async operations
- Existing tmux module
- Docker SDK (for DockerInstance)

**Implementation Approach:**
1. Define abstract `InstanceInterface` with core methods
2. Extract tmux logic into `TmuxInstance` adapter
3. Create stub `DockerInstance` adapter
4. Implement factory function `get_instance_adapter()`
5. Update server to use interface
6. Add unit tests for each implementation

#### Plan

1. **Phase 1** - Interface Definition
   - [ ] Create `cc_bridge/core/instance_interface.py`
   - [ ] Define `InstanceInterface` ABC
   - [ ] Document each abstract method
   - [ ] Add type hints for all methods
   - [ ] Define common exception types

2. **Phase 2** - Tmux Adapter
   - [ ] Create `TmuxInstance` class
   - [ ] Extract logic from `cc_bridge/core/tmux.py`
   - [ ] Implement all interface methods
   - [ ] Add tmux-specific methods
   - [ ] Add error handling

3. **Phase 3** - Docker Adapter Stub
   - [ ] Create `DockerInstance` class
   - [ ] Implement interface methods with NotImplementedError
   - [ ] Add TODO comments for full implementation
   - [ ] Define Docker-specific attributes

4. **Phase 4** - Factory Pattern
   - [ ] Implement `get_instance_adapter(instance: ClaudeInstance) -> InstanceInterface`
   - [ ] Add logic to determine instance type
   - [ ] Handle missing/unknown instance types
   - [ ] Add caching for adapters

5. **Phase 5** - Server Integration
   - [ ] Update `server.py` to use interface
   - [ ] Replace direct tmux calls with adapter calls
   - [ ] Update dependency injection
   - [ ] Add error handling for adapter failures

6. **Phase 6** - Testing
   - [ ] Unit test for interface definition
   - [ ] Unit test for TmuxInstance
   - [ ] Unit test for DockerInstance stub
   - [ ] Unit test for factory method
   - [ ] Integration test for server usage
   - [ ] Mock tests for error conditions

### References

- Python ABC documentation: https://docs.python.org/3/library/abc.html
- Adapter pattern: https://refactoring.guru/design-patterns/adapter
- Current tmux module: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/tmux.py`
- Current server logic: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/server.py`
- Task 0027: Extend ClaudeInstance Model for Docker Support
- Task 0026: Add Docker Python SDK Dependency
