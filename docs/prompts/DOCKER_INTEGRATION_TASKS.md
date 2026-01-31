# Docker Integration Task List for cc-bridge Server

## Overview

This document provides a comprehensive task breakdown for integrating Docker support with the cc-bridge server. The integration enables cc-bridge to manage Claude Code instances running in Docker containers alongside existing tmux-based instances.

**Total Tasks:** 15 tasks (0026-0040)
**Estimated Effort:** ~80-120 hours total
**Timeline:** 3-4 weeks with focused development

## User Decisions

- **Communication Method:** Named Pipe (FIFO) for host-container communication
- **Scope:** Full Integration (P0 + P1 gaps)
- **Instance Management:** Both approaches (docker-compose + integrated CLI)

## Task Dependencies

```
Phase 1 (Foundation): 0026 → 0027 → 0028 → 0029 → 0030
Phase 2 (Core Integration): 0031 → 0032 → 0033 → 0034 → 0035
Phase 3 (User Experience): 0036 → 0037 → 0038 → 0039 → 0040
```

## Phase 1: Foundation (P0)

### Task 0026: Add Docker Python SDK Dependency
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0026_add_docker_python_sdk_dependency.md`

**Description:** Add `docker` Python package to enable programmatic Docker container management.

**Requirements:**
- Add `docker>=7.0.0,<8.0.0` to `pyproject.toml`
- Graceful handling when Docker is not installed
- Backward compatibility with tmux-only usage

**Effort:** 2 hours

**Dependencies:** None

**Acceptance Criteria:**
- [ ] Docker package added to dependencies
- [ ] Version constraint specified
- [ ] Existing tests pass without Docker
- [ ] Documentation updated

---

### Task 0027: Extend ClaudeInstance Model for Docker Support
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0027_extend_claudeinstance_model_for_docker_support.md`

**Description:** Extend ClaudeInstance model to support Docker containers alongside tmux sessions.

**Requirements:**
- Add `instance_type` field ("tmux" | "docker")
- Add Docker-specific fields (container_id, container_name, image_name)
- Maintain backward compatibility with existing instances

**Effort:** 4 hours

**Dependencies:** 0026

**Acceptance Criteria:**
- [ ] instance_type field added
- [ ] Docker fields added (optional)
- [ ] Pydantic validation for consistency
- [ ] Migration path documented

---

### Task 0028: Create Docker Configuration Section
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0028_create_docker_configuration_section.md`

**Description:** Add Docker configuration section to support Docker-based Claude instances.

**Requirements:**
- Add `[docker]` section to config schema
- Configure network, named pipes, discovery
- Provide sensible defaults
- Environment variable override support

**Effort:** 3 hours

**Dependencies:** 0026, 0027

**Acceptance Criteria:**
- [ ] [docker] section defined
- [ ] Default values provided
- [ ] Configuration validation
- [ ] Documentation updated

---

### Task 0029: Implement Docker Container Discovery
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0029_implement_docker_container_discovery.md`

**Description:** Implement discovery system to find Claude Code instances running in Docker containers.

**Requirements:**
- Discover containers by label, image name, or process
- Map containers to ClaudeInstance records
- Handle container state changes
- Support periodic refresh

**Effort:** 8 hours

**Dependencies:** 0026, 0027, 0028

**Acceptance Criteria:**
- [ ] DockerDiscoverer class implemented
- [ ] Label-based discovery
- [ ] Image-based discovery
- [ ] Process-based discovery
- [ ] State change detection
- [ ] Unit and integration tests

---

### Task 0030: Create Abstract InstanceInterface
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0030_create_abstract_instanceinterface.md`

**Description:** Create abstract interface to polymorphically handle tmux and Docker instances.

**Requirements:**
- Define InstanceInterface ABC with core methods
- Implement TmuxInstance adapter
- Implement DockerInstance adapter stub
- Provide factory method for type selection

**Effort:** 6 hours

**Dependencies:** 0026, 0027

**Acceptance Criteria:**
- [ ] Interface defined
- [ ] TmuxInstance implemented
- [ ] DockerInstance stub created
- [ ] Factory method implemented
- [ ] Server updated to use interface

## Phase 2: Core Integration (P0)

### Task 0031: Implement Named Pipe Communication Channel
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0031_implement_named_pipe_communication_channel.md`

**Description:** Implement Named Pipe (FIFO) communication channel for Docker container I/O.

