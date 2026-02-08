# CC-Bridge User Manual

**Version**: 2.0.0
**Last Updated**: 2025-02-07
**Status**: Production Ready

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Quick Start](#2-quick-start)
3. [Configuration](#3-configuration)
4. [Usage Guide](#4-usage-guide)
5. [Commands Reference](#5-commands-reference)
6. [Troubleshooting](#6-troubleshooting)
7. [Advanced Usage](#7-advanced-usage)
8. [Security Best Practices](#8-security-best-practices)

---

## 1. Introduction

### 1.1 What is CC-Bridge?

CC-Bridge is a **Telegram bot bridge** that enables you to interact with Claude Code (Anthropic's AI coding assistant) directly through Telegram. It acts as a two-way communication bridge:

- **Incoming Messages**: Messages you send to the Telegram bot are forwarded to Claude Code
- **Outgoing Responses**: Claude Code's responses are sent back to you via Telegram

### 1.2 Key Features

- ✅ **Remote Access**: Interact with Claude Code from anywhere via Telegram
- ✅ **Fast Response**: TCP-based IPC for low-latency communication (~10ms)
- ✅ **Docker Optimized**: First-class container support with automatic discovery
- ✅ **Multiple Workspaces**: Switch between different projects seamlessly
- ✅ **Async Mode**: Long-running operations via tmux sessions
- ✅ **File Operations**: Full read/write/edit capabilities through Claude Code
- ✅ **Session Management**: Persistent sessions with conversation history
- ✅ **Cross-platform**: Works on macOS, Linux, and Windows (via Docker)

### 1.3 Use Cases

- **Mobile Development**: Code on the go using your phone
- **Remote Monitoring**: Check on long-running Claude Code tasks
- **Quick Queries**: Ask Claude Code questions without opening a terminal
- **Team Collaboration**: Share a Claude Code session via Telegram groups
- **Automation**: Integrate Claude Code with Telegram bots

---

## 2. Quick Start

### 2.1 Prerequisites

- **Docker**: Installed and running
- **Bun**: JavaScript runtime (for running the gateway)
- **Telegram Account**: To create and use the bot
- **Claude Code**: Anthropic's CLI tool (installed in container)

### 2.2 Fastest Way to Start

**Step 1: Configure Environment**

```bash
# Copy gateway environment template
cp .env.example .env

# Copy container environment template
cp src/dockers/.env.example src/dockers/.env

# Edit with your tokens
nano .env                    # Gateway configuration
nano src/dockers/.env        # Container configuration
```

Required variables (in `.env`):
```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
```

Required variables (in `src/dockers/.env`):
```bash
ANTHROPIC_AUTH_TOKEN=sk-ant-xxx
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
```

**Step 2: Start Services**

```bash
# Start container agent
make docker-start

# Start gateway service
make gateway-start

# Monitor logs
make logs-monitor
```

**Step 3: Test**

```bash
# Send test message via Docker
make docker-talk msg="Hello Claude!"

# Or send a message directly to your Telegram bot
```

### 2.3 Verify Installation

```bash
# Check container status
docker ps | grep cc-bridge

# Check gateway health
curl http://localhost:8080/health

# View logs
make logs-follow
```

---

## 3. Configuration

### 3.1 Configuration Files

**Gateway Configuration** (`data/config/gateway.jsonc`):

The gateway uses a JSONC configuration file:

```jsonc
{
  // Server
  "port": 8080,

  // Logging
  "logLevel": "info",    // debug | info | warn | error
  "logFormat": "json",   // json | text

  // Services
  "ipcPollInterval": 1000,
  "refreshInterval": 30000,
  "projectsRoot": "/Users/yourname/xprojects"
}
```

**Gateway Environment Variables** (set via LaunchDaemon or shell):

```bash
# Telegram Bot Token (required)
export TELEGRAM_BOT_TOKEN=123456:ABC-DEF

# Override config values (optional)
export PORT=8080
export LOG_LEVEL=info
export ENABLE_TMUX=false       # Enable async mode
export FILE_CLEANUP_ENABLED=true
```

**Agent/Container Configuration** (`src/dockers/.env`):

```bash
# Claude API
ANTHROPIC_AUTH_TOKEN=sk-ant-xxx

# Agent Mode
AGENT_MODE=tcp          # tcp | server | stdio | http
AGENT_TCP_PORT=3001

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
```

### 3.2 Docker Compose

The system uses Docker Compose for orchestration:

```yaml
services:
  cc-bridge:
    build:
      context: .
      dockerfile: src/dockers/Dockerfile.agent
    environment:
      - AGENT_MODE=tcp
      - AGENT_TCP_PORT=3001
      - ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN}
    ports:
      - "3001:3001"
    volumes:
      - ./workspaces:/workspaces
    labels:
      - cc-bridge.workspace=cc-bridge
```

### 3.3 Telegram Bot Setup

**Step 1: Create Bot via BotFather**

1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. Follow the prompts to choose a name and username
4. Save the bot token

**Step 2: Get Your Chat ID**

Send a message to your bot, then visit:
```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
```

Look for `chat_id` in the response.

---

## 4. Usage Guide

### 4.1 Basic Interaction

**Sending Messages to Claude:**

Simply send a message to your Telegram bot:

```
What is the weather like today?
```

Claude will respond in Telegram with its answer.

**Code Generation:**

```
Write a Python function to calculate fibonacci numbers
```

**Code Execution:**

```
Create a file hello.py with a print statement and run it
```

### 4.2 Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help message |
| `/status` | Show system status |
| `/workspace` | Switch workspace |
| `/list` | List available workspaces |
| `/use <name>` | Use specific workspace |

### 4.3 Workspace Management

**Switch Workspace:**

```
/use another-project
```

**List Workspaces:**

```
/list
```

**Current Workspace:**

```
/workspace
```

### 4.4 Conversation History

CC-Bridge maintains conversation history per workspace:

```
You: What is 2+2?
Claude: 2+2 equals 4.

You: And what about 5+5?
Claude: 5+5 equals 10.
```

History is stored in SQLite and limited to 50 messages by default.

---

## 5. Commands Reference

### 5.1 Makefile Commands

| Command | Description |
|---------|-------------|
| `make gateway-start` | Start gateway service |
| `make gateway-stop` | Stop gateway service |
| `make gateway-restart` | Restart gateway |
| `make docker-start` | Start container agent |
| `make docker-stop` | Stop container agent |
| `make docker-restart` | Restart container |
| `make docker-rebuild` | Rebuild container image |
| `make logs-monitor` | Stream all logs |
| `make logs-follow` | Follow gateway logs |
| `make docker-exec` | Exec into container shell |
| `make docker-talk` | Send test message |
| `make test` | Run all tests |
| `make lint` | Run linter |
| `make format` | Format code |

### 5.2 Telegram Slash Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/help` | Show help | `/help` |
| `/status` | System status | `/status` |
| `/workspace` | Show/switch workspace | `/workspace` |
| `/list` | List workspaces | `/list` |
| `/use <name>` | Use workspace | `/use my-project` |

---

## 6. Troubleshooting

### 6.1 Common Issues

#### Issue: "Container not found"

**Solution**:
```bash
# Check container status
docker ps -a | grep cc-bridge

# Start container
make docker-start
```

#### Issue: "IPC timeout"

**Solution**:
```bash
# Check AGENT_MODE is set to tcp
docker exec cc-bridge-agent env | grep AGENT_MODE

# Restart container
make docker-restart
```

#### Issue: "No response from Claude"

**Solution**:
```bash
# Check logs
make logs-follow

# Verify ANTHROPIC_AUTH_TOKEN is set
docker exec cc-bridge-agent env | grep ANTHROPIC
```

#### Issue: "Circuit breaker open"

**Solution**:
```bash
# Wait for timeout (60 seconds) or restart services
make gateway-restart
make docker-restart
```

### 6.2 Debug Mode

**Enable debug logging:**

```bash
# Set log level
export LOG_LEVEL=debug
make gateway-start
```

**View detailed logs:**

```bash
# Follow gateway logs
make logs-follow

# View container logs
docker logs -f cc-bridge-agent
```

### 6.3 Health Check

```bash
# Gateway health
curl http://localhost:8080/health

# Expected response
{
  "status": "ok",
  "runtime": "bun",
  "timestamp": "2025-02-07T10:00:00Z"
}
```

---

## 7. Advanced Usage

### 7.1 Async Mode (Tmux)

For long-running operations, enable async mode:

```bash
# Enable in .env
ENABLE_TMUX=true
```

In async mode:
- Request returns immediately
- Response arrives via callback
- Tmux sessions persist between requests

### 7.2 Multiple Workspaces

**Create new workspace:**

```bash
mkdir -p workspaces/another-project
```

**Switch to workspace:**

```
/use another-project
```

### 7.3 Direct Docker Execution

Test without Telegram:

```bash
make docker-talk msg="Explain the IPC architecture"
```

### 7.4 Container Shell Access

```bash
# Exec into container
make docker-exec

# Inside container
bun run src/agent/index.ts
ps aux | grep claude
tmux ls
```

### 7.5 Performance Tuning

**IPC Method Selection:**

| Method | Latency | Use Case |
|--------|---------|----------|
| TCP | ~10ms | Production (default) |
| Unix Socket | ~5ms | Host-based |
| Docker Exec | ~50s | Fallback only |

**Environment Variables:**

```bash
# Force TCP mode
AGENT_MODE=tcp

# Adjust timeout
REQUEST_TIMEOUT=120000
```

---

## 8. Security Best Practices

### 8.1 Protect Your Tokens

- **Never** share your bot token publicly
- **Never** commit tokens to version control
- **Use** environment variables for sensitive data
- **Rotate** tokens if compromised

### 8.2 File Access Safety

- **Review** Claude's responses before running commands
- **Be** cautious with commands that modify system files
- **Use** dedicated workspace for CC-Bridge

### 8.3 Rate Limiting

The system includes built-in rate limiting:
- 100 requests per minute per workspace
- 200 requests per minute per IP

### 8.4 Input Validation

All inputs are validated:
- Control character filtering
- XML escaping for injection prevention
- Maximum line length enforcement
- Output size limiting (10MB)

---

## Appendix A: Configuration Reference

### Complete Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Gateway port | 8080 |
| `LOG_LEVEL` | Logging level | info |
| `LOG_FORMAT` | Log format | json |
| `AGENT_MODE` | Agent mode | tcp |
| `AGENT_TCP_PORT` | Agent TCP port | 3001 |
| `ANTHROPIC_AUTH_TOKEN` | Claude API token | - |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | - |
| `ENABLE_TMUX` | Enable async mode | false |
| `FILE_CLEANUP_ENABLED` | Enable cleanup | true |

### Docker Compose Options

```yaml
services:
  cc-bridge:
    environment:
      - AGENT_MODE=tcp
      - AGENT_TCP_PORT=3001
    ports:
      - "3001:3001"  # TCP IPC
    volumes:
      - ./workspaces:/workspaces
```

---

## Appendix B: Quick Reference

### Essential Commands

```bash
# Start everything
make docker-start && make gateway-start

# View logs
make logs-monitor

# Test connection
make docker-talk msg="ping"

# Restart everything
make gateway-restart && make docker-restart

# Run tests
make test

# Lint code
make lint
```

### Default Ports

| Service | Port |
|---------|------|
| Gateway HTTP | 8080 |
| Agent TCP | 3001 |

### Log Locations

| Component | Location |
|-----------|----------|
| Gateway logs | Console / data/logs/ |
| Container logs | Docker logs |
| Database | data/gateway.db |

---

## Document Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.0.0 | 2025-02-07 | Complete rewrite for Docker-first workflow, TCP IPC, make commands |
| 1.0.0 | 2026-02-02 | Initial user manual |

---

**Need Help?**

- **Documentation**: https://github.com/hanxiao/cc-bridge
- **Issues**: https://github.com/hanxiao/cc-bridge/issues
- **Discussions**: https://github.com/hanxiao/cc-bridge/discussions

**License**: MIT
**Made with ❤️ by the CC-Bridge team
