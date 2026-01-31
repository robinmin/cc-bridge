---
name: implement_container_agent_script
description: Implement container agent script that runs inside Docker containers to bridge Claude Code with named pipes
status: Backlog
created_at: 2025-01-28
updated_at: 2025-01-28
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: [0031]
tags: [docker, core-integration, p0, agent]
---

## 0032. Implement Container Agent Script

### Background

The cc-bridge server communicates with Docker containers via Named Pipes, but Claude Code inside containers doesn't natively read from or write to FIFO files. We need a lightweight agent script that runs inside the container, reads commands from the input pipe, sends them to Claude Code, captures responses, and writes them to the output pipe.

### Requirements / Objectives

**Functional Requirements:**
- Agent script runs inside Docker containers alongside Claude Code
- Reads commands from input named pipe
- Sends commands to Claude Code (via subprocess or IPC)
- Captures Claude Code responses
- Writes responses to output named pipe
- Handles process lifecycle (start, stop, restart)
- Supports graceful shutdown
- Logs operations for debugging

**Non-Functional Requirements:**
- Minimal resource footprint (CPU, memory)
- Fast startup and shutdown
- Robust error handling
- No dependency conflicts with Claude Code
- Clear separation of concerns

**Acceptance Criteria:**
- [ ] `container-agent.py` script in `cc_bridge/agents/`
- [ ] Reads from input FIFO path
- [ ] Writes to output FIFO path
- [ ] Bridges to Claude Code process
- [ ] Handles SIGTERM/SIGINT gracefully
- [ ] Logs all operations
- [ ] Unit tests for agent logic
- [ ] Integration test with real container

#### Q&A

**Q:** How does the agent communicate with Claude Code inside the container?
**A:** Claude Code runs as a subprocess. The agent can:
1. Spawn Claude Code as a child process and communicate via stdin/stdout
2. Attach to existing Claude Code tmux session (if using tmux in container)
3. Use Claude Code's IPC/API if available

For this implementation, use option 1: Spawn Claude Code and communicate via stdin/stdout pipes. This provides clean control and output capture.

**Q:** What about when Claude Code is already running?
**A:** The agent should detect if Claude Code is already running (via process check) and attach to it. If not running, spawn it. Add a `--attach-only` flag to skip spawning.

**Q:** How do we handle named pipe paths in container?
**A:** Mount host directory containing pipes into container at `/tmp/cc-bridge-pipes`. Use volume mount in docker-compose.yml: `./pipes:/tmp/cc-bridge-pipes:rw`.

**Q:** What if the agent crashes?
**A:** Docker's restart policy will restart the container. The agent should clean up pipes on shutdown and handle reconnection gracefully.

**Q:** Should the agent run as a separate process or be integrated into container entrypoint?
**A:** Run as a separate process via Docker Compose `command` or `entrypoint` override. Use `supervisord` or similar if multiple processes needed. For simplicity, run agent as main process and spawn Claude Code as child.

### Solutions / Goals

**Technology Stack:**
- Python 3.10+ (already in container)
- `asyncio` for concurrent pipe I/O
- `subprocess` for Claude Code process management
- `signal` for graceful shutdown
- Structured logging (same as cc-bridge)

**Implementation Approach:**
1. Create `cc_bridge/agents/container_agent.py` script
2. Implement async pipe reader (input FIFO)
3. Implement async pipe writer (output FIFO)
4. Implement Claude Code process spawner
5. Bridge pipe I/O to process I/O
6. Add signal handling and cleanup
7. Add comprehensive logging

#### Plan

1. **Phase 1** - Agent Structure
   - [ ] Create `cc_bridge/agents/` directory
   - [ ] Create `container_agent.py` script
   - [ ] Add CLI argument parsing (pipe paths, Claude args)
   - [ ] Implement async main function
   - [ ] Add signal handlers (SIGTERM, SIGINT)

2. **Phase 2** - Pipe Reader
   - [ ] Implement async FIFO reader
   - [ ] Open input pipe for reading
   - [ ] Handle pipe empty condition
   - [ ] Buffer partial messages
   - [ ] Detect EOF and shutdown

3. **Phase 3** - Claude Code Process
   - [ ] Implement process spawner
   - [ ] Configure stdin/stdout pipes
   - [ ] Spawn Claude Code with args
   - [ ] Monitor process health
   - [ ] Handle process exit/restart

4. **Phase 4** - Pipe Writer
   - [ ] Implement async FIFO writer
   - [ ] Read from Claude Code stdout
   - [ ] Buffer output
   - [ ] Write to output pipe
   - [ ] Handle pipe full condition

5. **Phase 5** - Bridge Logic
   - [ ] Connect pipe reader → Claude stdin
   - [ ] Connect Claude stdout → pipe writer
   - [ ] Add message buffering
   - [ ] Handle errors in both directions
   - [ ] Implement graceful shutdown

6. **Phase 6** - Testing
   - [ ] Unit test for pipe operations
   - [ ] Unit test for process spawner
   - [ ] Unit test for bridge logic
   - [ ] Integration test with mock pipes
   - [ ] Integration test with real Docker container
   - [ ] Test graceful shutdown
   - [ ] Test error recovery

### References

- Python subprocess documentation: https://docs.python.org/3/library/subprocess.html
- Asyncio streams: https://docs.python.org/3/library/asyncio-stream.html
- Signal handling: https://docs.python.org/3/library/signal.html
- Task 0031: Implement Named Pipe Communication Channel
- Docker Compose command override: https://docs.docker.com/compose/compose-file/compose-file-v3/#command-and-entrypoint
- Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code/overview