**Requirements:**
- Create input/output FIFO pipes
- Support bi-directional message passing
- Handle concurrent access
- Clean up pipes on instance stop

**Effort:** 10 hours

**Dependencies:** 0026, 0028, 0030

**Acceptance Criteria:**
- [ ] NamedPipeChannel class created
- [ ] Pipe creation and cleanup
- [ ] Async write operations
- [ ] Async read operations
- [ ] Thread-safe operations
- [ ] Unit and integration tests

---

### Task 0032: Implement Container Agent Script
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0032_implement_container_agent_script.md`

**Description:** Implement agent script that runs inside Docker containers to bridge Claude Code with named pipes.

**Requirements:**
- Run inside container alongside Claude Code
- Read commands from input FIFO
- Send to Claude Code via stdin/stdout
- Write responses to output FIFO
- Handle graceful shutdown

**Effort:** 10 hours

**Dependencies:** 0031

**Acceptance Criteria:**
- [ ] container_agent.py script created
- [ ] Pipe reader implemented
- [ ] Claude Code process spawner
- [ ] Pipe writer implemented
- [ ] Bridge logic complete
- [ ] Signal handling
- [ ] Unit and integration tests

---

### Task 0033: Implement DockerContainer Class
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0033_implement_dockercontainer_class.md`

**Description:** Implement DockerContainer class to manage Docker instances via InstanceInterface.

**Requirements:**
- Implement InstanceInterface for Docker
- Use NamedPipeChannel for I/O
- Support container lifecycle management
- Handle state changes
- Docker exec fallback for debugging

**Effort:** 8 hours

**Dependencies:** 0026, 0027, 0031, 0032

**Acceptance Criteria:**
- [ ] DockerContainer class implements interface
- [ ] send_command() using named pipes
- [ ] send_command_and_wait() using named pipes
- [ ] is_running() via Docker SDK
- [ ] get_info() via Docker SDK
- [ ] cleanup() for resources
- [ ] Unit and integration tests

---

### Task 0034: Update InstanceManager for Docker Instances
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0034_update_instancemanager_for_docker_instances.md`

**Description:** Update InstanceManager to support Docker instances alongside tmux instances.

**Requirements:**
- Support creating Docker instance records
- Support listing both instance types
- Integrate DockerDiscoverer
- Maintain backward compatibility
- Provide type-specific operations

**Effort:** 6 hours

**Dependencies:** 0027, 0029, 0033

**Acceptance Criteria:**
- [ ] create_instance() supports Docker
- [ ] list_instances() returns both types
- [ ] Auto-discovery integration
- [ ] Docker-specific helper methods
- [ ] Cleanup operations
- [ ] Unit and integration tests

---

### Task 0035: Update server.py to Use Polymorphic Instances
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0035_update_serverpy_to_use_polymorphic_instances.md`

**Description:** Update server.py to use polymorphic InstanceInterface for both instance types.

**Requirements:**
- Replace direct tmux calls with interface
- Support both tmux and Docker instances
- Add instance selection logic
- Handle adapter failures gracefully
- Maintain backward compatibility

**Effort:** 6 hours

**Dependencies:** 0030, 0033, 0034

**Acceptance Criteria:**
- [ ] Server uses get_instance_adapter()
- [ ] Works with tmux unchanged
- [ ] Works with Docker instances
- [ ] Adapter caching implemented
- [ ] Error handling updated
- [ ] Unit and integration tests

## Phase 3: User Experience (P1)

### Task 0036: Add Docker Instance CLI Commands
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0036_add_docker_instance_cli_commands.md`

**Description:** Add Docker-specific CLI commands for managing Docker-based Claude instances.

**Requirements:**
- `cc-bridge docker start/stop/list/logs/exec/discover`
- Consistent interface with tmux commands
- Help text and examples
- Proper error handling

**Effort:** 8 hours

**Dependencies:** 0029, 0034

**Acceptance Criteria:**
- [ ] docker command group added
- [ ] All subcommands implemented
- [ ] Help text and examples
- [ ] Error handling for missing Docker
- [ ] Unit tests

---

### Task 0037: Integrate with Existing Claude Command
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0037_integrate_with_existing_claude_command.md`

**Description:** Integrate Docker instances into existing claude command for unified management.

**Requirements:**
- `cc-bridge claude start/stop/list/status` supports both types
- Auto-detect instance type
- Add `--type` flag for override
- Maintain backward compatibility

