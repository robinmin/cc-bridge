# CC-Bridge User Manual

**Version**: 0.1.0
**Last Updated**: 2026-02-02

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [Getting Started](#4-getting-started)
5. [Usage Guide](#5-usage-guide)
6. [Commands Reference](#6-commands-reference)
7. [Troubleshooting](#7-troubleshooting)
8. [FAQ](#8-faq)
9. [Advanced Usage](#9-advanced-usage)
10. [Security Best Practices](#10-security-best-practices)
11. [Advanced / Professional Usage](#11-advanced--professional-usage) ⭐ NEW

---

## 1. Introduction

### 1.1 What is CC-Bridge?

CC-Bridge is a Telegram bot bridge that enables you to interact with Claude Code (Anthropic's AI coding assistant) directly through Telegram. It acts as a two-way communication bridge:

- **Incoming Messages**: Messages you send to the Telegram bot are forwarded to Claude Code
- **Outgoing Responses**: Claude Code's responses are sent back to you via Telegram

### 1.2 Key Features

- ✅ **Remote Access**: Interact with Claude Code from anywhere via Telegram
- ✅ **Real-time Responses**: Get instant responses from Claude Code via chunked streaming
- ✅ **Docker Optimized**: First-class container support with automatic discovery
- ✅ **YOLO Mode**: Peak automation with reasoning-boosted "Always Thinking" mode
- ✅ **File Operations**: Full read/write/edit capabilities through Claude Code
- ✅ **Session Management**: Manage multiple isolated environments
- ✅ **Secure**: Encrypted communication with HTML-safe message layering
- ✅ **Cross-platform**: Works on macOS, Linux, and Windows (via Docker)

### 1.3 Use Cases

- **Mobile Development**: Code on the go using your phone
- **Remote Monitoring**: Check on long-running Claude Code tasks
- **Quick Queries**: Ask Claude Code questions without opening a terminal
- **Team Collaboration**: Share a Claude Code session via Telegram groups
- **Automation**: Integrate Claude Code with Telegram bots

### 1.4 System Requirements

- **Operating System**: macOS, Linux, or Windows (with WSL)
- **Python**: 3.11 or higher
- **tmux**: Terminal multiplexer (for Claude Code integration)
- **Telegram Account**: To create and use the bot
- **Claude Code**: Anthropic's CLI tool for Claude

---

## 2. Installation

### 2.1 Prerequisites

#### Step 1: Install Dependencies

**macOS** (using Homebrew):
```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install dependencies
brew install tmux python@3.11 uv cloudflared
```

**Linux** (Ubuntu/Debian):
```bash
# Update package list
sudo apt update

# Install dependencies
sudo apt install -y tmux python3.11 python3-pip curl

# Install uv (Python package manager)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install cloudflared (for tunnel support)
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb
```

**Windows** (WSL):
```bash
# Enable WSL if not already enabled
wsl --install

# Inside WSL, follow Linux instructions above
```

#### Step 2: Install Claude Code

```bash
# Install Claude Code via npm
npm install -g @anthropic-ai/claude-code

# Or using homebrew on macOS
brew install claude-code
```

Verify installation:
```bash
claude --version
```

### 2.2 Install CC-Bridge

#### Option 1: Install from Source (Recommended for Development)

```bash
# Clone repository
git clone https://github.com/hanxiao/claudecode-telegram.git
cd claudecode-telegram/cc-bridge

# Install in development mode
uv pip install -e .
```

#### Option 2: Install from PyPI (When Available)

```bash
pip install cc-bridge
```

### 2.3 Verify Installation

```bash
# Check version
cc-bridge --version

# Or run help
cc-bridge --help
```

Expected output:
```
Telegram bot bridge for Claude Code

Usage: cc-bridge [OPTIONS] COMMAND [ARGS]...

╭─ Commands ───────────────────────────────────╮
│ server      Start the FastAPI webhook server │
│ claude      Manage Claude Code instances     │
│ health      Run health checks                 │
│ setup       Interactive setup wizard          │
│ config      Configuration management          │
│ tunnel      Cloudflare tunnel management      │
╰───────────────────────────────────────────────╯
```

---

## 3. Configuration

### 3.1 Create a Telegram Bot

#### Step 1: Talk to BotFather

1. Open Telegram and search for `@BotFather`
2. Send the command `/newbot`
3. Follow the prompts:
   - Choose a name for your bot (e.g., "My Claude Bot")
   - Choose a username (e.g., `my_claude_bot`)
4. BotFather will give you a bot token (save this!)

Example:
```
BotFather: Done! Congratulations on your new bot.
You'll find it at t.me/my_claude_bot. You can now add a description,
profile picture, and more.

Use this token to access the HTTP API:
123456789:ABCdefGhIJKlmNoPQRstuvWxYZ

Keep your token secure and store it safely.
```

#### Step 2: Get Your Chat ID (Automated or Manual)

**Option 1: Automated Detection (Recommended)**

When you run the setup wizard (`cc-bridge setup`), it will automatically detect your chat ID:

1. The wizard will ask you to send `/start` to your bot
2. Your chat ID will be detected automatically
3. No manual URL visiting required!

**Option 2: Manual Detection**

1. Search for your bot on Telegram (e.g., `@my_claude_bot`)
2. Send any message to the bot (e.g., "hello")
3. Visit this URL in your browser:
   ```
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```
4. Look for your `chat_id` in the response

Example response:
```json
{
  "ok": true,
  "result": [
    {
      "update_id": 123456789,
      "message": {
        "message_id": 1,
        "from": {
          "id": 987654321,  ← This is your chat ID
          "is_bot": false,
          "first_name": "John",
          "username": "johndoe"
        },
        "chat": {
          "id": 987654321,  ← Same as above
          "type": "private"
        },
        "date": 1234567890,
        "text": "hello"
      }
    }
  ]
}
```

### 3.2 Run Setup Wizard (Enhanced Automated Setup)

The easiest way to configure CC-Bridge is using the interactive setup wizard:

```bash
cc-bridge setup
```

The enhanced setup wizard will automatically handle everything:

#### Step 1: Bot Token
- Paste your Telegram bot token from @BotFather

#### Step 2: Chat ID Auto-Detection
- Send `/start` to your bot
- We automatically detect your chat ID (no manual URL visiting!)
- Fallback to manual entry if detection fails

#### Step 3: Cloudflare Tunnel
- Automatically starts `cloudflared`
- Extracts the tunnel URL from output
- No need to copy/paste URLs manually

#### Step 4: Auto-Configuration
- Generates `.env` file from `.env.example`
- Registers Telegram webhook automatically
- Optionally sets up crontab for health checks

**Example Output:**
```
🚀 CC-Bridge Enhanced Setup Wizard
============================================================

📝 Step 1: Telegram Bot Token
------------------------------------------------------------
Enter your Telegram bot token: [your token]

📝 Step 2: Chat ID Detection
------------------------------------------------------------
⏳ Waiting for you to send /start to your bot...
   (This allows me to detect your chat ID)
✅ Chat ID detected: 123456789

📝 Step 3: Cloudflare Tunnel
------------------------------------------------------------
Starting Cloudflare tunnel to expose your local server...
✅ Tunnel URL: https://abc123.trycloudflare.com

📝 Step 4: Configuration
------------------------------------------------------------
✅ Configuration saved to: /Users/you/cc-bridge/.env

📝 Step 5: Health Check Automation
------------------------------------------------------------
Configure crontab for automatic health checks?
Setup crontab? (Y/n): y
✅ Crontab configured successfully

✅ Setup Complete!

Configuration:
   Bot Token: 123456789:ABC...
   Chat ID: 123456789
   Tunnel URL: https://abc123.trycloudflare.com
   Config File: /Users/you/cc-bridge/.env

Next steps:
   1. Review configuration in /Users/you/cc-bridge/.env
   2. Start the server: cc-bridge server
   3. Test by sending a message to your bot
```

The wizard automatically creates:
- `.env` file with all configuration
- Telegram webhook registration
- Crontab entry for health checks (optional)
- Backup of previous crontab

### 3.3 Manual Configuration

If you prefer to configure manually, create the config file:

```bash
# Create config directory
mkdir -p ~/.claude/bridge

# Create config file
nano ~/.claude/bridge/config.toml
```

Add the following content:

```toml
[telegram]
bot_token = "123456789:ABCdefGhIJKlmNoPQRstuvWxYZ"
webhook_url = ""  # Leave empty initially

[server]
host = "0.0.0.0"
port = 8080
reload = false

[tmux]
session = "claude"
auto_attach = true

[logging]
level = "INFO"
format = "json"
file = "~/.claude/bridge/logs/bridge.log"
max_bytes = 10485760
backup_count = 5

[health]
enabled = true
interval_minutes = 5

[tunnel]
auto_start = false
```

### 3.4 Environment Variables (Optional)

You can also use environment variables instead of the config file:

```bash
# Telegram settings
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRstuvWxYZ"
export TELEGRAM_WEBHOOK_URL="https://your-domain.com/webhook"

# Server settings
export PORT=8080

# tmux settings
export TMUX_SESSION="claude"

# Logging
export LOG_LEVEL="INFO"
```

### 3.5 Configuration Priority

CC-Bridge uses a layered configuration system. Higher priority sources override lower ones:

1. **CLI Arguments** (highest priority)
2. **Environment Variables**
3. **TOML Config File**
4. **Default Values** (lowest priority)

Example: If you set `PORT=9000` as an environment variable, it will override the `port = 8080` in your config file.

---

## 4. Getting Started

### 4.1 Quick Start (Docker Recommended)

The fastest and most stable way to run CC-Bridge is using Docker Compose.

```bash
# Step 1: Start the container environment
docker compose -f src/dockers/docker-compose.yml up -d

# Step 2: Perform one-time interactive setup (Trust workspace)
docker exec -it claude-cc-bridge claude --allow-dangerously-skip-permissions

# Step 3: Start the server
cc-bridge server

# Step 4: Test via host OS
make docker-talk msg="Check the weather in Sunnyvale"
```

**Example output:**
```
🚀 CC-Bridge Enhanced Setup Wizard
============================================================

✅ Setup Complete!
Next steps:
   1. Start instance: cc-bridge claude start my-instance
   2. Start server: cc-bridge server
   3. Send message to your bot
```

### 4.2 Starting Your First Instance

After setup, start a Claude Code instance:

```bash
# Start a new instance
cc-bridge claude start my-instance
```

This automatically:
- Creates a tmux session
- Starts Claude Code in the session
- Tracks the instance metadata
- Returns you to the command line

```bash
# Start the server
cc-bridge server
```

You should see:
```
INFO:     Started server process [12345]
INFO:     Uvicorn running on http://0.0.0.0:8080
```

### 4.3 Testing the Connection

Send a message to your Telegram bot:

```
Hello Claude!
```

You should receive a response in Telegram. That's it - everything is working!

### 4.4 Managing Instances

```bash
# List all instances
cc-bridge claude list

# Attach to an instance (to see Claude's full output)
cc-bridge claude attach my-instance
# Press Ctrl+B then D to detach

# Stop an instance
cc-bridge claude stop my-instance

# Restart an instance
cc-bridge claude restart my-instance
```

### 4.5 Working with Multiple Projects

Each instance can have its own working directory:

```bash
# Start instance for project A
cc-bridge claude start project-a --cwd ~/projects/project-a

# Start instance for project B
cc-bridge claude start project-b --cwd ~/projects/project-b

# List all instances
cc-bridge claude list
```

Output:
```
Found 2 instance(s):

🟢 project-a
   Working directory: /Users/you/projects/project-a
   Status: running

🟢 project-b
   Working directory: /Users/you/projects/project-b
   Status: running
```

### 4.6 Health Check

Verify everything is running:

```bash
cc-bridge health
```

Expected output:
```
✓ CC-Bridge Health Check

Component Status:
  Webhook:    ✓ Connected
  Instances:  ✓ 2 running
  Config:     ✓ Loaded

Overall Status: ✓ Healthy
```

---

## 5. Usage Guide

### 5.1 Basic Interaction

#### Sending Messages to Claude

Simply send a message to your Telegram bot:

```
What is the weather like today?
```

Claude will respond in Telegram with its answer.

#### Code Generation

Ask Claude to write code:

```
Write a Python function to calculate fibonacci numbers
```

Claude will generate the code and send it to Telegram.

#### Code Execution

You can ask Claude to execute code:

```
Create a file hello.py with a print statement and run it
```

Claude will:
1. Create the file
2. Run it
3. Send you the output

### 5.2 Advanced Features

#### File Operations

**Read a file**:
```
Read the file /path/to/file.txt
```

**Write to a file**:
```
Write "Hello, World!" to /path/to/file.txt
```

**Edit a file**:
```
Replace all occurrences of "old" with "new" in /path/to/file.py
```

#### Code Blocks

Claude will format code blocks nicely in Telegram:

```python
def hello():
    print("Hello, World!")
```

Long code blocks will be truncated with a message:
```
[Code truncated - full code sent to Claude session]
```

#### Multi-turn Conversations

CC-Bridge maintains conversation context:

```
You: What is 2+2?
Claude: 2+2 equals 4.

You: And what about 5+5?
Claude: 5+5 equals 10.
```

### 5.3 Slash Commands

CC-Bridge supports several slash commands in Telegram:

| Command | Description | Example |
|---------|-------------|---------|
| `/help` | Show help message | `/help` |
| `/status` | Show system status | `/status` |
| `/clear` | Clear conversation context | `/clear` |
| `/pause` | Pause message forwarding | `/pause` |
| `/resume` | Resume message forwarding | `/resume` |

### 5.4 Group Chat Support

You can add CC-Bridge to a Telegram group:

1. Add your bot to the group
2. Make the bot an admin (required for some features)
3. Mention the bot in messages: `@my_claude_bot What is Python?`

All group members will see Claude's responses.

### 5.5 Managing Multiple Projects

CC-Bridge makes it easy to manage multiple Claude Code instances for different projects:

```bash
# Start instance for project A
cc-bridge claude start project-a --cwd ~/projects/project-a

# Start instance for project B
cc-bridge claude start project-b --cwd ~/projects/project-b

# List all instances
cc-bridge claude list
```

Each instance runs in its own tmux session with its own context and working directory. Switch between projects by attaching to different instances:

```bash
# Work on project A
cc-bridge claude attach project-a

# Detach (Ctrl+B then D)

# Work on project B
cc-bridge claude attach project-b
```

All instances are managed automatically - no manual tmux commands needed!

---

## 6. Commands Reference

### 6.1 Core Commands

#### `cc-bridge server`

Start the FastAPI webhook server.

**Usage**:
```bash
cc-bridge server [OPTIONS]
```

**Options**:
- `--reload`: Enable auto-reload (development only)
- `--host TEXT`: Server host address (default: 0.0.0.0)
- `--port INTEGER`: Server port (default: 8080)

**Examples**:
```bash
# Start with defaults
cc-bridge server

# Start with custom port
cc-bridge server --port 9000

# Start with auto-reload (development)
cc-bridge server --reload
```

#### `cc-bridge health`

Run health checks on all components.

**Usage**:
```bash
cc-bridge health
```

**Output**:
```
✓ CC-Bridge Health Check

Component Status:
  Webhook:    ✓ Connected
  tmux:       ✓ Session 'claude' running
  Hook:       ✓ Ready

Overall Status: ✓ Healthy
```

#### `cc-bridge setup`

Interactive setup wizard for first-time configuration.

**Usage**:
```bash
cc-bridge setup
```

The wizard will guide you through:
1. Telegram bot token
2. Chat ID verification
3. tmux session name
4. Server settings
5. Logging configuration

#### `cc-bridge config`

Manage configuration settings.

**Usage**:
```bash
# View all configuration
cc-bridge config

# Get specific value
cc-bridge config --key server.port

# Set value
cc-bridge config --key server.port --value 9000

# Delete key
cc-bridge config --key test.key --delete
```

#### `cc-bridge tunnel`

Manage Cloudflare tunnel for webhook access.

**Usage**:
```bash
# Start tunnel
cc-bridge tunnel --start

# Stop tunnel
cc-bridge tunnel --stop

# Start with custom port
cc-bridge tunnel --start --port 9000
```

#### `cc-bridge claude`

Manage Claude Code instances without tmux complexity.

**Usage**:
```bash
# Start a new instance
cc-bridge claude start <instance_name>

# Start with custom working directory
cc-bridge claude start my-project --cwd ~/projects/my-project

# Start and attach immediately
cc-bridge claude start my-instance --no-detach

# List all instances
cc-bridge claude list

# Attach to a running instance
cc-bridge claude attach <instance_name>

# Stop an instance
cc-bridge claude stop <instance_name>

# Force stop without confirmation
cc-bridge claude stop <instance_name> --force

# Restart an instance
cc-bridge claude restart <instance_name>
```

**Subcommands**:

##### `start`
Create and start a new Claude Code instance.

**Arguments**:
- `<instance_name>`: Name for the instance (required)

**Options**:
- `--cwd PATH`: Working directory for the instance
- `--detach / --no-detach`: Run in detached mode (default: --detach)

**Examples**:
```bash
# Start instance in current directory
cc-bridge claude start my-instance

# Start instance in specific project directory
cc-bridge claude start project-a --cwd ~/projects/project-a

# Start and attach immediately
cc-bridge claude start my-instance --no-detach
```

##### `list`
List all Claude Code instances with their status.

**Output**:
```
Found 2 instance(s):

🟢 project-a
   Session: claude-project-a
   Working directory: /Users/you/projects/project-a
   Status: running
   Created: 2025-01-27 14:30

🔴 old-instance
   Session: claude-old-instance
   Working directory: (default)
   Status: stopped
   Created: 2025-01-26 09:15
```

##### `attach`
Attach to a running instance.

**Arguments**:
- `<instance_name>`: Name of the instance to attach to (required)

**Note**: Press Ctrl+B then D to detach without stopping the instance.

##### `stop`
Stop a running instance.

**Arguments**:
- `<instance_name>`: Name of the instance to stop (required)

**Options**:
- `--force`, `-f`: Force stop without confirmation

##### `restart`
Restart an instance (stop and start).

**Arguments**:
- `<instance_name>`: Name of the instance to restart (required)

**Instance Status Indicators**:
- 🟢 **running**: Instance is active and responding
- 🔴 **stopped**: Instance process has terminated
- ⚪ **no_pid**: Instance metadata exists but no PID assigned

### 6.2 Extended Commands

#### `cc-bridge logs`

Stream bridge logs in real-time.

**Usage**:
```bash
cc-bridge logs [OPTIONS]
```

**Options**:
- `--follow` (-f): Follow log output (like tail -f)
- `--lines INTEGER`: Number of lines to show (default: 50)

**Examples**:
```bash
# View last 100 lines
cc-bridge logs --lines 100

# Follow logs in real-time
cc-bridge logs --follow
```

#### `cc-bridge webhook`

Manage Telegram webhooks.

**Usage**:
```bash
# Get webhook info
cc-bridge webhook info

# Set webhook
cc-bridge webhook set

# Delete webhook
cc-bridge webhook delete
```

#### `cc-bridge bot`

Manage Telegram bot commands.

**Usage**:
```bash
# Sync slash commands with Telegram
cc-bridge bot sync

# List registered commands
cc-bridge bot list
```

---

## 7. Troubleshooting

### 7.1 Common Issues

#### Issue: "Instance not found"

**Symptoms**:
```
Error: Instance 'my-instance' not found
```

**Solution**:
```bash
# List available instances
cc-bridge claude list

# Create the instance
cc-bridge claude start my-instance
```

#### Issue: "Webhook not receiving updates"

**Symptoms**: Messages sent to bot don't reach CC-Bridge

**Solutions**:

1. Check webhook is set:
   ```bash
   cc-bridge webhook info
   ```

2. Verify server is running:
   ```bash
   cc-bridge health
   ```

3. Check if setup was completed:
   ```bash
   # Re-run setup if needed
   cc-bridge setup
   ```

#### Issue: "No response from Claude"

**Symptoms**: Message is forwarded to Claude but no response in Telegram

**Solutions**:

1. Check instance is running:
   ```bash
   cc-bridge claude list
   ```

2. Attach to instance to see what's happening:
   ```bash
   cc-bridge claude attach my-instance
   ```

3. Check for errors in logs:
   ```bash
   cc-bridge logs --follow
   ```

#### Issue: "Setup wizard can't detect chat ID"

**Symptoms**: Chat ID detection times out

**Solutions**:

1. Make sure you sent `/start` to your bot
2. Try sending another message to the bot
3. Use manual entry when prompted:
   ```
   Enter your Chat ID manually: [your chat ID]
   ```

#### Issue: "Configuration not loading"

**Symptoms**: Config changes not taking effect

**Solutions**:

1. Check `.env` file exists:
   ```bash
   ls -la .env
   ```

2. Re-run setup to regenerate config:
   ```bash
   cc-bridge setup
   ```

3. Restart the server after config changes

### 7.2 Debug Mode

Enable debug logging for troubleshooting:

```bash
# Set log level to DEBUG
export LOG_LEVEL=DEBUG

# Start server
cc-bridge server
```

Or update config:
```bash
cc-bridge config --key logging.level --value DEBUG
cc-bridge server
```

### 7.3 Getting Help

If you're still having trouble:

1. **Check the logs**:
   ```bash
   cc-bridge logs --lines 100
   ```

2. **Run health check**:
   ```bash
   cc-bridge health
   ```

3. **Enable debug mode** (see above)

4. **Check GitHub Issues**: https://github.com/hanxiao/claudecode-telegram/issues

5. **Create a new issue** with:
   - Your operating system and version
   - CC-Bridge version (`cc-bridge --version`)
   - Error messages or logs
   - Steps to reproduce

---

## 8. FAQ

### General Questions

**Q: Is CC-Bridge free to use?**
A: Yes, CC-Bridge is open-source and free to use under the MIT license.

**Q: Is CC-Bridge secure?**
A: CC-Bridge uses Telegram's encrypted messaging. However, you should:
- Keep your bot token secret
- Use HTTPS for webhooks
- Be careful with commands that modify files

**Q: Can I use CC-Bridge with multiple Telegram bots?**
A: Yes, but you'll need to run separate instances of CC-Bridge with different configurations.

**Q: Does CC-Bridge work with Claude Code Pro?**
A: Yes, CC-Bridge works with both free and Pro versions of Claude Code.

### Technical Questions

**Q: Why does CC-Bridge need tmux?**
A: tmux allows CC-Bridge to inject messages into Claude Code's terminal session programmatically.

**Q: Can I use CC-Bridge without a webhook?**
A: Yes, use polling mode:
```bash
cc-bridge webhook poll
```

**Q: What ports does CC-Bridge use?**
A: By default, port 8080. You can change this with:
```bash
cc-bridge config --key server.port --value 9000
```

**Q: How do I stop CC-Bridge?**
A: Press `Ctrl+C` in the terminal where the server is running.

### Feature Questions

**Q: Can I use CC-Bridge in a Telegram group?**
A: Yes, add the bot to your group and mention it: `@bot_name Your question`

**Q: Does CC-Bridge support file uploads from Telegram?**
A: Not currently. Files must be accessed via Claude Code's file system.

**Q: Can I see Claude's thinking process?**
A: No, only the final response is sent to Telegram. To see the full process, attach to the tmux session.

**Q: How long does Claude remember the conversation?**
A: As long as the Claude Code session is running. The context is managed by Claude Code itself.

### Limitations

**Q: Are there message length limits?**
A: Yes, Telegram has a 4096 character limit for messages. Long responses will be truncated.

**Q: Can I run arbitrary commands through CC-Bridge?**
A: CC-Bridge forwards messages to Claude Code, which decides what commands to execute. Always review Claude's responses before running commands.

**Q: Does CC-Bridge work with voice messages?**
A: No, only text messages are supported.

---

## 9. Advanced Usage

> **Note**: For detailed manual configuration, tmux management, webhook setup, and production deployment, see [Section 11: Advanced / Professional Usage](#11-advanced--professional-usage).

### 9.1 Custom Message Processing

You can customize how messages are processed by modifying the parser:

1. Edit the config:
   ```bash
   cc-bridge config --key parser.mode --value custom
   ```

2. Add custom processing rules (developer feature)

### 9.2 Integration with Automation Tools

#### Monitoring with Prometheus

CC-Bridge can export metrics for monitoring (future feature).

### 9.3 Backup and Restore

**Backup Configuration**:
```bash
# Backup .env file
cp .env .env.backup

# Backup instance data
cp ~/.claude/bridge/instances.json ~/instances-backup.json
```

**Restore Configuration**:
```bash
# Restore from backup
cp .env.backup .env
```

---

## 10. Security Best Practices

### 10.1 Protect Your Bot Token

- **Never** share your bot token publicly
- **Never** commit it to version control
- **Use** environment variables for sensitive data
- **Rotate** tokens if compromised

### 10.2 Secure Webhook URLs

- **Always** use HTTPS for webhooks (Telegram requirement)
- **Use** Cloudflare tunnel for development (automatically HTTPS)
- **Validate** incoming webhook updates (CC-Bridge does this automatically)

### 10.3 File Access Safety

- **Review** Claude's responses before running commands
- **Be** cautious with commands that modify system files
- **Use** a dedicated Claude Code session for CC-Bridge

### 10.4 Network Security

- **Don't** expose CC-Bridge directly to the internet without authentication
- **Use** a reverse proxy (nginx) for production deployments
- **Enable** firewalls to restrict access

### 10.5 Privacy Considerations

- **Be aware** that message history is stored in Claude Code session
- **Clear** conversation history regularly:
  ```bash
  /clear
  ```
- **Don't** share sensitive information via Telegram

---

## 11. Advanced / Professional Usage ⭐ NEW

### 11.1 Real YOLO Mode
For maximum automation, CC-Bridge supports **Real YOLO Mode**. This disables all safety confirmations and interaction pauses, allowing Claude to work at peak speed.

**Features:**
- Disabled **Cost Warnings**: No more "This might cost $..." prompts.
- Disabled **Feedback Surveys**: Seamless session transitions.
- **Always Thinking**: Enabled by default for complex reasoning tasks.
- **Auto-Discovery**: Automatic MCP server detection.

**How to Enable:**
Update your `src/dockers/.claude/settings.json` with the YOLO flags (see [Docker Integration Guide](DOCKER_INTEGRATION.md) for details).

### 11.2 The 'make docker-talk' Helper
Instead of opening a Telegram client to test small things, use the `make docker-talk` helper from your terminal:

```bash
make docker-talk msg="Explain the CC-Bridge architecture in one sentence"
```

This is equivalent to sending a message to your bot but happens instantly over the Docker stream.

### 11.3 System Monitoring
To keep an eye on everything, we recommend keeping a terminal window open with the server logs:

```bash
make logs-monitor
```

This section is for users who need fine-grained control over CC-Bridge beyond the automated setup.

### 11.1 Manual Configuration

If you prefer manual configuration instead of the automated setup wizard:

#### Create Configuration File

```bash
# Create config directory
mkdir -p ~/.claude/bridge

# Create config file
nano ~/.claude/bridge/config.toml
```

#### Minimal Config

```toml
[telegram]
bot_token = "123456789:ABCdefGhIJKlmNoPQRstuvWxYZ"
chat_id = 987654321
webhook_url = ""

[server]
host = "0.0.0.0"
port = 8080

[instances]
data_file = "~/.claude/bridge/instances.json"
```

#### Environment Variables

Instead of config file, you can use environment variables:

```bash
# Telegram settings
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRstuvWxYZ"
export TELEGRAM_CHAT_ID="987654321"
export TELEGRAM_WEBHOOK_URL="https://your-domain.com/webhook"

# Server settings
export PORT=8080

# Logging
export LOG_LEVEL="INFO"
```

**Priority** (highest to lowest):
1. CLI arguments
2. Environment variables
3. Config file
4. Default values

### 11.2 Manual tmux Session Management

If you need to work with tmux directly (bypassing the `claude` command):

#### Create Session Manually

```bash
# Create new session
tmux new-session -d -s my-session "claude"

# Verify it's running
tmux ls
```

#### Attach to Session

```bash
# Attach to session
tmux attach -t my-session

# Detach (press Ctrl+B then D)
```

#### Send Commands to Session

```bash
# Send text to session
tmux send-keys -t my-session "Your message here" Enter

# Get session output
tmux capture-pane -t my-session -p
```

#### Kill Session

```bash
tmux kill-session -t my-session
```

### 11.3 Manual Webhook Setup

If you need to manually configure webhooks:

#### Get Your Chat ID Manually

```bash
# 1. Send a message to your bot
# 2. Visit this URL in your browser
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"

# 3. Find your chat_id in the response
```

#### Set Webhook Manually

```bash
# With tunnel URL
export TUNNEL_URL="https://abc123.trycloudflare.com"
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${TUNNEL_URL}"

# Or with custom domain
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=https://your-domain.com/webhook"
```

#### Verify Webhook

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

#### Delete Webhook

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook"
```

### 11.4 Manual Cloudflare Tunnel

If you need to run cloudflared manually:

#### Start Tunnel

```bash
cloudflared tunnel --url http://localhost:8080
```

Look for output like:
```
2024-01-27T10:00:00Z INFO Your quick Tunnel has been created!
Visit it at: https://abc123.trycloudflare.com
```

#### Use with CC-Bridge

```bash
# Start tunnel in background
cloudflared tunnel --url http://localhost:8080 &
TUNNEL_PID=$!

# Get tunnel URL from logs or manual inspection
TUNNEL_URL="https://abc123.trycloudflare.com"

# Set webhook
cc-bridge webhook set $TUNNEL_URL

# Later, stop tunnel
kill $TUNNEL_PID
```

### 11.5 Advanced Instance Management

#### Instance Data File

Instance metadata is stored in:
```
~/.claude/bridge/instances.json
```

Format:
```json
{
  "instances": {
    "my-instance": {
      "name": "my-instance",
      "pid": 12345,
      "tmux_session": "claude-my-instance",
      "cwd": "/Users/you/projects/my-project",
      "status": "running",
      "created_at": "2025-01-27T10:00:00",
      "last_activity": "2025-01-27T14:30:00"
    }
  }
}
```

#### Manual Instance Status Check

```python
# Check if process is running
import os
try:
    os.kill(pid, 0)  # Signal 0 doesn't actually send signal
    # Process is running
except OSError:
    # Process is dead
    pass
```

### 11.6 Crontab Automation

CC-Bridge can automatically configure health checks in crontab. If you need to manage this manually:

#### View Current Crontab

```bash
crontab -l
```

#### Add Health Check Manually

```bash
crontab -e
```

Add:
```cron
# ===== CC-BRIDGE HEALTH CHECK =====
*/5 * * * * cc-bridge health --quiet
# ===== END CC-BRIDGE =====
```

#### Remove CC-Bridge Entries

```bash
# Use the crontab manager
cc-bridge claude cron remove

# Or manually edit crontab
crontab -e
# Delete lines between markers
```

### 11.7 Debug Mode

#### Enable Debug Logging

```bash
# Via environment variable
export LOG_LEVEL=DEBUG
cc-bridge server

# Or update config
cc-bridge config logging.level DEBUG
cc-bridge server
```

#### View Instance Process

```bash
# Get instance PID
cat ~/.claude/bridge/instances.json | grep pid

# Check process details
ps aux | grep <pid>

# View process tree
pstree -p <pid>
```

#### Monitor tmux Session

```bash
# Attach to see live output
cc-bridge claude attach my-instance

# Or directly with tmux
tmux attach -t claude-my-instance
```

### 11.8 Production Deployment

#### Using Systemd

Create `/etc/systemd/system/cc-bridge.service`:

```ini
[Unit]
Description=CC-Bridge Webhook Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/cc-bridge
Environment="PATH=/path/to/venv/bin"
ExecStart=/path/to/venv/bin/cc-bridge server
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable cc-bridge
sudo systemctl start cc-bridge
sudo systemctl status cc-bridge
```

#### Using Docker

See README.md for Docker deployment examples.

---

## Appendix A: Quick Reference

### Essential Commands

```bash
# Setup (one-time)
cc-bridge setup

# Instance management
cc-bridge claude start my-instance              # Start new instance
cc-bridge claude start project-a --cwd ~/proj   # With custom directory
cc-bridge claude list                          # List all instances
cc-bridge claude attach my-instance             # Connect to instance
cc-bridge claude stop my-instance               # Stop instance
cc-bridge claude restart my-instance            # Restart instance

# Server
cc-bridge server                                # Start webhook server

# Health check
cc-bridge health                                # Check system health

# Logs
cc-bridge logs --follow                         # View real-time logs

# Config
cc-bridge config                                # View all config
```

### Default Configuration

| Setting | Default Value | Description |
|---------|---------------|-------------|
| Server Host | 0.0.0.0 | All interfaces |
| Server Port | 8080 | Webhook server port |
| tmux Session | claude | Claude Code session |
| Log Level | INFO | Logging verbosity |
| Log Format | json | Structured logging |
| Health Check | Every 5 min | Monitoring interval |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot authentication |
| `TELEGRAM_WEBHOOK_URL` | Webhook URL |
| `TMUX_SESSION` | tmux session name |
| `PORT` | Server port |
| `LOG_LEVEL` | Logging verbosity |

---

## Appendix B: Example Configurations

### Minimal Configuration

```toml
[telegram]
bot_token = "123456789:ABCdefGhIJKlmNoPQRstuvWxYZ"

[tmux]
session = "claude"
```

### Production Configuration

```toml
[telegram]
bot_token = "123456789:ABCdefGhIJKlmNoPQRstuvWxYZ"
webhook_url = "https://your-domain.com/webhook"

[server]
host = "127.0.0.1"
port = 8080
reload = false

[tmux]
session = "claude"
auto_attach = true

[logging]
level = "WARNING"
format = "json"
file = "/var/log/cc-bridge/bridge.log"
max_bytes = 52428800  # 50MB
backup_count = 10

[health]
enabled = true
interval_minutes = 1

[tunnel]
auto_start = true
```

### Development Configuration

```toml
[telegram]
bot_token = "123456789:ABCdefGhIJKlmNoPQRstuvWxYZ"

[server]
host = "localhost"
port = 8080
reload = true  # Enable auto-reload

[tmux]
session = "claude-dev"
auto_attach = true

[logging]
level = "DEBUG"
format = "text"
file = "~/.claude/bridge/logs/dev.log"

[health]
enabled = true
interval_minutes = 1
```

---

## Appendix C: Troubleshooting Checklist

When something isn't working, go through this checklist:

- [ ] Is Claude Code running in tmux? (`tmux ls`)
- [ ] Is the CC-Bridge server running? (`cc-bridge health`)
- [ ] Is the bot token correct? (`cc-bridge config --key telegram.bot_token`)
- [ ] Is the webhook set? (`cc-bridge webhook info`)
- [ ] Are the logs showing errors? (`cc-bridge logs --follow`)
- [ ] Is the tmux session name correct? (`cc-bridge config --key tmux.session`)
- [ ] Can you manually send a message to Claude in tmux?
- [ ] Have you tried restarting the server?
- [ ] Have you tried running setup again? (`cc-bridge setup`)

---

## Document Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-02-02 | Initial Beta Release: Standardized Docker EXEC streaming, unified plugin management, and Real YOLO Mode. |
| 1.2.0 | 2025-01-29 | Major architecture update: Documented direct webhook processing model, removed references to deprecated hook-based system |
| 1.1.0 | 2025-01-27 | Major update: Added automated setup, `claude` command, simplified user flow, added Advanced/Professional section |
| 1.0.0 | 2025-01-27 | Initial user manual |

---

**Need Help?**

- **Documentation**: https://github.com/hanxiao/claudecode-telegram
- **Issues**: https://github.com/hanxiao/claudecode-telegram/issues
- **Discussions**: https://github.com/hanxiao/claudecode-telegram/discussions

**License**: MIT
**Made with ❤️ by the CC-Bridge team
