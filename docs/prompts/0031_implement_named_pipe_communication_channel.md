---
name: implement_named_pipe_communication_channel
description: Implement Named Pipe (FIFO) communication channel for Docker container I/O
status: Backlog
created_at: 2025-01-28
updated_at: 2025-01-28
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
dependencies: [0026, 0028, 0030]
tags: [docker, core-integration, p0, communication]
---

## 0031. Implement Named Pipe Communication Channel

### Background

Docker containers run in isolated filesystems, making direct tmux session interaction impossible. To communicate with Claude Code running inside containers, we need a Named Pipe (FIFO) based communication channel. This allows bi-directional communication between the host system (cc-bridge server) and the containerized Claude Code instance.

### Requirements / Objectives

**Functional Requirements:**
- Create Named Pipe (FIFO) for host-container communication
- Support bi-directional message passing (commands → container, responses ← container)
- Handle concurrent access and synchronization
- Support multiple named pipes for multiple instances
- Clean up pipes when instances stop
- Handle pipe creation failures gracefully

**Non-Functional Requirements:**
- Low latency for real-time interaction
- Thread-safe operations
- Proper error handling and recovery
- Clear logging for debugging
- No resource leaks (unlinked pipes)

**Acceptance Criteria:**
- [ ] `NamedPipeChannel` class in `cc_bridge/core/named_pipe.py`
- [ ] Creates FIFO at configured path
- [ ] Writes commands to pipe (non-blocking)
- [ ] Reads responses from pipe (async)
- [ ] Handles pipe full/empty conditions
- [ ] Cleans up pipes on close
- [ ] Thread-safe operations
- [ ] Unit tests for pipe operations
- [ ] Integration test with Docker container

#### Q&A

**Q:** Why Named Pipes instead of Docker exec?
**A:** Named Pipes provide persistent, low-overhead communication channel. Docker exec creates a new process each time, which is slower and doesn't maintain session state. Named Pipes are also more flexible for bi-directional streaming.

**Q:** How do we handle bi-directional communication with a single pipe?
**A:** Use two pipes per instance:
- `{instance_name}.in.fifo` - Host writes commands, container reads
- `{instance_name}.out.fifo` - Container writes responses, host reads

**Q:** What about named pipe permissions?
**A:** Create pipes with mode 0660 (read/write for owner and group). Ensure the container user has appropriate permissions via group membership or user UID mapping.

**Q:** How do we handle pipe buffer limits?
**A:** Use non-blocking I/O with select/poll for reads. Write in chunks if pipe buffer is full. Log warnings when buffer approaches capacity.

**Q:** What happens if the container exits unexpectedly?
**A:** Pipe reads will return EOF (0 bytes). Detect this and mark instance as stopped. Clean up pipes and notify user.

### Solutions / Goals

**Technology Stack:**
- Python `os.mkfifo()` for pipe creation
- `asyncio` with `os.open()` for async I/O
- `fcntl` for non-blocking mode
- `select` or `asyncio` for event-driven reads
- Configuration from `[docker]` section

**Implementation Approach:**
1. Create `NamedPipeChannel` class
2. Implement pipe creation (input + output)
3. Implement async write method for commands
4. Implement async read method for responses
5. Add buffer management and flow control
6. Implement cleanup and error handling
7. Add logging and monitoring

#### Plan

1. **Phase 1** - Pipe Creation
   - [ ] Create `NamedPipeChannel` class
   - [ ] Implement `__init__` with instance name
   - [ ] Create input FIFO path
   - [ ] Create output FIFO path
   - [ ] Set permissions (0660)
   - [ ] Handle existing pipes (delete or reuse)

2. **Phase 2** - Write Operations
   - [ ] Implement `async write_command(text: str)`
   - [ ] Open pipe for writing (non-blocking)
   - [ ] Handle pipe full condition
   - [ ] Write in chunks if needed
   - [ ] Add write timeout
   - [ ] Close pipe after write

3. **Phase 3** - Read Operations
   - [ ] Implement `async read_response() -> AsyncIterator[str]`
   - [ ] Open pipe for reading (non-blocking)
   - [ ] Use select/asyncio for event-driven reads
   - [ ] Buffer partial reads
   - [ ] Detect EOF (container exit)
   - [ ] Handle pipe empty condition

4. **Phase 4** - Buffer Management
   - [ ] Implement read buffer
   - [ ] Parse message boundaries
   - [ ] Handle partial messages
   - [ ] Add flow control
   - [ ] Log buffer statistics

5. **Phase 5** - Cleanup and Error Handling
   - [ ] Implement `close()` method
   - [ ] Unlink FIFO files
   - [ ] Handle pipe creation errors
   - [ ] Handle I/O errors gracefully
   - [ ] Log all errors with context

6. **Phase 6** - Testing
   - [ ] Unit test for pipe creation
   - [ ] Unit test for write operations
   - [ ] Unit test for read operations
   - [ ] Unit test for buffer management
   - [ ] Unit test for cleanup
   - [ ] Integration test with mock container
   - [ ] Integration test with real Docker container

### References

- Python FIFO documentation: https://docs.python.org/3/library/os.html#os.mkfifo
- Named pipes on Linux: https://man7.org/linux/man-pages/man7/fifo.7.html
- Non-blocking I/O: https://docs.python.org/3/library/asyncio-stream.html
- Docker volume mounts: https://docs.docker.com/storage/volumes/
- Task 0028: Create Docker Configuration Section
- Task 0030: Create Abstract InstanceInterface
- Communication pattern reference: https://docs.docker.com/engine/reference/run/#ipc-settings---ipc