**Effort:** 6 hours

**Dependencies:** 0030, 0034, 0036

**Acceptance Criteria:**
- [ ] Auto-detection implemented
- [ ] Commands work for both types
- [ ] --type flag added
- [ ] Type-specific output formatting
- [ ] Existing tmux usage unchanged
- [ ] Unit and integration tests

---

### Task 0038: Add Instance Type Detection
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0038_add_instance_type_detection.md`

**Description:** Add instance type detection to automatically identify tmux vs Docker instances.

**Requirements:**
- Detect from metadata first
- Fallback to process/container detection
- Handle ambiguous cases
- Cache results for performance
- Manual override support

**Effort:** 6 hours

**Dependencies:** 0027, 0029, 0034

**Acceptance Criteria:**
- [ ] InstanceTypeDetector class created
- [ ] Metadata detection
- [ ] Container detection
- [ ] Process detection
- [ ] Heuristic resolution
- [ ] Caching with TTL
- [ ] Unit and integration tests

---

### Task 0039: Implement Error Handling for Docker
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0039_implement_error_handling_for_docker.md`

**Description:** Implement comprehensive error handling for Docker operations and failures.

**Requirements:**
- Custom Docker exception types
- User-friendly error messages
- Detailed debug logging
- Automatic recovery for common failures
- Graceful degradation when Docker unavailable

**Effort:** 6 hours

**Dependencies:** 0030, 0033, 0035

**Acceptance Criteria:**
- [ ] Custom exception types defined
- [ ] All Docker operations wrapped
- [ ] User-friendly messages
- [ ] Retry logic with backoff
- [ ] Graceful degradation
- [ ] Error metrics
- [ ] Unit tests

---

### Task 0040: Update Documentation for Docker Integration
**File:** `/Users/robin/xprojects/cc-bridge/docs/prompts/0040_update_documentation_for_docker_integration.md`

**Description:** Update documentation for Docker integration features and usage.

**Requirements:**
- Architecture documentation with diagrams
- Configuration guide
- CLI usage examples
- Troubleshooting guide
- Migration guide from tmux
- Update README and user manual

**Effort:** 8 hours

**Dependencies:** 0036, 0037

**Acceptance Criteria:**
- [ ] Architecture documentation created
- [ ] Configuration guide created
- [ ] CLI examples provided
- [ ] Troubleshooting guide created
- [ ] Migration guide created
- [ ] README updated
- [ ] All examples tested

## Summary

### By Phase

| Phase | Tasks | Total Effort |
|-------|-------|--------------|
| Phase 1: Foundation (P0) | 0026-0030 (5 tasks) | ~33 hours |
| Phase 2: Core Integration (P0) | 0031-0035 (5 tasks) | ~40 hours |
| Phase 3: User Experience (P1) | 0036-0040 (5 tasks) | ~34 hours |
| **Total** | **15 tasks** | **~107 hours** |

### By Priority

| Priority | Tasks | Total Effort |
|----------|-------|--------------|
| P0 (Foundation + Core) | 0026-0035 (10 tasks) | ~73 hours |
| P1 (User Experience) | 0036-0040 (5 tasks) | ~34 hours |

### Recommended Execution Order

1. **Week 1:** Complete Phase 1 (Foundation) - Tasks 0026-0030
2. **Week 2:** Complete Phase 2 (Core Integration) - Tasks 0031-0035
3. **Week 3:** Complete Phase 3 (User Experience) - Tasks 0036-0040

### Critical Path

```
0026 → 0027 → 0028 → 0029 → 0030 → 0031 → 0032 → 0033 → 0034 → 0035
                                    ↓
                              0036 → 0037
                              0038 → 0039 → 0040
```

## References

- All task files: `/Users/robin/xprojects/cc-bridge/docs/prompts/0026_*.md` through `0040_*.md`
- Kanban board: `/Users/robin/xprojects/cc-bridge/docs/prompts/.kanban.md`
- Current codebase: `/Users/robin/xprojects/cc-bridge/`
- Docker infrastructure: `/Users/robin/xprojects/cc-bridge/docker-compose.yml`, `Dockerfile`

## Next Steps

1. Review all task files for completeness
2. Verify dependencies and effort estimates
3. Begin execution with Task 0026 (Add Docker Python SDK Dependency)
4. Update kanban board as tasks progress
5. Track completion via `rd2:tasks` CLI
