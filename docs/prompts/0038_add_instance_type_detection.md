---
name: add_instance_type_detection
description: Add instance type detection to automatically identify tmux vs Docker instances
status: Done
created_at: 2025-01-28
updated_at: 2026-02-03 15:02:13
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: [0027, 0029, 0034]
tags: [docker, user-experience, p1, detection]
---

## 0038. Add Instance Type Detection

### Background

To provide a seamless user experience, cc-bridge should automatically detect whether a Claude instance is running in tmux or Docker without requiring explicit configuration. This detection system enables unified management commands and reduces user cognitive load.

### Requirements / Objectives

**Functional Requirements:**
- Detect instance type from existing metadata
- Detect instance type from running processes
- Detect instance type from container discovery
- Handle instances with missing or ambiguous type
- Support manual type override via configuration
- Cache detection results for performance

**Non-Functional Requirements:**
- Fast detection (<100ms per instance)
- Minimal false positives/negatives
- Clear logging of detection process
- Graceful handling of detection failures

**Acceptance Criteria:**
- [ ] `detect_instance_type(name)` function implemented
- [ ] Checks existing instance metadata first
- [ ] Falls back to process/container detection
- [ ] Handles ambiguous cases with heuristics
- [ ] Caches results for performance
- [ ] Logs detection decisions
- [ ] Unit tests for detection logic
- [ ] Integration test with both types

#### Q&A

**Q:** What are the detection heuristics?
**A:** Priority order:
1. **Metadata check**: If instance in instances.json has `instance_type` field, use it
2. **Container check**: Query Docker for container with name/label matching instance name
3. **Process check**: Look for `claude` process with session name
4. **Configuration fallback**: Use `docker.preferred` config
5. **Default**: Assume tmux for backward compatibility

**Q:** What about name conflicts between tmux and Docker?
**A:** If both exist for the same name, use priority:
1. If instance metadata exists, use that type
2. If Docker container found, prefer Docker (more specific)
3. Otherwise use tmux
Log a warning about the conflict.

**Q:** How do we handle false detection?
**A:** Add `--type` flag to commands for manual override. Add `cc-bridge claude fix-type <name> <type>` command to correct metadata. Log detection confidence level.

**Q:** Should detection run on every operation?
**A:** No, cache results. Refresh on:
- Instance state change (start/stop)
- Explicit `cc-bridge claude refresh` command
- Cache TTL expiration (default: 5 minutes)
- Detection failure (retry immediately)

**Q:** What about new instances that don't exist yet?
**A:** Use configuration to determine type for new instances (see task 0037). Detection only applies to existing instances.

### Solutions / Goals

**Technology Stack:**
- Docker Python SDK for container detection
- Process inspection (`psutil` or `subprocess`)
- Instance metadata (instances.json)
- Configuration defaults
- Simple caching with TTL

**Implementation Approach:**
1. Create `InstanceTypeDetector` class
2. Implement metadata check
3. Implement container detection
4. Implement process detection
5. Add heuristic resolution
6. Add caching layer
7. Integrate with CLI and server

#### Plan

1. **Phase 1** - Detector Class
   - [ ] Create `cc_bridge/core/instance_detector.py`
   - [ ] Define `InstanceTypeDetector` class
   - [ ] Add detection methods
   - [ ] Add caching layer
   - [ ] Add logging infrastructure

2. **Phase 2** - Metadata Detection
   - [ ] Implement `detect_from_metadata(name)`
   - [ ] Load instance from instances.json
   - [ ] Check for `instance_type` field
   - [ ] Validate type value
   - [ ] Return result with confidence

3. **Phase 3** - Container Detection
   - [ ] Implement `detect_from_container(name)`
   - [ ] Query Docker for container by name
   - [ ] Query Docker for container by label
   - [ ] Check container is running
   - [ ] Return result with confidence

4. **Phase 4** - Process Detection
   - [ ] Implement `detect_from_process(name)`
   - [ ] Check for tmux session
   - [ ] Check for Claude process with session name
   - [ ] Verify process is active
   - [ ] Return result with confidence

5. **Phase 5** - Heuristic Resolution
   - [ ] Implement `detect(name)` main method
   - [ ] Combine all detection methods
   - [ ] Apply priority order
   - [ ] Handle conflicts
   - [ ] Return final type with confidence

6. **Phase 6** - Caching
   - [ ] Implement cache with TTL
   - [ ] Add cache invalidation
   - [ ] Add manual refresh method
   - [ ] Track cache hits/misses
   - [ ] Log cache statistics

7. **Phase 7** - Integration
   - [ ] Integrate with InstanceManager
   - [ ] Integrate with CLI commands
   - [ ] Add `refresh` CLI command
   - [ ] Add `fix-type` CLI command
   - [ ] Update server to use detector

8. **Phase 8** - Testing
   - [ ] Unit test for metadata detection
   - [ ] Unit test for container detection
   - [ ] Unit test for process detection
   - [ ] Unit test for heuristic resolution
   - [ ] Unit test for caching
   - [ ] Integration test with tmux
   - [ ] Integration test with Docker
   - [ ] Test conflict resolution

### References

- Docker SDK containers: https://docker-py.readthedocs.io/en/stable/containers.html
- Process inspection: https://psutil.readthedocs.io/
- Tmux session detection: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/tmux.py`
- InstanceManager: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/instances.py`
- Task 0027: Extend ClaudeInstance Model for Docker Support
- Task 0029: Implement Docker Container Discovery
- Task 0034: Update InstanceManager for Docker Instances
