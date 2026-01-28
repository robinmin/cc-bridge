.PHONY: dev test lint lint-fix format format-check typecheck install build clean help fix all fix-all

# Default target
.DEFAULT_GOAL := help

# Variables
PYTHON := python3
UV := uv
PACKAGE_NAME := cc-bridge
PYTHON_VERSION := 3.10

## help: Show this help message
help:
	@echo "$(PACKAGE_NAME) - Makefile targets"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /'

## install: Install dependencies using uv
install:
	@echo "Installing dependencies..."
	$(UV) pip install -e ".[dev]"

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

## lint: Run ruff linter
lint:
	@echo "Running linter..."
	$(UV) run ruff check .

## lint-fix: Auto-fix lint errors
lint-fix:
	@echo "Auto-fixing lint errors..."
	$(UV) run ruff check . --fix

## format: Format code with ruff
format:
	@echo "Formatting code..."
	$(UV) run ruff format .

## format-check: Check code formatting
format-check:
	@echo "Checking code formatting..."
	$(UV) run ruff format --check .

## fix: Run all auto-fix commands (lint-fix + format)
fix: lint-fix format
	@echo "Auto-fix complete!"

## typecheck: Run ty type checker
typecheck:
	@echo "Running type checker..."
	$(UV) run ty check .

## clean: Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf build/
	rm -rf dist/
	rm -rf *.egg-info/
	rm -rf .pytest_cache/
	rm -rf .coverage
	rm -rf htmlcov/
	rm -rf .ruff_cache/
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete

## build: Build distribution packages
build: clean
	@echo "Building distribution packages..."
	$(UV) build

## all: Run lint, format-check, typecheck, and test
all: lint format-check typecheck test
	@echo "All checks passed!"

## fix-all: Auto-fix everything, then validate
fix-all: fix
	@echo "Running validation after fixes..."
	$(MAKE) all
	@echo "All fixes applied and validated!"

## setup: Initial project setup
setup: install
	@echo "Project setup complete!"
	@echo "Run 'make dev' to start the development server."
