---
name: add_docker_instance_cli_commands
description: Add Docker-specific CLI commands for managing Docker-based Claude instances
status: Backlog
created_at: 2025-01-28
updated_at: 2025-01-28
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: [0029, 0034]
tags: [docker, user-experience, p1, cli]
---

## 0036. Add Docker Instance CLI Commands

### Background

The cc-bridge CLI currently has commands for managing tmux-based instances (`cc-bridge claude start`, `cc-bridge claude stop`, etc.). To provide a complete user experience for Docker instances, we need to add Docker-specific commands that mirror the tmux functionality while accounting for Docker-specific operations.

### Requirements / Objectives

**Functional Requirements:**
- Add `cc-bridge docker start` command to start Docker instances
- Add `cc-bridge docker stop` command to stop Docker instances
- Add `cc-bridge docker list` command to list Docker instances
- Add `cc-bridge docker logs` command to view container logs
- Add `cc-bridge docker exec` command to execute commands in containers
- Add `cc-bridge docker discover` command to discover containers
- Support instance name parameters
- Support filtering options

**Non-Functional Requirements:**
- Consistent interface with tmux commands
- Clear help text and examples
- Proper error handling and messages
- Tab completion support (if possible)
- Colorized output for readability

**Acceptance Criteria:**
- [ ] `cc-bridge docker` command group added
- [ ] All subcommands implemented
- [ ] Help text and examples provided
- [ ] Error handling for missing Docker
- [ ] Integration with InstanceManager
- [ ] Unit tests for CLI commands
- [ ] Documentation updated

#### Q&A

**Q:** Should we create a separate `docker` command group or extend `claude` command?
**A:** Create separate `docker` command group for clarity. This makes it explicit that Docker operations are separate from tmux operations. Users can use `cc-bridge docker` for Docker-specific management and `cc-bridge claude` for tmux.

**Q:** What about `cc-bridge claude start` - should it auto-detect instance type?
**A:** Yes, in task 0037 we'll integrate instance type detection. For now, keep commands separate. The `docker` commands are explicitly for Docker instances.

**Q:** How do we handle Docker Compose vs docker run?
**A:** Support both: `cc-bridge docker start` can:
1. Start existing stopped container (docker start)
2. Start new container via docker-compose (if compose file exists)
Add flags: `--compose` to use docker-compose, `--run` to use docker run.

**Q:** What about instance creation vs starting?
**A:** Separate concerns:
- `cc-bridge docker create` - Create new container (calls docker-compose up -d or docker run)
- `cc-bridge docker start` - Start existing stopped container
- `cc-bridge docker stop` - Stop running container

**Q:** Should we support batch operations?
**A:** Yes, add `--all` flag to operate on all Docker instances. Add `--filter` flag to filter by status, image, etc.

### Solutions / Goals

**Technology Stack:**
- Typer for CLI framework
- Docker Python SDK
- InstanceManager for state management
- Existing CLI patterns from `cc-bridge claude`

**Implementation Approach:**
1. Create `docker` command group
2. Implement `start` subcommand
3. Implement `stop` subcommand
4. Implement `list` subcommand
5. Implement `logs` subcommand
6. Implement `exec` subcommand
7. Implement `discover` subcommand
8. Add help text and examples
9. Add error handling

#### Plan

1. **Phase 1** - Command Group
   - [ ] Create `cc_bridge/commands/docker_cmd.py`
   - [ ] Define `docker` Typer app
   - [ ] Add to main CLI app
   - [ ] Add common options (verbose, help)
   - [ ] Add Docker availability check

2. **Phase 2** - Start Command
   - [ ] Implement `cc-bridge docker start [name]`
   - [ ] Support starting stopped container
   - [ ] Add `--compose` flag for docker-compose
   - [ ] Add `--create` flag to create if not exists
   - [ ] Add `--detach` flag for background
   - [ ] Handle start errors

3. **Phase 3** - Stop Command
   - [ ] Implement `cc-bridge docker stop [name]`
   - [ ] Support graceful shutdown (SIGTERM)
   - [ ] Add `--force` flag for SIGKILL
   - [ ] Add `--all` flag for all instances
   - [ ] Update InstanceManager status

4. **Phase 4** - List Command
   - [ ] Implement `cc-bridge docker list`
   - [ ] Show all Docker instances
   - [ ] Display instance metadata
   - [ ] Add `--filter` option
   - [ ] Add `--json` output format
   - [ ] Colorize output

5. **Phase 5** - Logs Command
   - [ ] Implement `cc-bridge docker logs [name]`
   - [ ] Stream container logs
   - [ ] Add `--follow` flag
   - [ ] Add `--tail` flag
   - [ ] Add `--since` flag
   - [ ] Handle log errors

6. **Phase 6** - Exec Command
   - [ ] Implement `cc-bridge docker exec [name] -- [command]`
   - [ ] Execute command in container
   - [ ] Support interactive mode
   - [ ] Handle exec errors
   - [ ] Add examples for common commands

7. **Phase 7** - Discover Command
   - [ ] Implement `cc-bridge docker discover`
   - [ ] Trigger DockerDiscoverer
   - [ ] Display discovered instances
   - [ ] Add `--auto` flag for auto-refresh
   - [ ] Update InstanceManager

8. **Phase 8** - Testing
   - [ ] Unit test for start command
   - [ ] Unit test for stop command
   - [ ] Unit test for list command
   - [ ] Unit test for logs command
   - [ ] Unit test for exec command
   - [ ] Unit test for discover command
   - [ ] Integration test with Docker

### References

- Existing CLI: `/Users/robin/xprojects/cc-bridge/cc_bridge/cli.py`
- Existing claude commands: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/claude_cmd.py`
- Typer documentation: https://typer.tiangolo.com/
- Docker CLI reference: https://docs.docker.com/engine/reference/commandline/cli/
- Task 0029: Implement Docker Container Discovery
- Task 0034: Update InstanceManager for Docker Instances
