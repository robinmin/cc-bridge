# Docker Deployment Guide

Complete guide for deploying Claude Code Telegram Bridge using Docker.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Configuration](#configuration)
4. [Deployment Options](#deployment-options)
5. [Health Checks](#health-checks)
6. [Monitoring](#monitoring)
7. [Troubleshooting](#troubleshooting)
8. [Production Best Practices](#production-best-practices)

## Prerequisites

- Docker 20.10+
- Docker Compose 2.0+
- 2GB RAM minimum
- 10GB disk space

## Quick Start

### 1. Clone Repository

```bash
git clone https://github.com/hanxiao/claudecode-telegram
cd claudecode-telegram
```

### 2. Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Edit with your bot token
nano .env
```

Required variables:
```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
```

### 3. Start Services

```bash
# Start bridge only
docker-compose up -d

# Or with Cloudflare tunnel
docker-compose --profile tunnel up -d
```

### 4. Verify Deployment

```bash
# Check container status
docker-compose ps

# View logs
docker-compose logs -f cc-bridge

# Test health endpoint
curl http://localhost:8080/
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | - | Bot token from @BotFather |
| `PORT` | No | 8080 | Bridge server port |
| `TMUX_SESSION` | No | claude | tmux session name |
| `LOG_LEVEL` | No | INFO | Logging level |
| `CLAUDE_CONFIG_DIR` | No | ~/.claude | Claude Code config path |

### Volume Mounts

The following volumes should be mounted:

```yaml
volumes:
  # Configuration persistence
  - ./config:/home/bridge/.claude/bridge

  # Log files
  - ./logs:/home/bridge/.claude/bridge/logs

  # Claude Code integration
  - ~/.claude:/home/bridge/.claude
```

## Deployment Options

### Option 1: Docker Compose (Recommended)

**Advantages:**
- Simple configuration
- Automatic networking
- Easy service management
- Built-in health checks

**Usage:**
```bash
docker-compose up -d
```

### Option 2: Docker Run

**Advantages:**
- More control over container
- No additional files needed
- Suitable for scripting

**Usage:**
```bash
docker run -d \
  --name cc-bridge \
  --restart unless-stopped \
  -p 8080:8080 \
  -e TELEGRAM_BOT_TOKEN="your_token" \
  -v $(pwd)/config:/home/bridge/.claude/bridge \
  -v $(pwd)/logs:/home/bridge/.claude/bridge/logs \
  -v ~/.claude:/home/bridge/.claude \
  cc-bridge:latest
```

### Option 3: Kubernetes

For large-scale deployments, use Kubernetes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cc-bridge
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cc-bridge
  template:
    metadata:
      labels:
        app: cc-bridge
    spec:
      containers:
      - name: cc-bridge
        image: cc-bridge:latest
        ports:
        - containerPort: 8080
        env:
        - name: TELEGRAM_BOT_TOKEN
          valueFrom:
            secretKeyRef:
              name: telegram-secrets
              key: bot-token
        volumeMounts:
        - name: config
          mountPath: /home/bridge/.claude/bridge
        - name: logs
          mountPath: /home/bridge/.claude/bridge/logs
        livenessProbe:
          httpGet:
            path: /
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
      volumes:
      - name: config
        persistentVolumeClaim:
          claimName: cc-bridge-config
      - name: logs
        persistentVolumeClaim:
          claimName: cc-bridge-logs
```

## Health Checks

### Built-in Health Check

The container includes a Docker health check:

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/ || exit 1
```

**Parameters:**
- Interval: 30 seconds
- Timeout: 10 seconds
- Start period: 5 seconds
- Retries: 3

### Checking Health Status

```bash
# View health status
docker ps

# Detailed health info
docker inspect cc-bridge --format='{{json .State.Health}}' | jq

# Health check logs
docker inspect cc-bridge --format='{{json .State.Health.Log}}' | jq
```

### Custom Health Checks

For more advanced monitoring, implement custom health checks:

```bash
#!/bin/bash
# custom-health-check.sh

# Check if process is running
if ! pgrep -f "python bridge.py" > /dev/null; then
    echo "Bridge process not running"
    exit 1
fi

# Check if responding
if ! curl -f http://localhost:8080/ > /dev/null 2>&1; then
    echo "Bridge not responding"
    exit 1
fi

# Check if tmux session exists
if ! tmux has-session -t claude 2>/dev/null; then
    echo "tmux session not found"
    exit 1
fi

echo "All checks passed"
exit 0
```

## Monitoring

### Log Management

**View logs:**
```bash
# Follow logs
docker-compose logs -f cc-bridge

# Last 100 lines
docker-compose logs --tail=100 cc-bridge

# Since timestamp
docker-compose logs --since 2024-01-01T00:00:00 cc-bridge
```

**Log rotation is configured in docker-compose.yml:**
```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

### Metrics to Monitor

Key metrics to monitor:
1. **Container uptime** - Should be 24/7 for production
2. **Health check status** - Should be "healthy"
3. **Memory usage** - Should be stable, no leaks
4. **CPU usage** - Spikes during message processing
5. **Log errors** - Should be minimal

### Monitoring Tools

**Basic monitoring:**
```bash
# Container stats
docker stats cc-bridge

# Resource usage
docker top cc-bridge
```

**Advanced monitoring:**
- Prometheus + Grafana
- Datadog
- New Relic
- CloudWatch

## Troubleshooting

### Common Issues

**1. Container won't start**

Check logs:
```bash
docker-compose logs cc-bridge
```

Common causes:
- Missing TELEGRAM_BOT_TOKEN
- Port 8080 already in use
- Volume mount permission errors

**2. Health check failing**

```bash
# Test health endpoint manually
curl http://localhost:8080/

# Check if process is running
docker exec cc-bridge pgrep -f "python bridge.py"

# Check container logs
docker logs cc-bridge
```

**3. Permission errors**

```bash
# Fix volume permissions
sudo chown -R 1000:1000 ./config ./logs

# Or run as root (not recommended)
# Remove USER bridge from Dockerfile
```

**4. Container exits immediately**

Check for missing dependencies:
```bash
# Run interactive for debugging
docker run -it --rm \
  -e TELEGRAM_BOT_TOKEN="test" \
  cc-bridge:latest \
  /bin/bash
```

### Debug Mode

Enable debug logging:

```bash
# Set LOG_LEVEL environment variable
LOG_LEVEL=DEBUG

# Or in docker-compose.yml
environment:
  - LOG_LEVEL=DEBUG
```

## Production Best Practices

### Security

1. **Use secrets for sensitive data:**
   ```bash
   # Docker Swarm
   echo "your_bot_token" | docker secret create bot_token -

   # Kubernetes
   kubectl create secret generic telegram-secrets \
     --from-literal=bot-token=your_bot_token
   ```

2. **Run as non-root user:**
   - Container runs as UID 1000
   - Never run as root in production

3. **Limit container capabilities:**
   ```yaml
   cap_drop:
     - ALL
   cap_add:
     - NET_BIND_SERVICE
   ```

4. **Use read-only filesystem:**
   ```yaml
   read_only: true
   tmpfs:
     - /tmp
   ```

### Performance

1. **Use multi-stage builds:**
   - Smaller image size
   - Faster deployments

2. **Enable BuildKit:**
   ```bash
   DOCKER_BUILDKIT=1 docker build .
   ```

3. **Use resource limits:**
   ```yaml
   deploy:
     resources:
       limits:
         cpus: '0.5'
         memory: 512M
       reservations:
         cpus: '0.25'
         memory: 256M
   ```

### Reliability

1. **Automatic restarts:**
   ```yaml
   restart: unless-stopped
   ```

2. **Health checks:**
   - Enable health checks
   - Set appropriate intervals

3. **Log rotation:**
   - Prevent disk overflow
   - Keep logs manageable

4. **Backup configuration:**
   - Mount volumes for persistence
   - Regular backups of config directory

### Scalability

For high-traffic scenarios:

1. **Load balancing:**
   ```yaml
   # docker-compose.yml
   services:
     cc-bridge:
       deploy:
         replicas: 3
   ```

2. **Message queue:**
   - Use Redis for session storage
   - Implement worker queues

3. **Caching:**
   - Cache bot commands
   - Cache user sessions

## Updating

### Update Procedure

```bash
# 1. Pull latest changes
git pull

# 2. Rebuild image
docker-compose build

# 3. Stop existing container
docker-compose down

# 4. Start new container
docker-compose up -d

# 5. Verify deployment
docker-compose ps
docker-compose logs -f cc-bridge
```

### Zero-Downtime Deployment

```bash
# 1. Start new container alongside old one
docker run -d --name cc-bridge-new -p 8081:8080 cc-bridge:new

# 2. Verify new container is healthy
curl http://localhost:8081/

# 3. Update load balancer / webhook
# Switch webhook to new port

# 4. Stop old container
docker stop cc-bridge
docker rm cc-bridge

# 5. Remap ports if needed
docker stop cc-bridge-new
docker run -d --name cc-bridge -p 8080:8080 cc-bridge:new
docker rm cc-bridge-new
```

## Support

For issues or questions:
- GitHub Issues: https://github.com/hanxiao/claudecode-telegram/issues
- Documentation: https://github.com/hanxiao/claudecode-telegram#readme
