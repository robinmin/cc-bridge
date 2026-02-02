# Troubleshooting Guide

This guide covers common issues and solutions for cc-bridge, especially when using FIFO daemon mode.

## Table of Contents

- [General Issues](#general-issues)
- [FIFO Mode Issues](#fifo-mode-issues)
- [Docker Issues](#docker-issues)
- [Telegram Issues](#telegram-issues)
- [Health Monitoring Issues](#health-monitoring-issues)

## General Issues

### cc-bridge command not found

**Problem**: Running `cc-bridge` gives "command not found"

**Solutions**:
```bash
# Ensure installation is complete
uv sync

# Check if installed
which cc-bridge

# Or use uv run
uv run cc-bridge --help
```

### Permission denied when creating pipes

**Problem**: `Permission denied` when accessing `/tmp/cc-bridge/pipes`

**Solutions**:
```bash
# Fix permissions on pipe directory
sudo chmod 1777 /tmp/cc-bridge/pipes

# Or use a user-writable location
mkdir -p ~/.local/share/cc-bridge/pipes

# Then update config.yaml:
# docker.pipe_dir: ~/.local/share/cc-bridge/pipes
```

## FIFO Mode Issues

### FIFO pipes not created

**Problem**: Pipes don't exist in `/tmp/cc-bridge/pipes`

**Diagnosis**:
```bash
# Check if pipes exist
ls -la /tmp/cc-bridge/pipes/*.fifo

# Check pipe directory
ls -ld /tmp/cc-bridge/pipes
```

**Solutions**:
1. Verify `mkfifo` is available:
```bash
which mkfifo
```

2. Check cc-bridge logs:
```bash
tail -f ~/Library/Logs/cc-bridge/daemon.log
# or
tail -f ~/.local/state/cc-bridge/logs/bridge.log
```

3. Manually test pipe creation:
```bash
mkfifo /tmp/test.fifo
ls -l /tmp/test.fifo  # Should show 'p' for pipe type
rm /tmp/test.fifo
```

### Container agent not running

**Problem**: Commands hang or timeout when using FIFO mode

**Diagnosis**:
```bash
# Check if agent process is running
docker exec <container_id> ps aux | grep container_agent

# Check container logs
docker logs <container_id>
```

**Solutions**:
1. Verify container has Python:
```bash
docker exec <container_id> which python3
```

2. Check if container_agent.py exists:
```bash
docker exec <container_id> ls -la /app/container_agent.py
```

3. Restart the instance:
```bash
cc-bridge docker restart <instance_name>
```

### Session not persisting

**Problem**: Conversation history is lost between commands

**Diagnosis**:
```bash
# Check session tracking is enabled
cc-bridge config docker.session

# Verify using FIFO mode
cc-bridge docker status <instance_name>
# Should show "communication_mode: fifo"
```

**Solutions**:
1. Ensure communication_mode is set to `fifo`:
```yaml
docker:
  communication_mode: fifo
```

2. Check session timeout settings:
```bash
cc-bridge config docker.session.idle_timeout
```

## Docker Issues

### Container not discovered

**Problem**: Docker instance not showing in `cc-bridge docker list`

**Diagnosis**:
```bash
# Check if container is running
docker ps

# Check container labels
docker inspect <container_id> | grep -A 10 "Labels"
```

**Solutions**:
1. Add required label to container:
```bash
docker label <container_id> cc-bridge.enabled=true
```

2. Or manually add the instance:
```bash
cc-bridge docker add <instance_name> --container-id <container_id>
```

### Container not running

**Problem**: Instance shows as "not running" or "stopped"

**Diagnosis**:
```bash
# Check container status
docker ps -a | grep <container_name>

# Check container logs
docker logs <container_id>
```

**Solutions**:
1. Start the container:
```bash
docker start <container_id>
```

2. Or recreate the container:
```bash
docker run -d \
  --name <container_name> \
  --label cc-bridge.enabled=true \
  --network claude-network \
  -v /tmp/cc-bridge/pipes:/pipes \
  <image_name>
```

### Docker daemon not running

**Problem**: Cannot connect to Docker daemon

**Diagnosis**:
```bash
# Check Docker status
docker info
```

**Solutions**:
```bash
# Start Docker Desktop (macOS)
open -a Docker

# Or start Docker daemon (Linux)
sudo systemctl start docker
```

## Telegram Issues

### Webhook not receiving messages

**Problem**: Messages sent to bot don't reach cc-bridge

**Diagnosis**:
```bash
# Check webhook is set
curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo

# Verify tunnel is running
cc-bridge tunnel status
```

**Solutions**:
1. Set webhook:
```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-url.com/webhook"
```

2. Start Cloudflare tunnel:
```bash
cc-bridge tunnel --start
```

### Unauthorized chat ID

**Problem**: Bot responds with "Unauthorized"

**Diagnosis**:
```bash
# Get your chat ID
# Send /start to your bot and check logs
tail -f ~/Library/Logs/cc-bridge/daemon.log | grep chat_id
```

**Solutions**:
1. Add your chat ID to config:
```yaml
telegram:
  chat_id: <your_chat_id>
```

2. Use @userinfobot to get your chat ID

## Health Monitoring Issues

### Health check failing

**Problem**: `cc-bridge health` shows unhealthy status

**Diagnosis**:
```bash
# Run detailed health check
cc-bridge health --verbose

# Check specific components
cc-bridge health --component docker_daemon
cc-bridge health --component fifo_pipes
```

**Solutions**:

**For docker_daemon failures**:
```bash
# Check Docker is running
docker info

# Check instances are running
cc-bridge docker list
```

**For fifo_pipes failures**:
```bash
# Check pipe directory exists
ls -ld /tmp/cc-bridge/pipes

# Check directory is writable
touch /tmp/cc-bridge/pipes/test && rm /tmp/cc-bridge/pipes/test

# Count FIFO pipes
ls -la /tmp/cc-bridge/pipes/*.fifo | wc -l
```

### Instance marked unhealthy

**Problem**: Instance status shows as unhealthy

**Diagnosis**:
```bash
# Check instance status
cc-bridge docker status <instance_name>

# Check health monitor logs
tail -f ~/Library/Logs/cc-bridge/daemon.log | grep health
```

**Solutions**:
1. Restart the instance:
```bash
cc-bridge docker restart <instance_name>
```

2. Check for recovery attempts:
```bash
# Recovery is automatic after max_consecutive_failures
# Check your config:
cc-bridge config docker.health.max_consecutive_failures
```

3. Manually trigger recovery:
```bash
# Remove and re-add the instance
cc-bridge docker remove <instance_name>
cc-bridge docker add <instance_name> --mode fifo --container-id <container_id>
```

## Getting Help

If you're still having issues:

1. **Check logs**:
```bash
tail -f ~/Library/Logs/cc-bridge/daemon.log
# or
tail -f ~/.local/state/cc-bridge/logs/bridge.log
```

2. **Run health checks**:
```bash
cc-bridge health
```

3. **Enable debug logging**:
```yaml
logging:
  level: DEBUG
```

4. **Check GitHub issues**:
   - https://github.com/robinmin/cc-bridge/issues

5. **Create a new issue** with:
   - cc-bridge version (`cc-bridge --version`)
   - Docker version (`docker --version`)
   - Error messages from logs
   - Configuration (sanitized)
