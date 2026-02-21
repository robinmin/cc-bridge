# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.3] - 2026-02-21

### ✨ New Features

- **Mini-App Lifecycle Tooling**:
  - Added first-class mini-app workflow around `src/apps/*.md` and `src/gateway/apps/driver.ts`
  - Added make/host commands for mini-app lifecycle management:
    - `app-new`, `app-list`, `app-run`, `app-schedule`, `app-list-tasks`, `app-unschedule`
  - Added scripts for mini-app scheduling operations:
    - `scripts/schedule_miniapp.ts`, `scripts/list_miniapp_tasks.ts`, `scripts/unschedule_miniapp.ts`
- **Reusable Packages Expansion**:
  - Added reusable modules under `src/packages/` for async helpers, markdown/frontmatter parsing, scheduler logic, text chunking, and validation.

### 🔧 Improvements

- **Architecture Cleanup**:
  - Strengthened package boundaries by keeping gateway concrete runtime wiring in `src/agent/runtime/gateway-adapter.ts`
  - Reduced cross-layer coupling by keeping `src/packages/agent-runtime` as contracts-focused.
- **Configuration Handling**:
  - Upgraded config loading to deep merge nested objects so partial config blocks no longer drop defaults.
- **Scheduler Robustness**:
  - Added re-entrancy guard to task scheduler ticks to prevent overlapping executions.
- **IPC Robustness**:
  - Hardened TCP/Host/Remote/Unix IPC response parsing for non-JSON and empty responses.

### 🐛 Fixes

- Fixed Host IPC unix path handling bug in `HostIpcClient` (runtime/compile issue in unix flow).
- Fixed missing IPC type imports in fallback factory path.
- Added safer JSON handling for channel-specific webhook endpoints (`/webhook/telegram`, `/webhook/feishu`) to avoid malformed-body crashes.
- Hardened plugin discovery entry parsing to tolerate malformed plugin cache rows.
- Fixed history cache invalidation to clear all relevant limits instead of a fixed subset.
- Stabilized logger init tests by isolating module imports to avoid test-order side effects.

### 📝 Documentation

- Updated `docs/USER_MANUAL.md` to align with current command set and mini-app lifecycle workflow.
- Updated `docs/DEVELOPER_SPEC.md` to reflect current architecture, package layout, webhook routes, and make targets.

---

## [0.6.0] - 2026-02-12

### ✨ New Features

- **Plugin Discovery Commands**: New commands to explore Claude Code plugins from messaging platforms
  - `/agents` - List all available Claude Code agents from installed plugins
  - `/commands` - List all slash commands with argument hints
  - `/skills` - List all agent skills grouped by plugin
  - Discovery cache service for fast plugin metadata lookup
- **Task Scheduler**: Built-in scheduler for automated Claude Code prompts
  - `/schedulers` - View all scheduled tasks
  - `/scheduler_add <instance> <once|recurring> <schedule> <prompt>` - Create scheduled tasks
  - `/scheduler_del <task_id>` - Delete scheduled tasks
  - Automatic uploads cleanup task

### 🔧 Improvements

- **Agent HTTP Server**: Enhanced container API with improved session management and request tracking
- **Container Command Handler**: Extended script with additional commands for agent server management

### 🐛 Fixes

- **Communication Channel Reliability**: Multiple fixes for communication channel stability

---

## [0.5.0] - 2026-02-11

### 🐛 Fixes

- **Internal Communication Fixes**: Resolved various communication channel issues to improve reliability

---

## [0.4.0] - 2026-02-08

### ✨ New Features

- **Feishu/Lark Channel Integration**: Added support for Feishu (飞书) and Lark enterprise messaging platforms
  - Multi-domain support (feishu.cn and larksuite.com)
  - AES-256-CBC encryption with SHA-256 key derivation for secure webhooks
  - URL verification challenge handling for event subscription setup
  - Markdown and text message format support
- **Webhook Route Separation**: Split `/webhook` into channel-specific endpoints
  - `/webhook/telegram` - Telegram webhook with channel-specific preprocessing
  - `/webhook/feishu` - Feishu/Lark webhook with encryption support
  - Shared message processing pipeline for consistent handling
- **Workspace Database Schema**: Added `workspace_name` column to messages table for multi-workspace support

### 🔧 Improvements

- **Simplified Makefile**: Streamlined target naming for better developer experience
  - `dev` instead of `bridge-dev` - Start development server
  - `test` / `test-quick` - Run tests with/without coverage
  - `lint` / `format` / `check` - Code quality targets
  - `gateway-install` instead of `setup-system` - Clear naming
  - `status` instead of `bridge-status` - Health check command
  - `clean` - Remove build artifacts and temporary files
- **IPC Connection Handling**: Added proper connection close handling for Unix socket IPC
  - `Connection: close` header prevents connection reuse issues
  - Improved reliability for one-off request/response patterns

