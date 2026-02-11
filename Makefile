.PHONY: help all dev test test-quick lint format check status clean \
	gateway-start gateway-stop gateway-restart gateway-install gateway-uninstall logs-monitor \
	docker-restart docker-stop docker-logs docker-status \
	talk talk-response msg-sessions msg-health msg-create-session msg-kill-session msg-help

# Default target
.DEFAULT_GOAL := help

# Variables
BUN := bun
BIOME := npx @biomejs/biome
PACKAGE_NAME := cc-bridge

# Package test files (shared across multiple targets)
PACKAGES_TESTS := src/packages/tests/config.test.ts src/packages/tests/config-coverage.test.ts src/packages/tests/errors.test.ts src/packages/tests/errors-coverage.test.ts src/packages/tests/logger.test.ts

# User adaptation variables (moved to src/dockers/.env)
# USER_NAME, USER_ID, GROUP_ID, WORKSPACE_NAME are now configured in .env

# Environment mode (keep in Makefile for test commands)
export NODE_ENV

# =============================================================================
# Help
# =============================================================================

## help: Show this help message
help:
	@echo "$(PACKAGE_NAME) - Makefile targets"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## //' | column -t -s':' | sed 's/^/  /'

## all: Run all checks (lint + test)
all: check

# =============================================================================
# Setup
# =============================================================================

## setup-dev: Install dependencies for development
setup-dev:
	@echo "Installing dependencies..."
	$(BUN) install

## gateway-install: Install as system daemon (starts at boot)
gateway-install: setup-dev
	@echo "Installing cc-bridge system daemon..."
	@sudo ./scripts/install-daemon.sh

## gateway-uninstall: Uninstall system daemon
gateway-uninstall:
	@echo "Uninstalling cc-bridge system daemon..."
	@sudo ./scripts/uninstall-daemon.sh

# =============================================================================
# Development
# =============================================================================

## dev: Start development server (with auto-reload)
dev:
	@echo "Starting development server..."
	$(BUN) run start:gateway

## test: Run tests with coverage
test:
	@echo "Running tests with coverage..."
	@echo ""
	@exit_code=0; \
	NODE_ENV=test $(BUN) test src/agent/tests/ --coverage --coverage-reporter=text || exit_code=$$?; \
	echo ""; \
	NODE_ENV=test $(BUN) test src/gateway/tests/ --coverage --coverage-reporter=text || { echo "⚠️  Gateway tests have failures (see above)"; exit_code=1; }; \
	echo ""; \
	NODE_ENV=test $(BUN) test $(PACKAGES_TESTS) --coverage --coverage-reporter=text || { echo "⚠️  Some package tests failed (see above)"; exit_code=1; }; \
	echo ""; \
	echo "Note: src/packages/tests/ipc_adapter.test.ts skipped - has process.exit() call that kills test runner"; \
	exit $$exit_code

## test-quick: Run tests without coverage
test-quick:
	@echo "Running tests..."
	@exit_code=0; \
	NODE_ENV=test $(BUN) test src/agent/tests/ || exit_code=$$?; \
	NODE_ENV=test $(BUN) test src/gateway/tests/ || exit_code=$$?; \
	NODE_ENV=test $(BUN) test $(PACKAGES_TESTS) || exit_code=$$?; \
	exit $$exit_code

# =============================================================================
# Code Quality
# =============================================================================

## lint: Show lint issues (no fixes)
lint:
	@echo "Checking lint issues..."
	$(BIOME) lint src

## format: Apply auto-fixes (format + lint fixes)
format:
	@echo "Applying auto-fixes..."
	$(BIOME) check --write src

## check: Run all validation (lint + test, fails on warnings)
check:
	@echo "Running validation..."
	@exit_code=0; \
	$(BIOME) check --error-on-warnings src || exit_code=$$?; \
	echo "Running tests..."; \
	NODE_ENV=test $(BUN) test src/agent/tests/ --coverage || exit_code=$$?; \
	NODE_ENV=test $(BUN) test src/gateway/tests/ --coverage || exit_code=$$?; \
	NODE_ENV=test $(BUN) test $(PACKAGES_TESTS) --coverage || exit_code=$$?; \
	if [ $$exit_code -eq 0 ]; then echo "✅ All checks passed!"; fi; \
	exit $$exit_code

# =============================================================================
# System Gateway
# =============================================================================

## gateway-start: Start system gateway
gateway-start:
	@echo "Starting cc-bridge gateway..."
	@sudo pkill -9 -f "bun run src/gateway/index.ts" 2>/dev/null || true
	@sudo lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@sudo lsof -ti :8080 | xargs sudo kill -9 2>/dev/null || true
	@sudo launchctl start com.cc-bridge.daemon || { echo "❌ Run 'make gateway-install' first."; exit 1; }
	@echo "✅ Gateway started."

