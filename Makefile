.PHONY: bridge-dev test test-quick code-lint code-format code-check code-all code-fix-all env-install dist-build dist-clean help bridge-status gateway-start gateway-stop gateway-restart gateway-setup gateway-uninstall

# Default target
.DEFAULT_GOAL := help

# Variables
BUN := bun
BIOME := npx @biomejs/biome
PACKAGE_NAME := cc-bridge
VERSION := 0.1.0

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

## docker-build: Build docker image
docker-build:
	@echo "Building docker image..."
	@docker build -t cc-bridge -f src/dockers/Dockerfile.agent .

## docker-run: Run docker container with host authentication (using docker-compose)
docker-run:
	@echo "Running docker container with docker-compose..."
	@docker compose -f src/dockers/docker-compose.yml run --rm claude-agent bash

## docker-restart: Rebuild and restart docker container (using docker-compose)
docker-restart:
	@echo "Rebuilding and restarting with docker-compose..."
	@docker compose -f src/dockers/docker-compose.yml up -d --build --force-recreate

## docker-talk: Talk to Claude inside Docker (e.g., make docker-talk msg="Hello")
docker-talk:
	@if [ -z "$(msg)" ]; then \
		echo "Usage: make docker-talk msg=\"Your message here\""; \
		exit 1; \
	fi
	@docker exec -it claude-cc-bridge claude -p --allow-dangerously-skip-permissions -c "$(msg)"

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

## code-lint: Run Biome linter
code-lint:
	@echo "Running linter..."
	$(BIOME) lint src

## code-format: Format code with Biome
code-format:
	@echo "Formatting code..."
	$(BIOME) format --write src

## code-check: Run Biome check (lint + format)
code-check:
	@echo "Running code check..."
	$(BIOME) check --write src

## code-all: Run all checks (check + test)
code-all:
	@echo "Running Biome checks..."
	$(BIOME) check src
	@echo "Running tests..."
	$(BUN) test
	@echo "All checks passed!"

## code-fix-all: Auto-fix everything, then validate
code-fix-all: code-check
	@echo "Running validation after fixes..."
	$(MAKE) code-all

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
