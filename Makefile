.PHONY: dev test test-quick lint format typecheck fix all fix-all install build clean help status start stop restart setup setup-service service-uninstall daemon-start daemon-stop daemon-restart setup-daemon daemon-uninstall

# Default target
.DEFAULT_GOAL := help

# Variables
PYTHON := python3
UV := VIRTUAL_ENV= uv
PACKAGE_NAME := cc-bridge
PYTHON_VERSION := 3.10

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
	@echo ""
	@echo "Usage: cc-bridge [command]"
	@echo ""
	@./.venv/bin/cc-bridge --help

## status: Run system health check
status:
	@./scripts/health-check.sh

## build-docker: Build docker image
build-docker:
	@echo "Building docker image..."
	@docker build -t cc-bridge -f dockers/Dockerfile .

## run-docker: Run docker container with host authentication (using docker-compose)
run-docker:
	@echo "Running docker container with docker-compose..."
	@docker compose -f dockers/docker-compose.yml run --rm claude-agent bash

## restart-docker: Rebuild and restart docker container (using docker-compose)
restart-docker:
	@echo "Rebuilding and restarting with docker-compose..."
	@docker compose -f dockers/docker-compose.yml build
	@docker compose -f dockers/docker-compose.yml run --rm claude-agent bash

# =============================================================================
# Setup
# =============================================================================

## setup: Initial project setup (interactive)
setup:
	@echo ""
	@echo "=================================="
	@echo "cc-bridge Setup"
	@echo "=================================="
	@echo ""
	@echo "Choose setup type:"
	@echo ""
	@echo "1. Development only (no service)"
	@echo "2. LaunchAgent (starts at login - recommended)"
	@echo "3. LaunchDaemon (starts at boot - for servers)"
	@echo ""
	@read -p "Enter choice [1-3] (default: 2): " choice; \
	echo ""; \
	case $$choice in \
		1) $(MAKE) install; echo "Done! Run 'make dev' to start.";; \
		2) $(MAKE) setup-service;; \
		3) $(MAKE) setup-daemon;; \
		*) $(MAKE) setup-service;; \
	esac

## install: Install dependencies using uv
install:
	@echo "Installing dependencies..."
	$(UV) pip install -e ".[dev]"

# =============================================================================
# Development
# =============================================================================

## dev: Start development server with auto-reload
dev:
	@echo "Starting development server..."
	$(UV) run cc-bridge server --reload

## test: Run pytest with coverage
test:
	@echo "Running tests..."
	$(UV) run pytest -v

## test-quick: Run tests without coverage
test-quick:
	@echo "Running tests (quick)..."
	$(UV) run pytest -v --no-cov

# =============================================================================
# Code Quality
# =============================================================================

## lint: Run ruff linter
lint:
	@echo "Running linter..."
	$(UV) run ruff check .

## format: Format code with ruff
format:
	@echo "Formatting code..."
	$(UV) run ruff format .

## typecheck: Run ty type checker
typecheck:
	@echo "Running type checker..."
	$(UV) run ty check .

## fix: Auto-fix lint errors + format code
fix:
	@echo "Auto-fixing lint errors..."
	$(UV) run ruff check . --fix
	@echo "Formatting code..."
	$(UV) run ruff format .
	@echo "Auto-fix complete!"

## all: Run all checks (lint, format, typecheck, test)
all:
	@echo "Running linter..."
	$(UV) run ruff check .
	@echo "Checking code formatting..."
	$(UV) run ruff format --check .
	@echo "Running type checker..."
	$(UV) run ty check .
	@echo "Running tests..."
	$(UV) run pytest -v
	@echo "All checks passed!"

## fix-all: Auto-fix everything, then validate
fix-all: fix
	@echo "Running validation after fixes..."
	$(MAKE) all

# =============================================================================
# Service (LaunchAgent - starts at login)
# =============================================================================