## gateway-stop: Stop system gateway
gateway-stop:
	@echo "Stopping cc-bridge gateway..."
	@sudo launchctl stop com.cc-bridge.daemon || { echo "⚠️  Gateway not running."; exit 1; }
	@sudo pkill -9 -f "bun run src/gateway/index.ts" 2>/dev/null || true
	@sudo lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@sudo lsof -ti :8080 | xargs sudo kill -9 2>/dev/null || true
	@echo "✅ Gateway stopped."

## gateway-restart: Restart system gateway
gateway-restart:
	@echo "Restarting cc-bridge gateway..."
	@sudo launchctl stop com.cc-bridge.daemon 2>/dev/null || true
	@sudo pkill -9 -f "bun run src/gateway/index.ts" 2>/dev/null || true
	@sudo lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@sudo lsof -ti :8080 | xargs sudo kill -9 2>/dev/null || true
	@sudo launchctl start com.cc-bridge.daemon || { echo "❌ Run 'make gateway-install' first."; exit 1; }
	@echo "✅ Gateway restarted."

## status: Show gateway health status
status:
	@curl -s -f --connect-timeout 3 "http://localhost:8080/health" >/dev/null 2>&1 && echo "✅ Gateway is running" || { echo "❌ Gateway is NOT responding"; echo "   Start with: make gateway-start"; exit 1; }

## logs-monitor: Monitor gateway logs in real-time
logs-monitor:
	@tail -f data/logs/combined.log

# =============================================================================
# Docker
# =============================================================================

## docker-restart: Rebuild Docker image and restart container
docker-restart:
	@echo "Rebuilding Docker image..."
	@cd src/dockers && docker-compose build --no-cache
	@echo "Restarting Docker container..."
	@cd src/dockers && docker-compose down
	@cd src/dockers && docker-compose up -d
	@echo "✅ Docker image rebuilt and container restarted"

## docker-stop: Stop Docker container
docker-stop:
	@echo "Stopping Docker container..."
	@cd src/dockers && docker-compose down
	@echo "✅ Docker container stopped"

## docker-logs: Monitor Docker container logs in real-time
docker-logs:
	@cd src/dockers && docker-compose logs -f claude-agent

## docker-status: Show Docker container status and running processes
docker-status:
	@echo "=== Container Status ==="
	@cd src/dockers && docker-compose ps
	@echo ""
	@echo "=== Running Processes ==="
	@docker exec claude-cc-bridge ps aux

# =============================================================================
# Cleanup
# =============================================================================

## clean: Remove build artifacts and temporary files
clean:
	@echo "Cleaning build artifacts and temporary files..."
	@rm -rf build/ dist/ .coverage coverage/ .biome_cache/
	@rm -rf data/logs/* data/ipc/*
	@echo "✅ Clean complete"

# =============================================================================
# Claude Message Testing (via docker exec)
# =============================================================================

## talk: Send test message to Claude via tmux (full flow: request → Claude → response → callback)
talk: MSG ?= "Hello Claude"
talk:
	@echo "Sending: $(MSG)"
	@export REQUEST_ID=$$(uuidgen 2>/dev/null || echo "test-$$(date +%s)"); \
	export CHAT_ID=12345; \
	export WORKSPACE_NAME=cc-bridge; \
	docker exec -e REQUEST_ID -e CHAT_ID -e WORKSPACE_NAME claude-cc-bridge /app/scripts/container_cmd.sh request "$(MSG)"

## msg-sessions: List tmux sessions
msg-sessions:
	@docker exec claude-cc-bridge bash -c 'tmux list-sessions -F "#{session_name}"' 2>/dev/null || echo "  None"

## msg-create-session: Create tmux session
msg-create-session: SESSION_NAME ?= claude-test
msg-create-session:
	@docker exec claude-cc-bridge bash -c 'tmux new-session -d -s "$(SESSION_NAME)" "bash" 2>/dev/null && tmux set-environment -t "$(SESSION_NAME)" WORKSPACE_NAME cc-bridge && tmux set-environment -t "$(SESSION_NAME)" CHAT_ID test' || echo "Session may exist"

## msg-kill-session: Kill tmux session
msg-kill-session: SESSION_NAME ?= claude-test
msg-kill-session:
	@docker exec claude-cc-bridge bash -c 'tmux kill-session -t "$(SESSION_NAME)" 2>/dev/null' || true

## msg-health: Health check
msg-health:
	@curl -s http://localhost:8080/health || echo '{"status":"unhealthy"}'

## msg-help: Show container_cmd.sh help
msg-help:
	@docker exec claude-cc-bridge /app/scripts/container_cmd.sh help