### 🐛 Fixes

- **Feishu Encryption Algorithm**: Fixed incorrect encryption implementation
  - Changed from MD5 to SHA-256 key derivation
  - Switched from AES-128 to AES-256-CBC
  - Updated IV extraction to use first 16 bytes of encrypted data
- **Feishu Message Format**: Fixed message content format
  - Changed from `post` format to `text` format for simpler messages
  - Proper content serialization for Feishu API requirements
- **Test Validation Errors**: Fixed webhook validation test expectations
  - Updated test to handle Zod validation error format correctly
  - Changed invalid JSON test to expect 400 (correct HTTP status) instead of 500

### Migration Notes

If upgrading from v0.3.0:

1. **Environment Variables**: Add Feishu/Lark configuration
   ```bash
   FEISHU_APP_ID=your_app_id
   FEISHU_APP_SECRET=your_app_secret
   FEISHU_DOMAIN=feishu  # or lark
   FEISHU_ENCRYPT_KEY=your_encrypt_key
   FEISHU_VERIFICATION_TOKEN=your_verification_token
   ```
2. **Webhook URLs**: Update to use new channel-specific endpoints
   - Telegram: `https://your-domain.com/webhook/telegram`
   - Feishu: `https://your-domain.com/webhook/feishu`
3. **Makefile Targets**: Use new simplified target names
   - `make dev` instead of `make bridge-dev`
   - `make gateway-install` instead of `make setup-system`

---

## [0.3.0] - 2026-02-07

### 💥 Breaking Changes

- **Technology Stack Migration**: Complete rewrite from Python/FastAPI to TypeScript/Bun + Hono for improved performance and type safety.
  - Removed all Python dependencies (uv, ruff, pytest)
  - Replaced FastAPI with Hono web framework
  - Migrated to Bun runtime and package manager
- **Project Structure**: Restructured codebase with new `src/packages/` organization for better modularity
- **Testing Framework**: Switched from pytest to Bun test with updated test patterns

### ✨ New Features

- **Multi-Protocol IPC Support**: Flexible IPC client factory supporting:
  - TCP socket communication for fast local development
  - Unix socket for inter-process communication
  - Docker exec for container-based deployment
  - Host mode for running without Docker
  - Remote mode for distributed systems
- **Circuit Breaker Pattern**: Added resilience layer with automatic failure detection and recovery for IPC clients
- **Workspace Support**: Multi-workspace session management with isolated environments
- **MCP & Plugins Integration**: Enabled Model Context Protocol and plugin support for extensibility
- **HTTP API Server**: New REST API for agent container with endpoints for execute, health, sessions, and status queries

### 🔧 Improvements

- **Enhanced Makefile**: Simplified code quality targets with Biome integration
  - `make code-fix-all`: Safe auto-fixes only
  - `make code-fix-unsafe`: All auto-fixes including code changes
  - `make code-check`: Strict validation with error-on-warnings
- **Type Safety**: Full TypeScript coverage with strict type checking
- **Performance**: Faster execution with Bun runtime and optimized IPC communication
- **Code Quality**: Integrated Biome for linting and formatting (replacing Ruff)
- **Error Handling**: Improved error types and structured logging throughout the codebase

### 🐛 Fixes

- Fixed type safety issues with proper non-null assertion handling
- Resolved import path inconsistencies after code consolidation
- Fixed TmuxManager method accessibility for testing with protected methods
- Corrected unused variable warnings with proper underscore prefixing

### 🔒 Security

- Improved API key validation and authentication middleware
- Enhanced rate limiting with configurable windows

### Migration Notes

If upgrading from v0.2.0:

1. **Install Bun**: `curl -fsSL https://bun.sh/install | bash`
2. **Update dependencies**: `bun install`
3. **Update Makefile targets**: Use `make code-fix-all` instead of `make format`
4. **Python removal**: All Python code has been migrated to TypeScript
5. **Configuration**: Update environment variables to use new `src/dockers/.env.example`

---

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
[0.6.3]: https://github.com/hanxiao/claudecode-telegram/releases/tag/v0.6.3
[0.6.0]: https://github.com/hanxiao/claudecode-telegram/releases/tag/v0.6.0
[0.5.0]: https://github.com/hanxiao/claudecode-telegram/releases/tag/v0.5.0
[0.4.0]: https://github.com/hanxiao/claudecode-telegram/releases/tag/v0.4.0
[0.3.0]: https://github.com/hanxiao/claudecode-telegram/releases/tag/v0.3.0
[0.2.0]: https://github.com/hanxiao/claudecode-telegram/releases/tag/v0.2.0
[0.1.0]: https://github.com/hanxiao/claudecode-telegram/releases/tag/v0.1.0
