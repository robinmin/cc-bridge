.PHONY: bridge-dev test test-quick code-lint code-format code-check code-all code-fix-all env-install dist-build dist-clean help bridge-status gateway-start gateway-stop gateway-restart gateway-setup gateway-uninstall

# Default target
.DEFAULT_GOAL := help

# Variables
BUN := bun
BIOME := npx @biomejs/biome
PACKAGE_NAME := cc-bridge
VERSION := 0.1.0

# User adaptation variables
USER_NAME := $(shell whoami)
USER_ID := $(shell id -u)
GROUP_ID := $(shell id -g)
WORKSPACE_NAME := cc-bridge

export USER_NAME
export USER_ID
export GROUP_ID
export WORKSPACE_NAME

# =============================================================================
# Help
# =============================================================================

## help: Show this help message
help:
	@echo "$(PACKAGE_NAME) - Makefile targets"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## //' | awk -F': ' '{printf "  %-18s %s\n", $$1, $$2}'

## all: Run all checks (alias for code-all)
all: code-all

## bridge-status: Run system health check
bridge-status:
	@curl -s -f --connect-timeout 3 "http://localhost:8080/health" || (echo "\x1b[31m✗ Gateway Server is NOT RESPONDING\x1b[0m" && echo "  Check if service is running: \x1b[33mmake gateway-start\x1b[0m" && exit 1)

## docker-build: Build docker image (with host user adaptation)
docker-build:
	@echo "Building docker image for user $(USER_NAME)..."
	@docker build -t cc-bridge -f src/dockers/Dockerfile.agent \
		--build-arg USER_NAME=$(USER_NAME) \
		--build-arg USER_ID=$(USER_ID) \
		--build-arg GROUP_ID=$(GROUP_ID) .

## docker-run: Run docker container with host authentication (using docker-compose)
docker-run:
	@echo "Running docker container with docker-compose..."
	@docker compose -f src/dockers/docker-compose.yml run --rm claude-agent bash

## docker-restart: Rebuild and restart docker container (using docker-compose)
docker-restart:
	@echo "Rebuilding and restarting with docker-compose..."
	@docker compose -f src/dockers/docker-compose.yml up -d --build --force-recreate

## docker-talk: Talk to Claude inside Docker via gateway-like IPC (e.g., make docker-talk msg="Hello")
docker-talk:
	@if [ -z "$(msg)" ]; then \
		echo "Usage: make docker-talk msg=\"Your message here\""; \
		exit 1; \
	fi
	@$(BUN) run scripts/talk-to-agent.ts "$(msg)"

## docker-sync-plugins: Sync Claude plugins inside the container
docker-sync-plugins:
	@echo "Syncing plugins inside the container..."
	@docker exec -it claude-$(WORKSPACE_NAME) bash ./scripts/sync-plugins.sh

# =============================================================================
# Setup
# =============================================================================

## bridge-setup: Initial project setup (interactive)
bridge-setup:
	@echo ""
	@echo "=================================="
	@echo "cc-bridge Setup"
	@echo "=================================="
	@echo ""
	@echo "1. Development only (no service)"
	@echo "2. System Gateway (starts at boot - recommended)"
	@echo ""
	@read -p "Enter choice [1-2] (default: 2): " choice; \
	echo ""; \
	case $$choice in \
		1) $(MAKE) env-install; echo "Done! Run 'make bridge-dev' to start.";; \
		2) $(MAKE) gateway-setup;; \
		*) $(MAKE) gateway-setup;; \
	esac

## env-install: Install dependencies using bun
env-install:
	@echo "Installing dependencies..."
	$(BUN) install

# =============================================================================
# Development
# =============================================================================

## bridge-dev: Start development server with auto-reload
bridge-dev:
	@echo "Starting development server..."
	$(BUN) run start:gateway

## test: Run bun tests with coverage
test:
	@echo "Running tests..."
	$(BUN) test --coverage

