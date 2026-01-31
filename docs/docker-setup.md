# Docker Setup Guide for cc-bridge

This guide explains how to run Claude Code in a Docker container using cc-bridge. Docker provides isolation and security boundaries for agentic workflows with `--dangerously-skip-permissions`.

## Why Docker?

Docker deployment offers several advantages:

- **Isolated environment** - No dependency conflicts with host system
- **Reproducible builds** - Same environment across development and production
- **Security** - Container boundaries limit what code can access
- **Easy deployment** - Single command to start the entire stack
- **Clean teardown** - Remove container and all changes are discarded

## Prerequisites

### Required Software

1. **OrbStack** (recommended for macOS) or Docker Desktop
   - OrbStack: https://orbstack.dev/
   - Faster and lighter than Docker Desktop for macOS
   - Install: `brew install orbstack`

2. **Claude Code** - Must be installed on your host system
   - The Docker container mounts your host's Claude Code

### Verify OrbStack is Running

```bash
# Start OrbStack (if not running)
orb start

# Verify Docker is available
docker --version
docker-compose --version
```

## Quick Start

### 1. Set Environment Variables

Create a `.env` file in the project root:

```bash
# Authentication: Set ONE of the following (required for Claude Code)
# Option 1: API key authentication
ANTHROPIC_API_KEY=sk-ant-xxxxx
# Option 2: OAuth/session token authentication
# ANTHROPIC_AUTH_TOKEN=your-auth-token

# Optional: Custom API base URL (for alternative LLM providers)
# Leave empty to use official Anthropic API
# Examples:
#   - OpenRouter: https://openrouter.ai/api/v1
#   - Local LLM: http://localhost:11434/v1
#   - Custom proxy: https://your-proxy.example.com/v1
ANTHROPIC_BASE_URL=

# Optional: Project name (defaults to cc-bridge)
PROJECT_NAME=my-project
```

### 2. Start the Container

```bash
# Start OrbStack (if not running)
orb start

# Build and start the container
docker-compose up -d

# View logs
docker-compose logs -f
```

### 3. Stop the Container

```bash
# Stop the container
docker-compose down

# Stop and remove volumes (discard all changes)
docker-compose down -v
```

## Docker Compose Configuration

### Default Configuration

The `docker-compose.yml` file provides sensible defaults:

```yaml
services:
  claude-agent:
    container_name: claude-${PROJECT_NAME:-cc-bridge}
    volumes:
      - ${HOME}/.claude:/home/vscode/.claude:ro  # Read-only config
      - .:/workspaces/${PROJECT_NAME:-cc-bridge}  # Project workspace
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN:-}
      - ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-}
    command: claude --dangerously-skip-permissions
```

### Volume Mounts

| Volume | Purpose | Access | Host Path | Container Path |
|--------|---------|--------|-----------|----------------|
| Claude Config | Mount global Claude configuration | Read-only | `${HOME}/.claude` | `/home/vscode/.claude` |
| Project Workspace | Mount current project folder | Read-write | `.` (current dir) | `/workspaces/{PROJECT_NAME}` |

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | One of these | - | API key authentication |
| `ANTHROPIC_AUTH_TOKEN` | One of these | - | OAuth/session token authentication |
| `ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com` | Custom API base URL for alternative LLM providers |
| `PROJECT_NAME` | No | `cc-bridge` | Name for container and workspace |

## Usage Examples

### Example 1: Basic Usage

```bash
# Set project name
export PROJECT_NAME=my-app

# Start container
docker-compose up -d

# Attach to container (interactive)
docker-compose exec claude-agent bash

# Inside container, Claude Code is already running
# You can interact with it via the CLI
```

### Example 2: Custom Working Directory

```bash
# Set PROJECT_NAME to match your project
export PROJECT_NAME=my-custom-project

# The workspace will be mounted at /workspaces/my-custom-project
docker-compose up -d
```

### Example 3: Development Workflow

```bash
# 1. Make changes to your code locally
vim cc_bridge/core/claude.py

# 2. Restart container to pick up changes
docker-compose restart

# 3. View logs to verify
docker-compose logs -f
```

### Example 4: Using Alternative LLM Providers

