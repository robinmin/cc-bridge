---
name: integrate_with_existing_claude_command
description: Integrate Docker instances into existing claude command for unified instance management
status: Backlog
created_at: 2025-01-28
updated_at: 2025-01-28
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: [0030, 0034, 0036]
tags: [docker, user-experience, p1, cli, integration]
---

## 0037. Integrate with Existing Claude Command

### Background

Users are familiar with the existing `cc-bridge claude` commands for managing tmux instances. To provide a seamless experience, we should integrate Docker instance support into these commands rather than requiring users to learn a separate `cc-bridge docker` command set. The `claude` command should auto-detect instance type and delegate appropriately.

### Requirements / Objectives

**Functional Requirements:**
- `cc-bridge claude start` supports both tmux and Docker instances
- `cc-bridge claude stop` works for both instance types
- `cc-bridge claude list` shows both instance types
- `cc-bridge claude status` reports status for both types
- Auto-detect instance type from configuration or instance metadata
- Add `--type` flag to force specific instance type
- Maintain backward compatibility with tmux-only usage

**Non-Functional Requirements:**
- No breaking changes to existing command behavior
- Clear indication of instance type in output
- Graceful fallback when instance type is ambiguous
- Clear error messages for unsupported operations

**Acceptance Criteria:**
- [ ] `cc-bridge claude start` auto-detects instance type
- [ ] `cc-bridge claude stop` works for both types
- [ ] `cc-bridge claude list` shows both types with type labels
- [ ] `cc-bridge claude status` shows type-specific info
- [ ] `--type` flag forces specific type
- [ ] Existing tmux usage unchanged
- [ ] Unit tests for integrated commands
- [ ] Documentation updated

#### Q&A

**Q:** How do we determine whether to create a tmux or Docker instance?
**A:** Check configuration in priority order:
1. Explicit `--type` flag (tmux|docker)
2. Existing instance metadata (if instance already exists)
3. Default configuration: `docker.enabled` (if true, prefer Docker)
4. Fallback to tmux for backward compatibility

**Q:** What about `cc-bridge claude start` when Docker is enabled?
**A:** If `docker.enabled=true` in config, default to Docker instance. Add `--tmux` flag to force tmux. Show warning when defaulting to Docker to avoid user surprise.

**Q:** How do we handle existing tmux instances when Docker is enabled?
**A:** Check if instance already exists in InstanceManager. If yes, use its type. If no, create based on config. This preserves existing instances.

**Q:** Should we show different information for different instance types?
**A:** Yes, add type-specific fields to output:
- Tmux: session name, PID, tmux socket path
- Docker: container ID, image name, container status
Include `Type: tmux|docker` in all output for clarity.

**Q:** What about commands that don't make sense for Docker (e.g., attach)?
**A:** For commands that are tmux-specific, either:
1. Implement Docker equivalent (e.g., `docker exec` instead of attach)
2. Show error: "Command not supported for Docker instances. Use 'cc-bridge docker exec' instead."

### Solutions / Goals

**Technology Stack:**
- Existing `cc_bridge/commands/claude_cmd.py`
- InstanceManager for instance lookup
- DockerDiscoverer for Docker detection
- Configuration for default type

**Implementation Approach:**
1. Add `--type` flag to relevant commands
2. Implement auto-detection logic
3. Update commands to use InstanceInterface
4. Add type-specific output formatting
5. Add error messages for unsupported operations
6. Update help text and examples

#### Plan

1. **Phase 1** - Type Detection
   - [ ] Add `--type` flag (tmux|docker|auto)
   - [ ] Implement auto-detection logic
   - [ ] Check existing instance type
   - [ ] Check default configuration
   - [ ] Add logging for type selection

2. **Phase 2** - Start Command
   - [ ] Update `claude start` for both types
   - [ ] Use InstanceManager.create_docker_instance()
   - [ ] Add Docker-specific options (image, compose file)
   - [ ] Handle start failures for both types
   - [ ] Add type to output message

3. **Phase 3** - Stop Command
   - [ ] Update `claude stop` for both types
   - [ ] Use appropriate stop method per type
   - [ ] Handle Docker container stop
   - [ ] Handle tmux session kill
   - [ ] Add type to output message

4. **Phase 4** - List Command
   - [ ] Update `claude list` to show both types
   - [ ] Add Type column to output
   - [ ] Show type-specific metadata
   - [ ] Add filtering by type
   - [ ] Colorize type labels

5. **Phase 5** - Status Command
   - [ ] Update `claude status` for both types
   - [ ] Show type-specific status
   - [ ] Docker: container status, health, uptime
   - [ ] Tmux: session status, PID, uptime
   - [ ] Add type indicator

6. **Phase 6** - Error Handling
   - [ ] Add type-specific error messages
   - [ ] Suggest alternative commands
   - [ ] Handle unsupported operations
   - [ ] Add helpful hints

7. **Phase 7** - Documentation
   - [ ] Update help text for all commands
   - [ ] Add examples for Docker instances
   - [ ] Document `--type` flag behavior
   - [ ] Add migration guide from tmux to Docker

8. **Phase 8** - Testing
   - [ ] Unit test for auto-detection
   - [ ] Unit test for start with both types
   - [ ] Unit test for stop with both types
   - [ ] Unit test for list with both types
   - [ ] Unit test for status with both types
   - [ ] Integration test with tmux
   - [ ] Integration test with Docker
   - [ ] Test backward compatibility

### References

- Existing claude command: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/claude_cmd.py`
- Docker command group: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/docker_cmd.py` (from task 0036)
- InstanceManager: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/instances.py` (from task 0034)
- Configuration: `/Users/robin/xprojects/cc-bridge/cc_bridge/config.py`
- Task 0030: Create Abstract InstanceInterface
