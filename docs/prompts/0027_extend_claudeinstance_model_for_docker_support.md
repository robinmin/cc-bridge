---
name: extend_claudeinstance_model_for_docker_support
description: Extend ClaudeInstance model to support Docker containers alongside tmux sessions
status: Backlog
created_at: 2025-01-28
updated_at: 2025-01-28
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: [0026]
tags: [docker, foundation, p0, data-model]
---

## 0027. Extend ClaudeInstance Model for Docker Support

### Background

The current `ClaudeInstance` model in `/Users/robin/xprojects/cc-bridge/cc_bridge/models/instances.py` is designed exclusively for tmux-based instances with fields like `tmux_session` and `pid`. To support Docker-based instances, we need to extend this model to accommodate both instance types while maintaining backward compatibility.

### Requirements / Objectives

**Functional Requirements:**
- Add Docker-specific fields to `ClaudeInstance` model
- Support both tmux and Docker instance types
- Maintain backward compatibility with existing tmux instances
- Enable type-safe instance type discrimination
- Support instance type detection and validation

**Non-Functional Requirements:**
- No breaking changes to existing tmux instance data
- Clean separation between tmux and Docker attributes
- Proper Pydantic validation for Docker fields
- Clear documentation on field usage per instance type

**Acceptance Criteria:**
- [ ] `instance_type` field added ("tmux" | "docker")
- [ ] Docker-specific fields added (container_id, container_name, image_name)
- [ ] Existing tmux fields remain optional and backward compatible
- [ ] Pydantic model validates instance type consistency
- [ ] Migration path documented for existing instances
- [ ] All existing tests pass without modification

#### Q&A

**Q:** How do we handle instance type discrimination?
**A:** Add a literal `instance_type` field with values "tmux" or "docker". Use Pydantic's discriminated unions or field validators to ensure Docker fields are only populated for Docker instances.

**Q:** Should we create separate models or extend the existing one?
**A:** Extend the existing model with optional Docker fields. Use a base class approach or discriminated union if type safety becomes complex. For now, optional fields with validators is simpler and maintains backward compatibility.

**Q:** What about existing instance data in `instances.json`?
**A:** Make Docker fields optional with default `None`. Existing tmux instances will load without Docker fields, and new Docker instances will have them populated.

### Solutions / Goals

**Technology Stack:**
- Pydantic v2 for data modeling and validation
- Literal types for instance_type field
- Field validators for consistency checks

**Implementation Approach:**
1. Add `instance_type: Literal["tmux", "docker"]` field with default "tmux"
2. Add Docker-specific optional fields:
   - `container_id: str | None`
   - `container_name: str | None`
   - `image_name: str | None`
   - `docker_network: str | None`
3. Add field validator to ensure Docker fields consistent with instance_type
4. Update model documentation and examples
5. Add migration notes for existing data

#### Plan

1. **Phase 1** - Model Extension
   - [ ] Import `Literal` from `typing`
   - [ ] Add `instance_type` field with default "tmux"
   - [ ] Add Docker-specific optional fields
   - [ ] Add field validators for consistency

2. **Phase 2** - Validation Logic
   - [ ] Implement validator for Docker instance fields
   - [ ] Ensure tmux instances don't have Docker fields populated
   - [ ] Ensure Docker instances have required Docker fields
   - [ ] Add helpful error messages for validation failures

3. **Phase 3** - Testing
   - [ ] Unit test for tmux instance creation
   - [ ] Unit test for Docker instance creation
   - [ ] Unit test for validation errors (mixed types)
   - [ ] Unit test for backward compatibility (loading old instances)
   - [ ] Integration test with instances.json persistence

4. **Phase 4** - Documentation
   - [ ] Update model docstrings
   - [ ] Add examples for both instance types
   - [ ] Document migration path
   - [ ] Update reference documentation

### References

- Pydantic documentation: https://docs.pydantic.dev/latest/
- Current model: `/Users/robin/xprojects/cc-bridge/cc_bridge/models/instances.py`
- Docker container fields reference: https://docs.docker.com/engine/api/sdk/
- Task 0026: Add Docker Python SDK Dependency (prerequisite)
- Task 0025: Add Docker Support (parent task)