The Docker setup supports alternative LLM providers through the `ANTHROPIC_BASE_URL` environment variable.

> **Note:** For alternative providers, use `ANTHROPIC_API_KEY`. For official Anthropic API, you can use either `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`.

```bash
# Using OpenRouter
cat > .env << EOF
ANTHROPIC_API_KEY=sk-or-xxxxx
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
PROJECT_NAME=my-project
EOF

docker-compose up -d

# Using local LLM (e.g., Ollama)
cat > .env << EOF
ANTHROPIC_API_KEY=ollama
ANTHROPIC_BASE_URL=http://host.docker.internal:11434/v1
PROJECT_NAME=my-project
EOF

docker-compose up -d

# Using custom proxy
cat > .env << EOF
ANTHROPIC_API_KEY=sk-ant-xxxxx
ANTHROPIC_BASE_URL=https://your-proxy.example.com/v1
PROJECT_NAME=my-project
EOF

docker-compose up -d
```

**Note:** When using alternative providers, ensure they are compatible with the Anthropic API format.

## OrbStack Integration

### Starting OrbStack

```bash
# Start OrbStack Docker daemon
orb start

# Verify Docker is available
docker ps
```

### Stopping OrbStack

```bash
# Stop OrbStack (shuts down all containers)
orb stop
```

### Checking Status

```bash
# Check OrbStack status
orb status

# List running containers
docker ps
```

## Container Management

### View Container Status

```bash
# Check if container is running
docker-compose ps

# Detailed container info
docker inspect claude-${PROJECT_NAME:-cc-bridge}
```

### View Logs

```bash
# Follow logs in real-time
docker-compose logs -f claude-agent

# View last 100 lines
docker-compose logs --tail=100 claude-agent
```

### Execute Commands in Container

```bash
# Open interactive shell
docker-compose exec claude-agent bash

# Run single command
docker-compose exec claude-agent ls -la

# Check Claude Code version
docker-compose exec claude-agent claude --version
```

### Rebuild Container

```bash
# Rebuild image (after changing Dockerfile)
docker-compose build --no-cache

# Rebuild and restart
docker-compose up -d --build
```

## Troubleshooting

### Container Won't Start

**Problem:** Container exits immediately after starting.

**Solutions:**

```bash
# Check logs for errors
docker-compose logs claude-agent

# Verify environment variables are set
docker-compose config

# Check if OrbStack is running
orb status
```

### Permission Denied Errors

**Problem:** Container can't access mounted volumes.

**Solutions:**

```bash
# Check volume permissions on host
ls -la ${HOME}/.claude
ls -la .

# Fix permissions if needed
chmod 755 ${HOME}/.claude
chmod 755 .
```

### Claude Code Not Found

**Problem:** `claude: command not found` error.

**Solutions:**

```bash
# Verify Claude Code is installed on host
which claude

# Check if it's mounted correctly in container
docker-compose exec claude-agent which claude

# Rebuild container with correct mount
docker-compose down
docker-compose up -d --build
```

### Authentication Issues

**Problem:** `ANTHROPIC_API_KEY not set` or invalid authentication.

**Solutions:**

You need ONE of the following authentication methods:
- `ANTHROPIC_API_KEY`: API key authentication (sent as `X-Api-Key` header)
- `ANTHROPIC_AUTH_TOKEN`: OAuth/token authentication (sent as `Authorization: Bearer` header)

```bash
# Verify .env file exists
cat .env

# Check environment variables in container
docker-compose exec claude-agent env | grep ANTHROPIC

# Test API key manually (if using ANTHROPIC_API_KEY)
export ANTHROPIC_API_KEY=sk-ant-xxxxx
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'
```

### OrbStack Issues

**Problem:** Docker commands fail with "daemon not running".

**Solutions:**

```bash
# Start OrbStack
orb start

# Check OrbStack status
orb status

# Restart OrbStack if needed
orb restart

# If all else fails, restart Docker daemon
orb stop
orb start
```

### Health Check Failing

**Problem:** Container marked as unhealthy.

**Solutions:**

