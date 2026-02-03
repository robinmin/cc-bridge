---
name: implement_dockercontainer_class
description: Implement DockerContainer class to manage Docker instances via InstanceInterface
status: Done
created_at: 2025-01-28
updated_at: 2026-02-03 15:02:16
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: [0026, 0027, 0031, 0032]
tags: [docker, core-integration, p0, instance-management]
---

## 0033. Implement DockerContainer Class

### Background

With the Named Pipe communication channel (task 0031) and container agent script (task 0032) in place, we need to implement the `DockerContainer` class that realizes the `InstanceInterface` for Docker-based instances. This class will be the primary interface for interacting with Docker-hosted Claude Code instances.

### Requirements / Objectives

**Functional Requirements:**
- Implement `InstanceInterface` for Docker containers
- Use Named Pipe communication for command/response
- Support container lifecycle management (start, stop, status)
- Handle container state changes
- Provide container-specific metadata
- Support Docker exec for fallback/debugging
- Handle container network communication

**Non-Functional Requirements:**
- Consistent interface with `TmuxInstance`
- Robust error handling for Docker failures
- Clear logging for debugging
- Thread-safe operations
- Resource cleanup on errors

**Acceptance Criteria:**
- [ ] `DockerContainer` class implements `InstanceInterface`
- [ ] Uses `NamedPipeChannel` for I/O
- [ ] Implements `send_command()` method
- [ ] Implements `send_command_and_wait()` method
- [ ] Implements `is_running()` method
- [ ] Implements `get_info()` method
- [ ] Implements `cleanup()` method
- [ ] Handles container state changes
- [ ] Unit tests for all methods
- [ ] Integration test with real container

#### Q&A

**Q:** How does DockerContainer interact with the container agent?
**A:** The agent runs inside the container (task 0032). DockerContainer uses NamedPipeChannel to write commands to the input pipe (agent reads) and read responses from output pipe (agent writes). The agent bridges these to Claude Code's stdin/stdout.

**Q:** What if the container agent is not running?
**A:** DockerContainer should detect this (pipe open fails or no data) and attempt to start the agent via `docker exec`. If that fails, raise an error with clear message.

**Q:** How do we handle container restart?
**A:** On `send_command()`, check if container is running. If not, attempt to start it. Re-establish named pipe connection after restart. Log all state changes.

**Q:** Should we support Docker exec as a fallback?
**A:** Yes, add a private method `_exec_fallback()` that uses `docker exec` if named pipes fail. This is useful for debugging and recovery. Log when fallback is used.

**Q:** How do we get container metadata?
**A:** Use Docker SDK to get container details: image name, creation time, status, ports, volumes. Return in `get_info()` as dict.

### Solutions / Goals

**Technology Stack:**
- Docker Python SDK for container operations
- `NamedPipeChannel` from task 0031
- `InstanceInterface` from task 0030
- `asyncio` for async operations
- Existing ClaudeInstance model

**Implementation Approach:**
1. Create `DockerContainer` class
2. Initialize with ClaudeInstance and Docker client
3. Implement `send_command()` using named pipes
4. Implement `send_command_and_wait()` using named pipes
5. Implement `is_running()` via Docker SDK
6. Implement `get_info()` via Docker SDK
7. Implement `cleanup()` for resource management
8. Add error handling and fallback logic

#### Plan

1. **Phase 1** - Class Structure
   - [ ] Create `DockerContainer` class
   - [ ] Implement `__init__` with ClaudeInstance and Docker client
   - [ ] Validate instance has Docker fields
   - [ ] Initialize NamedPipeChannel
   - [ ] Add logging

2. **Phase 2** - Command Sending
   - [ ] Implement `async send_command(text: str) -> AsyncIterator[str]`
   - [ ] Write command to input pipe via NamedPipeChannel
   - [ ] Stream response from output pipe
   - [ ] Handle pipe errors gracefully
   - [ ] Add timeout handling

3. **Phase 3** - Command with Wait
   - [ ] Implement `async send_command_and_wait(text: str, timeout: float) -> tuple[bool, str]`
   - [ ] Call `send_command()`
   - [ ] Accumulate response until completion
   - [ ] Handle timeout
   - [ ] Return success status and output

4. **Phase 4** - Status and Info
   - [ ] Implement `is_running() -> bool`
   - [ ] Check container status via Docker SDK
   - [ ] Verify container agent is responsive
   - [ ] Implement `get_info() -> dict[str, Any]`
   - [ ] Return container metadata

5. **Phase 5** - Lifecycle and Cleanup
   - [ ] Implement `start()` to start container if stopped
   - [ ] Implement `stop()` to stop container gracefully
   - [ ] Implement `cleanup()` to release resources
   - [ ] Close named pipes
   - [ ] Add signal handling

6. **Phase 6** - Error Handling
   - [ ] Add fallback to docker exec if pipes fail
   - [ ] Handle container not found
   - [ ] Handle container not running
   - [ ] Handle Docker daemon errors
   - [ ] Add comprehensive logging

7. **Phase 7** - Testing
   - [ ] Unit test for initialization
   - [ ] Unit test for `send_command()`
   - [ ] Unit test for `send_command_and_wait()`
   - [ ] Unit test for `is_running()`
   - [ ] Unit test for `get_info()`
   - [ ] Unit test for error handling
   - [ ] Integration test with real container
   - [ ] Mock Docker API for CI/CD

### References

- Docker SDK container API: https://docker-py.readthedocs.io/en/stable/containers.html
- Named Pipe Channel: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/named_pipe.py` (from task 0031)
- Instance Interface: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/instance_interface.py` (from task 0030)
- Container Agent: `/Users/robin/xprojects/cc-bridge/cc_bridge/agents/container_agent.py` (from task 0032)
- Task 0027: Extend ClaudeInstance Model for Docker Support
- Task 0026: Add Docker Python SDK Dependency
