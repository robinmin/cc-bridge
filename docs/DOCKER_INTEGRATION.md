# Docker Integration for cc-bridge

This guide covers the Docker integration features of cc-bridge, which allow you to run Claude Code instances in Docker containers alongside traditional tmux sessions.

## Overview

cc-bridge supports two types of Claude Code instances:
- **tmux instances** - Run Claude Code in tmux sessions on the host system
- **Docker instances** - Run Claude Code in Docker containers with isolated environments

Docker instances provide:
- Isolated development environments
- Consistent dependencies across machines
- Easy cleanup and management
- Support for containerized workflows

## Quick Start

### Prerequisites

1. Install Docker Desktop or Docker Engine
2. Ensure Docker daemon is running: `docker info`
3. Install cc-bridge with Docker support

### Creating a Docker Instance

The easiest way to create a Docker instance is using `docker run` with the appropriate label:

```bash
docker run -d \
  --name claude-dev \
  --label cc-bridge.instance=claude-dev \
  -v $(pwd):/workspace \
  -w /workspace \
  anthropics/claude-code:latest
```

### Discovering Instances

cc-bridge can auto-discover Docker instances:

```bash
# Discover all Docker instances
cc-bridge docker discover

# List all instances (both tmux and Docker)
cc-bridge claude list
```

## Configuration

Add a `[docker]` section to your `~/.claude/bridge/config.toml`:

```toml
[docker]
# Enable Docker instance support
enabled = true

# Default Docker network for containers
network = "claude-network"

# Path pattern for named pipes (used for communication)
named_pipe_path = "/tmp/cc-bridge-{instance}.fifo"

# Auto-discover Docker containers on startup
auto_discovery = true

# Container label for discovery
container_label = "cc-bridge.instance"

# Prefer Docker over tmux for new instances
preferred = false
```

## Docker CLI Commands

cc-bridge provides Docker-specific management commands:

```bash
# List Docker instances
cc-bridge docker list

# Start a stopped container
cc-bridge docker start <instance-name>

# Stop a running container
cc-bridge docker stop <instance-name>

# View container logs
cc-bridge docker logs <instance-name> --follow

# Execute commands in a container
cc-bridge docker exec <instance-name> -- ls -la

# Discover Docker containers
cc-bridge docker discover
```

## Unified Instance Management

The `cc-bridge claude` command works with both tmux and Docker instances:

```bash
# Start an instance (type auto-detected or configured)
cc-bridge claude start my-instance

# List all instances (shows type)
cc-bridge claude list

# Show instance status (type-specific info)
cc-bridge claude status my-instance

# Stop an instance
cc-bridge claude stop my-instance
```

### Type Detection

cc-bridge automatically detects instance types using:
1. Existing instance metadata
2. Docker container discovery
3. Process/tmux session checks
4. Configuration defaults

Force a specific type with the `--type` flag:

```bash
cc-bridge claude start my-instance --type docker
cc-bridge claude start my-instance --type tmux
```

## Communication Architecture

Docker instances communicate with the host using named pipes:

```
┌─────────────────┐
│  cc-bridge     │
│  (host)        │
└────────┬────────┘
         │ Named Pipes
         │ (FIFO)
┌────────▼────────┐
│  Container      │
│  Agent          │
│  (bridge)       │
└────────┬────────┘
         │ stdin/stdout
┌────────▼────────┐
│  Claude Code    │
└─────────────────┘
```

### Named Pipes

Two pipes are used per instance:
- Input pipe: Host writes commands → Container reads
- Output pipe: Container writes responses → Host reads

Pipes are created in `/tmp/cc-bridge-pipes/` by default.

## Docker Compose Integration

Create a `docker-compose.yml` for your Claude Code workspace:

```yaml
version: '3.8'
services:
  claude:
    image: anthropics/claude-code:latest
    container_name: claude-dev
    labels:
      - cc-bridge.instance=claude-dev
    volumes:
      - .:/workspace
    working_dir: /workspace
    # Mount pipes directory
    volumes:
      - ./pipes:/tmp/cc-bridge-pipes:rw
```

Start with:
```bash
docker-compose up -d
cc-bridge docker discover
```

## Troubleshooting

### Docker Not Available

```
❌ Docker is not available. Install Docker to use this command.
```

**Solution:** Install Docker Desktop or Docker Engine and ensure the daemon is running.

### Container Not Found

```
❌ Docker instance 'my-instance' not found.
```

**Solution:** Run `cc-bridge docker discover` or create the container with the `cc-bridge.instance` label.

### Permission Denied

```
❌ Permission denied. Ensure your user has Docker permissions.
```

**Solution:** Add your user to the `docker` group:
```bash
sudo usermod -aG docker $USER
newgrp docker
```

### Communication Issues

If commands are not reaching the container:

1. Check that the container agent is running
2. Verify named pipes exist: `ls -la /tmp/cc-bridge-pipes/`
3. Check container logs: `cc-bridge docker logs <instance>`

## Migration from tmux to Docker

To migrate existing tmux instances to Docker:

1. Create Docker containers with same names
2. Discover instances: `cc-bridge docker discover`
3. Update configuration to prefer Docker: `docker.preferred = true`
4. Stop tmux instances: `cc-bridge claude stop <name> --type tmux`

## Limitations

- The `attach` command only works with tmux instances (use `docker exec` for Docker)
- Named pipes require volume mounts for container access
- Container restart behavior depends on Docker restart policy

## Next Steps

- [Docker Architecture](DOCKER_ARCHITECTURE.md) - Technical details
- [Docker Migration Guide](DOCKER_MIGRATION.md) - Step-by-step migration
- [Configuration Reference](CONFIGURATION.md) - All configuration options
