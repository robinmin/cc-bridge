# CC-Bridge User Manual

**Version**: 2.2.0
**Last Updated**: 2026-02-21
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

CC-Bridge is a **Telegram/Lark(Feishu) bot bridge** that enables you to interact with Claude Code (Anthropic's AI coding assistant) through chat channels. It acts as a two-way communication bridge:

- **Incoming Messages**: Messages sent to supported channels are forwarded to Claude Code
- **Outgoing Responses**: Claude Code's responses are sent back to the source chat channel

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
# Build/restart container agent
make docker-restart

# Start gateway service
make gateway-start

# Monitor logs
make logs-monitor
```

**Step 3: Test**

```bash
# Send test message via Docker
make talk MSG="Hello Claude!"

# Or send a message directly to your Telegram bot
```

### 2.3 Verify Installation

```bash
# Check container status
docker ps | grep cc-bridge

# Check gateway health
curl http://localhost:8080/health

# View logs
make logs-monitor
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

### 3.4 Lark/Feishu Setup

**Step 1: Create a Lark App**

1. Go to the [Lark Developer Console](https://open.larksuite.com/open-apis/authen/v1/index).
2. Click **Create Custom App** and give it a name.
3. In **App Settings > Basic Info**, find your `App ID` and `App Secret`.

**Step 2: Enable Bot Capabilities**

1. In the left sidebar, go to **App Capabilities > Bot**.
2. Click **Enable Bot**.

**Step 3: Configure Event Subscriptions**

1. Go to **Development Config > Event Subscriptions**.
2. Set the **Request URL** to `https://your-domain.com/webhook/feishu`.
3. Add the `im.message.receive_v1` event subscription.
4. Ensure you have the `im:message` and `im:message.p2p_msg` permissions.

**Step 4: Configure Environment**

Update your `.env` with the credentials from the console:
```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ENCRYPT_KEY=xxx
FEISHU_VERIFICATION_TOKEN=xxx
```

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
| `/menu` | Show all available commands |
| `/ws_list` | List available workspaces |
| `/ws_status` | Show current workspace status |
| `/ws_switch <name>` | Switch workspace |
| `/ws_add <name>` | Create workspace |
| `/ws_del <name>` | Delete workspace |
| `/schedulers` | List scheduled tasks |
| `/scheduler_add ...` | Add scheduled task |
| `/scheduler_del <task_id>` | Delete scheduled task |
| `/clear` | Clear current workspace session context |

### 4.3 Workspace Management

**Switch Workspace:**

```
/ws_switch another-project
```

**List Workspaces:**

```
/list
```

**Current Workspace:**

```
/ws_status
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

### 4.5 Mini-App Lifecycle

Mini-app specs live in `src/apps/*.md` and are executed by `src/gateway/apps/driver.ts`.

Typical lifecycle:

```bash
# 1) Create a new mini-app spec
make app-new APP_ID=my-report

# 2) Edit src/apps/my-report.md

# 3) Verify app is discoverable
make app-list

# 4) Run immediately
make app-run APP_ID=my-report APP_INPUT="focus area"

# 5) Schedule (UTC for cron)
make app-schedule APP_ID=my-report APP_SCHEDULE_TYPE=cron APP_SCHEDULE_VALUE="0 8 * * *"

# 6) Inspect tasks
make app-list-tasks APP_ID=my-report

# 7) Unschedule
make app-unschedule APP_ID=my-report
```

---

## 5. Commands Reference

### 5.1 Makefile Commands

| Command | Description |
|---------|-------------|
| `make gateway-start` | Start gateway service |
| `make gateway-stop` | Stop gateway service |
| `make gateway-restart` | Restart gateway |
| `make docker-stop` | Stop container agent |
| `make docker-restart` | Restart container |
| `make logs-monitor` | Stream all logs |
| `make docker-status` | Show container status/processes |
| `make docker-logs` | Follow container logs |
| `make talk MSG="..."` | Send test message via container_cmd flow |
| `make app-new APP_ID=...` | Create mini-app spec |
| `make app-list` | List mini-apps |
| `make app-run APP_ID=...` | Run mini-app |
| `make app-schedule APP_ID=...` | Schedule mini-app task |
| `make app-list-tasks [APP_ID=...]` | List mini-app tasks |
| `make app-unschedule TASK_ID=...` | Unschedule by task id |
| `make app-unschedule APP_ID=...` | Unschedule by app id |
| `make test` | Run all tests |
| `make lint` | Run linter |
| `make format` | Format code |

### 5.2 Telegram Slash Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/help` | Show help | `/help` |
| `/status` | System status | `/status` |
| `/menu` | Show all commands | `/menu` |
| `/ws_list` | List workspaces | `/ws_list` |
| `/ws_status` | Show current workspace status | `/ws_status` |
| `/ws_switch <name>` | Use workspace | `/ws_switch my-project` |
| `/schedulers` | List tasks | `/schedulers` |
| `/clear` | Clear chat session context | `/clear` |

---

## 6. Troubleshooting

### 6.1 Common Issues

#### Issue: "Container not found"

**Solution**:
```bash
# Check container status
docker ps -a | grep cc-bridge

# Rebuild/restart container
make docker-restart
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
make logs-monitor

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
make logs-monitor

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
/ws_switch another-project
```

### 7.3 Direct Docker Execution

Test without Telegram:

```bash
make talk MSG="Explain the IPC architecture"
```

### 7.4 Container Shell Access

```bash
# Show container status and running processes
make docker-status

# Follow container logs
make docker-logs
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
| `FEISHU_APP_ID` | Lark/Feishu App ID | - |
| `FEISHU_APP_SECRET` | Lark/Feishu App Secret | - |
| `FEISHU_ENCRYPT_KEY` | Lark/Feishu Encryption Key | - |
| `FEISHU_VERIFICATION_TOKEN` | Lark/Feishu Verification Token | - |
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
make docker-restart && make gateway-start

# View logs
make logs-monitor

# Test connection
make talk MSG="ping"

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
| 2.2.0 | 2026-02-21 | Updated make/command reference, added mini-app lifecycle workflow, aligned slash commands with current bot behavior |
| 2.1.0 | 2026-02-08 | Added Lark/Feishu support, configuration guide, and environment reference |
| 2.0.0 | 2025-02-07 | Complete rewrite for Docker-first workflow, TCP IPC, make commands |
| 1.0.0 | 2026-02-02 | Initial user manual |

---

**Need Help?**

- **Documentation**: https://github.com/hanxiao/cc-bridge
- **Issues**: https://github.com/hanxiao/cc-bridge/issues
- **Discussions**: https://github.com/hanxiao/cc-bridge/discussions

**License**: MIT
**Made with ❤️ by the CC-Bridge team
