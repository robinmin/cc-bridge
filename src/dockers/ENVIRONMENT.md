# Environment Configuration

## Overview

This project uses environment variables for configuration. The `.env` file is gitignored for security.

## Quick Start

1. Copy the example environment file:
   ```bash
   cp src/dockers/.env.example src/dockers/.env
   ```

2. Edit `src/dockers/.env` and add your API keys

3. Start the services:
   ```bash
   make docker-restart
   ```

## Environment Variables

### Gateway (production)

- `HEALTH_API_KEY` - Optional API key for health endpoint authentication
- `PORT` - Gateway server port (default: 8080)
- `NODE_ENV` - Environment mode (development/production)

### Telegram Bot

- `TELEGRAM_BOT_TOKEN` - Your Telegram bot token from @BotFather

### Claude / Anthropic

- `ANTHROPIC_API_KEY` - Your Anthropic API key for Claude

### Workspace

- `PROJECTS_ROOT` - Root directory for projects (default: ~/xprojects)
- `WORKSPACE_NAME` - Current workspace name (default: cc-bridge)
- `IPC_MODE` - IPC mode (`callback_payload` or `filesystem`)

### MCP Servers (for Claude Code)

See `src/dockers/.env.example` for the complete list of MCP server configuration:

- `REF_API_KEY` - Ref MCP server API key
- `BRAVE_API_KEY` - Brave Search API key
- `HUGGINGFACE_TOKEN` - HuggingFace API token
- `JUPYTER_URL` - Jupyter server URL
- `JUPYTER_TOKEN` - Jupyter authentication token
- `WANDB_API_KEY` - Weights & Biases API key

## Security Notes

1. **Never commit `.env` files** - They are already in `.gitignore`
2. **Rotate exposed keys immediately** - If you accidentally commit API keys, rotate them
3. **Use different keys for dev/prod** - Use separate API keys for development and production
4. **Set HEALTH_API_KEY in production** - Protect your health endpoint with authentication

## Docker Compose Environment Variables

The `src/dockers/docker-compose.yml` file uses these variables with defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE_NAME` | cc-bridge | Current workspace name |
| `IPC_MODE` | filesystem | IPC mode (`callback_payload` or `filesystem`) |
| `BRAVE_API_KEY` | *(required)* | Brave Search API key |

## See Also

- `.env.example` - Template for environment variables
- `src/dockers/docker-compose.yml` - Docker service configuration
- `src/gateway/consts.ts` - Configuration constants and defaults
