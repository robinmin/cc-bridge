---
name: create_docker_configuration_section
description: Add Docker configuration section to support Docker-based Claude instances
status: Done
created_at: 2025-01-28
updated_at: 2026-02-03 15:00:49
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: [0026, 0027]
tags: [docker, foundation, p0, configuration]
---

## 0028. Create Docker Configuration Section

### Background

The cc-bridge server uses a TOML-based configuration system managed by `cc_bridge/config.py`. To support Docker-based Claude instances, we need to extend the configuration schema to include Docker-specific settings while maintaining backward compatibility with tmux-only configurations.

### Requirements / Objectives

**Functional Requirements:**
- Add `[docker]` section to configuration schema
- Support Docker daemon connection settings
- Configure default Docker network for containers
- Configure named pipe path for container communication
- Support container discovery filters
- Provide sensible defaults for all Docker settings

**Non-Functional Requirements:**
- No breaking changes to existing configurations
- Clear documentation for all Docker settings
- Validation of Docker configuration values
- Environment variable override support

**Acceptance Criteria:**
- [ ] `[docker]` configuration section defined
- [ ] Default values provided for all settings
- [ ] Configuration validation implemented
- [ ] Environment variable override support
- [ ] Documentation updated with Docker config examples
- [ ] Existing configurations load without errors

#### Q&A

**Q:** What Docker configuration settings are needed?
**A:**
- `enabled`: bool - Enable Docker instance support (default: true)
- `network`: str - Docker network name (default: "claude-network")
- `named_pipe_path`: str - Path for FIFO communication (default: "/tmp/cc-bridge-{instance}.fifo")
- `auto_discovery`: bool - Auto-discover Docker containers (default: true)
- `container_label`: str - Label filter for discovery (default: "cc-bridge.instance")

**Q:** How do we handle backward compatibility?
**A:** Make the entire `[docker]` section optional. If missing, use default values. Log a warning if Docker is referenced but not configured.

**Q:** Should Docker daemon connection settings be configurable?
**A:** For now, use Docker SDK's default connection (Unix socket at `/var/run/docker.sock`). Advanced socket/path configuration can be added later if needed via `DOCKER_HOST` environment variable (Docker SDK standard).

### Solutions / Goals

**Technology Stack:**
- Existing TOML configuration system
- Python's `os.environ` for environment variable overrides
- Pydantic for configuration validation

**Implementation Approach:**
1. Extend configuration schema with `[docker]` section
2. Add default values for all Docker settings
3. Implement configuration validation
4. Add environment variable override support
5. Update configuration documentation
6. Add examples for Docker configurations

#### Plan

1. **Phase 1** - Schema Definition
   - [ ] Define Docker configuration structure
   - [ ] Add default values
   - [ ] Document each configuration option
   - [ ] Add type hints for validation

2. **Phase 2** - Configuration Loading
   - [ ] Extend `get_config()` to handle `[docker]` section
   - [ ] Implement graceful fallback to defaults
   - [ ] Add validation logic
   - [ ] Support environment variable overrides

3. **Phase 3** - Validation
   - [ ] Validate network name format
   - [ ] Validate named pipe path format
   - [ ] Validate boolean settings
   - [ ] Provide helpful error messages

4. **Phase 4** - Testing
   - [ ] Unit test for default configuration loading
   - [ ] Unit test for custom configuration loading
   - [ ] Unit test for environment variable overrides
   - [ ] Unit test for validation errors
   - [ ] Integration test with config file

5. **Phase 5** - Documentation
   - [ ] Update configuration reference
   - [ ] Add Docker configuration examples
   - [ ] Document environment variables
   - [ ] Add troubleshooting section

### References

- Current config module: `/Users/robin/xprojects/cc-bridge/cc_bridge/config.py`
- TOML specification: https://toml.io/en/
- Environment variable patterns: https://docs.pydantic.dev/latest/concepts/pydantic_settings/
- Docker daemon configuration: https://docs.docker.com/engine/reference/commandline/cli/#daemon-socket-option
- Task 0026: Add Docker Python SDK Dependency
- Task 0027: Extend ClaudeInstance Model for Docker Support
