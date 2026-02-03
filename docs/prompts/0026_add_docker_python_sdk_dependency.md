---
name: add_docker_python_sdk_dependency
description: Add Docker Python SDK dependency to enable programmatic Docker container management
status: Done
created_at: 2025-01-28
updated_at: 2026-02-03 15:02:51
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: []
tags: [docker, foundation, p0]
---

## 0026. Add Docker Python SDK Dependency

### Background

The cc-bridge server currently manages Claude Code instances exclusively through tmux sessions. To support Docker-based instances, we need the ability to programmatically interact with Docker containers. The Docker Python SDK provides the necessary API for container lifecycle management, including discovery, status checking, and command execution.

### Requirements / Objectives

**Functional Requirements:**
- Add `docker` Python package as a project dependency
- Ensure compatibility with Python 3.10+ and existing dependencies
- Maintain backward compatibility with tmux-based instances
- Support optional Docker installation (not required for tmux-only usage)

**Non-Functional Requirements:**
- Minimal version constraint (>=6.0.0 for stable API)
- Clean separation between Docker and tmux code paths
- No breaking changes to existing functionality
- Clear documentation on Docker SDK requirements

**Acceptance Criteria:**
- [ ] `docker` package added to `pyproject.toml` dependencies
- [ ] Version constraint specified and tested
- [ ] Existing tests still pass without Docker installed
- [ ] Documentation updated with Docker SDK requirements
- [ ] No import errors when Docker SDK is optional

#### Q&A

**Q:** Should Docker SDK be a required or optional dependency?
**A:** Make it a required dependency but handle `ImportError` gracefully if Docker is not installed on the host system. This allows Docker features to be available when Docker is present but doesn't break the system for tmux-only users.

**Q:** What version of Docker SDK should we use?
**A:** Use `docker>=7.0.0,<8.0.0` to ensure API stability while allowing patch updates.

### Solutions / Goals

**Technology Stack:**
- `docker` Python SDK (https://docker-py.readthedocs.io/)
- Existing `pyproject.toml` configuration

**Implementation Approach:**
1. Add `docker` package to dependencies in `pyproject.toml`
2. Create a Docker compatibility module that handles import errors
3. Add environment detection for Docker availability
4. Update documentation with installation requirements
5. Add unit tests for Docker SDK availability detection

#### Plan

1. **Phase 1** - Dependency Addition
   - [ ] Add `docker>=7.0.0,<8.0.0` to `pyproject.toml`
   - [ ] Update lockfile if using uv lock
   - [ ] Verify installation in development environment

2. **Phase 2** - Compatibility Layer
   - [ ] Create `cc_bridge/core/docker_compat.py` module
   - [ ] Implement graceful import error handling
   - [ ] Add `is_docker_available()` function
   - [ ] Add logging for Docker availability status

3. **Phase 3** - Testing
   - [ ] Unit test for Docker availability detection
   - [ ] Unit test for graceful degradation when Docker missing
   - [ ] Integration test with Docker installed
   - [ ] Integration test without Docker installed

4. **Phase 4** - Documentation
   - [ ] Update README.md with Docker requirements
   - [ ] Add Docker SDK installation notes
   - [ ] Document optional Docker feature behavior

### References

- Docker SDK for Python: https://docker-py.readthedocs.io/
- Task 0025: Add Docker Support (parent task)
- `/Users/robin/xprojects/cc-bridge/pyproject.toml`
- Docker container detection patterns: https://docs.docker.com/engine/api/sdk/examples/
