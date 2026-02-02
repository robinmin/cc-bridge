# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-02-02

### Added
- **Docker EXEC Communication**: Replaced named pipes with robust bidirectional `docker exec` streaming for container interaction.
- **Container Agent**: Dedicated `container_agent.py` running inside Docker to bridge Python commands with Claude Code print mode.
- **Hybrid Plugin Management**: Intelligent volume mounting for `.claude/plugins` (cache/marketplaces) ensuring host-container synchronization.
- **Real YOLO Mode**: Aggressive automation settings in `settings.json` (disabled cost warnings, feedback surveys, and enabled always-thinking).
- **Workspace Auto-Trust**: Automated `.claude.json` generation to bypass interactive "Trust folder" prompts.
- **Improved Makefile**: New developer-friendly targets:
  - `make talk msg="..."`: Direct host-to-container communication.
  - `make monitor`: Real-time log streaming.
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
