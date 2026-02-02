# FIFO Mode - Docker Daemon Communication

## Overview

cc-bridge supports two communication modes for Docker-based Claude Code instances:

### Exec Mode (Legacy)
- One-shot commands via `docker exec`
- Spawns a new process for each command
- Simple but higher overhead
- Default for backward compatibility

### FIFO Mode (Daemon)
- Persistent background process in container
- Bidirectional named pipes (FIFOs) for communication
- Lower latency and overhead
- Supports session tracking and health monitoring
- Recommended for production use

## Configuration

### Setting Communication Mode

The communication mode can be configured in `~/.config/cc-bridge/config.yaml`:

```yaml
docker:
  # Communication mode: "fifo" (daemon) or "exec" (legacy)
  communication_mode: fifo

  # Directory for FIFO pipes (fifo mode only)
  pipe_dir: /tmp/cc-bridge/pipes

  # Session tracking settings
  session:
    idle_timeout: 300  # seconds
    request_timeout: 120  # seconds
    max_history: 100  # max conversation turns to keep

  # Health monitoring settings
  health:
    enabled: true
    check_interval: 30  # seconds
    max_consecutive_failures: 3
    recovery_delay: 5  # seconds
```

### Instance-Level Configuration

When adding instances via `cc-bridge docker add`, you can specify the mode:

```bash
# Add instance with FIFO mode (default)
cc-bridge docker add my-instance --mode fifo

# Add instance with exec mode (legacy)
cc-bridge docker add my-instance --mode exec
```

## FIFO Mode Details

### How It Works

1. **Container Agent**: When a FIFO-mode instance starts, cc-bridge launches a persistent `container_agent.py` script inside the container
2. **Named Pipes**: Two FIFO pipes are created on the host:
   - `{instance_name}.in.fifo` - Host → Container (commands)
   - `{instance_name}.out.fifo` - Container → Host (responses)
3. **Session Tracking**: Each request is tracked with a UUID for correlation
4. **Health Monitoring**: Background process monitors container and pipe health

### Benefits

- **Lower Latency**: No process spawning overhead
- **Session Persistence**: Conversation history maintained
- **Health Monitoring**: Automatic recovery from failures
- **Better Resource Usage**: Single persistent process vs many exec calls

### Requirements

- Docker with volume mounts for pipe directory
- Write access to pipe directory
- `mkfifo` command available on host

## Troubleshooting

### FIFO Pipes Not Found

```bash
# Check if pipes exist
ls -la /tmp/cc-bridge/pipes/*.fifo

# Check pipe directory permissions
ls -ld /tmp/cc-bridge/pipes
```

### Container Agent Not Running

```bash
# Check if agent process is running in container
docker exec <container_id> ps aux | grep container_agent

# Restart the instance
cc-bridge docker restart <instance_name>
```

### Health Check Failures

```bash
# Run health checks
cc-bridge health

# Check specific instance health
cc-bridge docker status <instance_name>
```

## Migration from Exec to FIFO Mode

See [Migration Guide](migration-guide.md) for detailed instructions.
