.PHONY: help all dev test test-quick lint format check status clean \
	gateway-start gateway-stop gateway-restart gateway-install gateway-uninstall logs-monitor

# Default target
.DEFAULT_GOAL := help

# Variables
BUN := bun
BIOME := npx @biomejs/biome
PACKAGE_NAME := cc-bridge

# User adaptation variables
USER_NAME := $(shell whoami)
USER_ID := $(shell id -u)
GROUP_ID := $(shell id -g)
WORKSPACE_NAME := cc-bridge

export USER_NAME USER_ID GROUP_ID WORKSPACE_NAME

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
	@$(BUN) test src/agent/tests/ src/gateway/tests/ src/packages/tests/ --coverage --coverage-reporter=text

## test-quick: Run tests without coverage
test-quick:
	@echo "Running tests..."
	@$(BUN) test src/agent/tests/ src/gateway/tests/ src/packages/tests/

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
	$(BIOME) check --error-on-warnings src
	@echo "Running tests..."
	@$(BUN) test src/agent/tests/ src/gateway/tests/ src/packages/tests/ --coverage
	@echo "✅ All checks passed!"

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
# Cleanup
# =============================================================================

## clean: Remove build artifacts and temporary files
clean:
	@echo "Cleaning build artifacts and temporary files..."
	@rm -rf build/ dist/ .coverage coverage/ .biome_cache/
	@rm -rf data/logs/* data/ipc/*
	@echo "✅ Clean complete"