## start: Start cc-bridge service
start:
	@echo "Starting cc-bridge service..."
	@lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@lsof -ti :8080 | xargs kill -9 2>/dev/null || true
	@launchctl start homebrew.mxcl.cc-bridge
	@echo "Service started."

## stop: Stop cc-bridge service
stop:
	@echo "Stopping cc-bridge service..."
	@launchctl stop homebrew.mxcl.cc-bridge
	@lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@lsof -ti :8080 | xargs kill -9 2>/dev/null || true
	@echo "Service stopped."

## restart: Restart cc-bridge service
restart:
	@echo "Restarting cc-bridge service..."
	@launchctl stop homebrew.mxcl.cc-bridge 2>/dev/null || true
	@lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@lsof -ti :8080 | xargs kill -9 2>/dev/null || true
	@launchctl start homebrew.mxcl.cc-bridge
	@echo "Service restarted."

## setup-service: Install deps + LaunchAgent (recommended)
setup-service: install
	@echo "Installing cc-bridge service (LaunchAgent)..."
	@./scripts/install-service.sh
	@echo ""
	@echo "Setup complete! Service will start automatically at login."
	@echo "Use: make start | stop | restart"

## service-uninstall: Uninstall LaunchAgent
service-uninstall:
	@echo "Uninstalling cc-bridge service..."
	@./scripts/uninstall-service.sh

# =============================================================================
# Daemon (LaunchDaemon - starts at boot)
# =============================================================================

## daemon-start: Start system daemon
daemon-start:
	@echo "Starting cc-bridge daemon..."
	@sudo lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@sudo lsof -ti :8080 | xargs sudo kill -9 2>/dev/null || true
	@sudo launchctl start com.cc-bridge.daemon || { echo "Run 'make setup-daemon' first."; exit 1; }
	@echo "Daemon started."

## daemon-stop: Stop system daemon
daemon-stop:
	@echo "Stopping cc-bridge daemon..."
	@sudo launchctl stop com.cc-bridge.daemon || { echo "Daemon not running."; exit 1; }
	@sudo lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@sudo lsof -ti :8080 | xargs sudo kill -9 2>/dev/null || true
	@echo "Daemon stopped."

## daemon-restart: Restart system daemon
daemon-restart:
	@echo "Restarting cc-bridge daemon..."
	@sudo launchctl stop com.cc-bridge.daemon 2>/dev/null || true
	@sudo lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@sudo lsof -ti :8080 | xargs sudo kill -9 2>/dev/null || true
	@sudo launchctl start com.cc-bridge.daemon || { echo "Run 'make setup-daemon' first."; exit 1; }
	@echo "Daemon restarted."

## setup-daemon: Install deps + LaunchDaemon (servers)
setup-daemon: install
	@echo "Installing cc-bridge daemon (LaunchDaemon)..."
	@sudo ./scripts/install-daemon.sh
	@echo ""
	@echo "Setup complete! Daemon will start automatically at boot."
	@echo "Use: make daemon-start | daemon-stop | daemon-restart"

## daemon-uninstall: Uninstall LaunchDaemon
daemon-uninstall:
	@echo "Uninstalling cc-bridge daemon..."
	@sudo ./scripts/uninstall-daemon.sh

## monitor: Monitor server logs
monitor:
	@tail -f /Users/robin/.claude/bridge/logs/server.log

## talk: Talk to Claude inside Docker (e.g., make talk msg="Hello")
talk:
	@docker exec -it claude-cc-bridge claude -p --allow-dangerously-skip-permissions -c "$(msg)"

# =============================================================================
# Build
# =============================================================================

## build: Build distribution packages
build: clean
	@echo "Building distribution packages..."
	$(UV) build

## clean: Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf build/ dist/ *.egg-info/ .pytest_cache/ .coverage htmlcov/ .ruff_cache/
	@find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	@find . -type f -name "*.pyc" -delete 2>/dev/null || true
