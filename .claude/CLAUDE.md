## CLAUDE.md

## Quick Commands
### Make targets
Always prioritize to use the following make targets:

| make target | Functionality |
|-----|-----|
| help               | Show this help message |
| status             | Run system health check |
| setup              | Initial project setup (interactive) |
| install            | Install dependencies using uv |
| dev                | Start development server with auto-reload |
| test               | Run pytest with coverage |
| test-quick         | Run tests without coverage |
| lint               | Run ruff linter |
| format             | Format code with ruff |
| typecheck          | Run ty type checker |
| fix                | Auto-fix lint errors + format code |
| all                | Run all checks (lint, format, typecheck, test) |
| fix-all            | Auto-fix everything, then validate |
| start              | Start cc-bridge service |
| stop               | Stop cc-bridge service |
| restart            | Restart cc-bridge service |
| setup-service      | Install deps + LaunchAgent (recommended) |
| service-uninstall  | Uninstall LaunchAgent |
| daemon-start       | Start system daemon |
| daemon-stop        | Stop system daemon |
| daemon-restart     | Restart system daemon |
| setup-daemon       | Install deps + LaunchDaemon (servers) |
| daemon-uninstall   | Uninstall LaunchDaemon |
| monitor            | Monitor server logs |
| build              | Build distribution packages |
| clean              | Clean build artifacts |

### cc-bridge Commands
Or, we can use './.venv/bin/cc-bridge' commands directly as shown below:

```bash
Usage: cc-bridge [OPTIONS] COMMAND [ARGS]...

 Telegram bot bridge for Claude Code

╭─ Options ───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ --install-completion          Install completion for the current shell.                                             │
│ --show-completion             Show completion for the current shell, to copy it or customize the installation.      │
│ --help                        Show this message and exit.                                                           │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

| Commands | Functionality |
|-----|-----|
| claude-attach   | Attach to a running Claude Code instance. |
| claude-list     | List all Claude Code instances. |
| claude-restart  | Restart a Claude Code instance. |
| claude-start    | Start a new Claude Code instance. |
| claude-stop     | Stop a Claude Code instance. |
| config          | Configuration management. |
| docker          | Manage Docker-based Claude instances |
| health          | Run health checks. |
| hook-stop       | Send Claude response to Telegram (Stop hook). |
| server          | Start the FastAPI webhook server. |
| setup           | Interactive setup wizard. |
| tunnel          | Cloudflare tunnel management. |

