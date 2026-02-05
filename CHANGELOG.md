# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-02-04

### Added
- **TSX Component Rendering**: Replaced legacy string formatting with a modern TSX-based component architecture (`src/gateway/output`) for unified and beautiful reports.
- **Content Negotiation**: Intelligent server-side rendering in the `/health` endpoint, serving raw JSON for APIs or formatted reports for Terminal/Telegram based on `Accept` headers.
- **Enhanced System Diagnostics**:
  - Live Docker container status (image, uptime, and health) for agent instances.
  - Detailed filesystem path verification and access status reporting.
  - Transparent (non-sensitive) environment variable listing in health checks.
- **Infrastructure Stability**:
  - Daily log rotation using `pino-roll` to prevent unbounded log growth and improve maintainability.
  - Workspace-aware logging: agent logs now include their workspace name (e.g., `[Agent:cc-bridge]`) for easier multi-project debugging.
- **Telegram API Flexibility**: Enhanced `sendMessage` with support for custom `parse_mode` (defaulting to Markdown).

### Changed
- **Streamlined Bot Commands**:
  - Consolidated diagnostic commands: renamed `/bridge_status` to `/status`.
  - Refactored `MenuBot` and its help system to remove redundant shortcuts and simplify the interface.
- **Improved Terminal Output**: Added trailing newlines to all TSX-rendered reports for a clean, professional CLI experience.
- **Modernized Internal Logic**: Fully decoupled data collection in `health.ts` from presentation logic in TSX components.

### Fixed
- Improved alignment and visual consistency of headers and sections across Terminal and Telegram.
- Resolved shell prompt overlap issues by ensuring all CLI outputs end with a newline.

## [0.1.0] - 2026-02-02

### Added
- **Docker EXEC Communication**: Replaced named pipes with robust bidirectional `docker exec` streaming for container interaction.
- **Container Agent**: Dedicated `container_agent.py` running inside Docker to bridge Python commands with Claude Code print mode.
- **Hybrid Plugin Management**: Intelligent volume mounting for `.claude/plugins` (cache/marketplaces) ensuring host-container synchronization.
- **Real YOLO Mode**: Aggressive automation settings in `settings.json` (disabled cost warnings, feedback surveys, and enabled always-thinking).
- **Workspace Auto-Trust**: Automated `.claude.json` generation to bypass interactive "Trust folder" prompts.
- **Improved Makefile**: New developer-friendly targets:
  - `make docker-talk msg="..."`: Direct host-to-container communication.
  - `make logs-monitor`: Real-time log streaming.
  - `make daemon-restart`: Reliable system-level daemon management with automatic port clearing.
- **Robust Telegram Messaging**:
  - Global HTML escaping to prevent API errors.
  - 10-second chunking for long-running Claude outputs.
  - Improved retry logic and logging for media/long messages.
- **Auto-Discovery**: Support for dynamic Docker container detection via labels.

### Changed
- **Unified Logging**: All logs centralized at `~/.claude/bridge/logs/`.
- **Refactored Architecture**: Decoupled instance lifecycle from bridge server using a streamlined `InstanceInterface` adapter pattern.
- **Updated Setup**: Automated `cc-bridge setup` with tunnel URL parsing and environment generation.

### Fixed
- Resolved "No output" hangs in Telegram by implementing chunked I/O relay.
- Fixed `asyncio.run` deadlocks in status checks by moving to fully asynchronous `docker-py` calls.
- Corrected argument ordering in Claude Code command execution (`-p` before `-c`).
- Fixed system daemon persistence issues on macOS by standardizing absolute paths in `.plist` configurations.

---
[0.1.0]: https://github.com/hanxiao/claudecode-telegram/releases/tag/v0.1.0