```bash
# Check health status
docker inspect claude-${PROJECT_NAME:-cc-bridge} | jq '.[0].State.Health'

# View health check logs
docker inspect claude-${PROJECT_NAME:-cc-bridge} | jq '.[0].State.Health.Log'

# Manually test health check
docker-compose exec claude-agent python3 -c "import sys; exit(0)"
```

## Security Considerations

### Read-Only Config Mount

The global Claude configuration directory is mounted read-only (`:ro`) for security:

```yaml
volumes:
  - ${HOME}/.claude:/home/vscode/.claude:ro
```

This prevents the container from modifying your host's Claude Code configuration.

### Authentication Management

Authentication credentials are passed via environment variables, not hardcoded in the image:

```yaml
environment:
  - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}      # API key auth
  - ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN:-}  # OAuth/token auth
```

**Best practices:**

- Never commit `.env` files to version control
- Use different API keys for development and production
- Rotate API keys regularly
- Use API key management services for production deployments

### Non-Root User

The container runs as a non-root user (`vscode` with UID 1000) for security:

```dockerfile
RUN useradd -m -u 1000 -s /bin/bash vscode
USER vscode
```

This limits the potential impact of container escapes.

### Resource Limits

Consider adding resource limits to `docker-compose.yml`:

```yaml
services:
  claude-agent:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
```

## Advanced Configuration

### Custom Docker Compose Profiles

Create different configurations for development and production:

```yaml
# docker-compose.dev.yml
services:
  claude-agent:
    environment:
      - LOG_LEVEL=DEBUG
    volumes:
      - ./dev-config:/home/vscode/.claude/bridge:ro

# docker-compose.prod.yml
services:
  claude-agent:
    environment:
      - LOG_LEVEL=INFO
    restart: always
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
```

Usage:

```bash
# Development
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# Production
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Multi-Container Setup

If you need multiple Claude Code instances:

```yaml
# docker-compose.multi.yml
services:
  claude-agent-1:
    extends:
      file: docker-compose.yml
      service: claude-agent
    container_name: claude-${PROJECT_NAME:-cc-bridge}-1
    environment:
      - INSTANCE_ID=1

  claude-agent-2:
    extends:
      file: docker-compose.yml
      service: claude-agent
    container_name: claude-${PROJECT_NAME:-cc-bridge}-2
    environment:
      - INSTANCE_ID=2
```

## Performance Tips

### Optimize Build Time

```bash
# Use BuildKit for faster builds
export DOCKER_BUILDKIT=1
docker-compose build

# Use layer caching
docker-compose build --build-arg BUILDKIT_INLINE_CACHE=1
```

### Reduce Image Size

The Dockerfile uses multi-stage builds to minimize image size:

- **Stage 1 (Builder):** Installs build dependencies and compiles packages
- **Stage 2 (Runtime):** Copies only runtime dependencies

Current image size: ~500MB (base Ubuntu + Python + Claude Code)

### Volume Mount Performance

For better performance on macOS with OrbStack:

```bash
# Use VirtioFS for better file system performance
# Configure in OrbStack settings: Settings > Docker > File sharing
```

## Production Deployment

### Using Docker Swarm

```bash
# Initialize Swarm
docker swarm init

# Deploy stack
docker stack deploy -c docker-compose.yml cc-bridge

# Scale services
docker service scale cc-bridge_claude-agent=3

# Remove stack
docker stack rm cc-bridge
```

### Using Kubernetes

For Kubernetes deployments, convert `docker-compose.yml` to Kubernetes manifests:

```bash
# Use Kompose to convert
kompose convert -f docker-compose.yml -o k8s/

# Apply manifests
kubectl apply -f k8s/
```

## References

- [OrbStack Documentation](https://orbstack.dev/)
- [OrbStack CLI Reference](https://doc.orbstack.dev/cli/)
- [Docker Documentation](https://docs.docker.com/)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Anthropic Claude Code Documentation](https://docs.anthropic.com/claude/docs/overview)
- [Anthropic Computer Use Demo](https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-demo)

## Support

For issues or questions:

1. Check the troubleshooting section above
2. Review OrbStack logs: `orb logs`
3. Review Docker logs: `docker-compose logs`
4. Open an issue on GitHub
