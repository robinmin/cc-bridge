.PHONY: bridge-dev code-test code-test-quick code-lint code-format code-typecheck code-fix code-all code-fix-all env-install dist-build dist-clean help bridge-status agent-start agent-stop agent-restart agent-setup agent-uninstall daemon-start daemon-stop daemon-restart daemon-setup daemon-uninstall

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

## all: Run all checks (alias for code-all)
all: code-all

## bridge-status: Run system health check
bridge-status:
	@./scripts/health-check.sh

## docker-build: Build docker image
docker-build:
	@echo "Building docker image..."
	@docker build -t cc-bridge -f dockers/Dockerfile .

## docker-run: Run docker container with host authentication (using docker-compose)
docker-run:
	@echo "Running docker container with docker-compose..."
	@docker compose -f dockers/docker-compose.yml run --rm claude-agent bash

## docker-restart: Rebuild and restart docker container (using docker-compose)
docker-restart:
	@echo "Rebuilding and restarting with docker-compose..."
	@docker compose -f dockers/docker-compose.yml up -d --build --force-recreate

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
	@echo "Choose setup type:"
	@echo ""
	@echo "1. Development only (no service)"
	@echo "2. LaunchAgent (starts at login - recommended)"
	@echo "3. LaunchDaemon (starts at boot - for servers)"
	@echo ""
	@read -p "Enter choice [1-3] (default: 2): " choice; \
	echo ""; \
	case $$choice in \
		1) $(MAKE) env-install; echo "Done! Run 'make bridge-dev' to start.";; \
		2) $(MAKE) agent-setup;; \
		3) $(MAKE) daemon-setup;; \
		*) $(MAKE) agent-setup;; \
	esac

## env-install: Install dependencies using uv
env-install:
	@echo "Installing dependencies..."
	$(UV) pip install -e ".[dev]"

# =============================================================================
# Development
# =============================================================================

## bridge-dev: Start development server with auto-reload
bridge-dev:
	@echo "Starting development server..."
	$(UV) run cc-bridge server --reload

## code-test: Run pytest with coverage
code-test:
	@echo "Running tests..."
	$(UV) run pytest -v

## code-test-quick: Run tests without coverage
code-test-quick:
	@echo "Running tests (quick)..."
	$(UV) run pytest -v --no-cov

# =============================================================================
# Code Quality
# =============================================================================

## code-lint: Run ruff linter
code-lint:
	@echo "Running linter..."
	$(UV) run ruff check .

## code-format: Format code with ruff
code-format:
	@echo "Formatting code..."
	$(UV) run ruff format .

## code-typecheck: Run ty type checker
code-typecheck:
	@echo "Running type checker..."
	$(UV) run ty check .

## code-fix: Auto-fix lint errors + format code
code-fix:
	@echo "Auto-fixing lint errors..."
	$(UV) run ruff check . --fix
	@echo "Formatting code..."
	$(UV) run ruff format .
	@echo "Auto-fix complete!"

## code-all: Run all checks (lint, format, typecheck, test)
code-all:
	@echo "Running linter..."
	$(UV) run ruff check .
	@echo "Checking code formatting..."
	$(UV) run ruff format --check .
	@echo "Running type checker..."
	$(UV) run ty check .
	@echo "Running tests..."
	$(UV) run pytest -v
	@echo "All checks passed!"

## code-fix-all: Auto-fix everything, then validate
code-fix-all: code-fix
	@echo "Running validation after fixes..."
	$(MAKE) code-all

# =============================================================================
# Service (LaunchAgent - starts at login)
# =============================================================================

## agent-start: Start cc-bridge service
agent-start:
	@echo "Starting cc-bridge service..."
	@lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@lsof -ti :8080 | xargs kill -9 2>/dev/null || true
	@launchctl start homebrew.mxcl.cc-bridge
	@echo "Service started."

## agent-stop: Stop cc-bridge service
agent-stop:
	@echo "Stopping cc-bridge service..."
	@launchctl stop homebrew.mxcl.cc-bridge
	@lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@lsof -ti :8080 | xargs kill -9 2>/dev/null || true
	@echo "Service stopped."

## agent-restart: Restart cc-bridge service
agent-restart:
	@echo "Restarting cc-bridge service..."
	@launchctl stop homebrew.mxcl.cc-bridge 2>/dev/null || true
	@lsof -ti :8080 >/dev/null && echo "Clearing port 8080..." || true
	@lsof -ti :8080 | xargs kill -9 2>/dev/null || true
	@launchctl start homebrew.mxcl.cc-bridge
	@echo "Service restarted."

## agent-setup: Install deps + LaunchAgent (recommended)
agent-setup: env-install
	@echo "Installing cc-bridge service (LaunchAgent)..."
	@./scripts/install-service.sh
	@echo ""
	@echo "Setup complete! Service will start automatically at login."
	@echo "Use: make agent-start | agent-stop | agent-restart"

## agent-uninstall: Uninstall LaunchAgent
agent-uninstall:
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
	@sudo launchctl start com.cc-bridge.daemon || { echo "Run 'make daemon-setup' first."; exit 1; }
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
	@sudo launchctl start com.cc-bridge.daemon || { echo "Run 'make daemon-setup' first."; exit 1; }
	@echo "Daemon restarted."

## daemon-setup: Install deps + LaunchDaemon (servers)
daemon-setup: env-install
	@echo "Installing cc-bridge daemon (LaunchDaemon)..."
	@sudo ./scripts/install-daemon.sh
	@echo ""
	@echo "Setup complete! Daemon will start automatically at boot."
	@echo "Use: make daemon-start | daemon-stop | daemon-restart"

## daemon-uninstall: Uninstall LaunchDaemon
daemon-uninstall:
	@echo "Uninstalling cc-bridge daemon..."
	@sudo ./scripts/uninstall-daemon.sh

## logs-monitor: Monitor server logs
logs-monitor:
	@tail -f /Users/robin/.claude/bridge/logs/server.log

# =============================================================================
# Build
# =============================================================================

## dist-build: Build distribution packages
dist-build: dist-clean
	@echo "Building distribution packages..."
	$(UV) build

## dist-clean: Clean build artifacts
dist-clean:
	@echo "Cleaning build artifacts..."
	@rm -rf build/ dist/ *.egg-info/ .pytest_cache/ .coverage htmlcov/ .ruff_cache/
	@find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	@find . -type f -name "*.pyc" -delete 2>/dev/null || true