## test-quick: Run bun tests without coverage
test-quick:
	@echo "Running tests (quick)..."
	$(BUN) test

## test-agent: Run agent unit tests
test-agent:
	@echo "Running agent tests..."
	$(BUN) test src/agent

# =============================================================================
# Code Quality
# =============================================================================

## code-lint: Show lint issues (no fixes)
code-lint:
	@echo "Checking lint issues..."
	$(BIOME) lint src

## code-fix-all: Apply safe auto-fixes only
code-fix-all:
	@echo "Applying safe auto-fixes..."
	$(BIOME) check --write src

## code-fix-unsafe: Apply ALL auto-fixes (including unsafe)
code-fix-unsafe:
	@echo "Applying all auto-fixes (including unsafe)..."
	$(BIOME) check --write --unsafe src

## code-check: Run validation (fails on warnings)
code-check:
	@echo "Running strict validation..."
	$(BIOME) check --error-on-warnings src
	@echo "Running tests..."
	$(BUN) test
	@echo "All checks passed!"

## code-all: Run all checks (alias for code-check)
code-all: code-check

# =============================================================================
# Gateway (System-Level LaunchDaemon)
# =============================================================================

## gateway-start: Start system gateway
gateway-start:
	@echo "Starting cc-bridge gateway..."
	@sudo pkill -9 -f "bun run src/gateway/index.ts" 2>/dev/null || true
	@sudo lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@sudo lsof -ti :8080 | xargs sudo kill -9 2>/dev/null || true
	@sudo launchctl start com.cc-bridge.daemon || { echo "Run 'make gateway-setup' first."; exit 1; }
	@echo "Gateway started."

## gateway-stop: Stop system gateway
gateway-stop:
	@echo "Stopping cc-bridge gateway..."
	@sudo launchctl stop com.cc-bridge.daemon || { echo "Gateway not running."; exit 1; }
	@sudo pkill -9 -f "bun run src/gateway/index.ts" 2>/dev/null || true
	@sudo lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@sudo lsof -ti :8080 | xargs sudo kill -9 2>/dev/null || true
	@echo "Gateway stopped."

## gateway-restart: Restart system gateway
gateway-restart:
	@echo "Restarting cc-bridge gateway..."
	@sudo launchctl stop com.cc-bridge.daemon 2>/dev/null || true
	@sudo pkill -9 -f "bun run src/gateway/index.ts" 2>/dev/null || true
	@sudo lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@sudo lsof -ti :8080 | xargs sudo kill -9 2>/dev/null || true
	@sudo launchctl start com.cc-bridge.daemon || { echo "Run 'make gateway-setup' first."; exit 1; }
	@echo "Gateway restarted."

## gateway-setup: Install deps + LaunchDaemon (servers)
gateway-setup: env-install
	@echo "Installing cc-bridge gateway (LaunchDaemon)..."
	@sudo ./scripts/install-daemon.sh
	@echo ""
	@echo "Setup complete! Gateway will start automatically at boot."
	@echo "Use: make gateway-start | gateway-stop | gateway-restart"

## gateway-uninstall: Uninstall system gateway
gateway-uninstall:
	@echo "Uninstalling cc-bridge gateway..."
	@sudo ./scripts/uninstall-daemon.sh

## logs-monitor: Monitor unified system logs
logs-monitor:
	@tail -f data/logs/combined.log

# =============================================================================
# Build
# =============================================================================

## dist-build: Build distribution packages (not implemented for JS yet)
dist-build: dist-clean
	@echo "Build not implemented for JS yet."

## dist-clean: Clean build artifacts and temporary files
dist-clean:
	@echo "Cleaning build artifacts and temporary files..."
	@rm -rf build/ dist/ *.egg-info/ .coverage coverage/ .biome_cache/ node_modules/
	@rm -rf data/logs/* data/ipc/* data/persistence/bridge.db*
	@find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	@find . -type f -name "*.pyc" -delete 2>/dev/null || true
