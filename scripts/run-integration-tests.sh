#!/bin/bash
# Integration Test Runner for cc-bridge tmux workflow
# This script runs the full integration test suite for the persistent session architecture

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
INTEGRATION_TEST_DIR="${PROJECT_ROOT}/src/gateway/tests/integration"

# Export for tests
export TEST_IPC_DIR="${PROJECT_ROOT}/data/test-ipc"

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Cleanup function
cleanup() {
    log_info "Cleaning up test artifacts..."
    rm -rf "${TEST_IPC_DIR:?}"
    log_success "Cleanup complete"
}

# Setup function
setup() {
    log_info "Setting up test environment..."
    mkdir -p "${TEST_IPC_DIR}"
    log_success "Test environment ready"
}

# Run integration tests
run_integration_tests() {
    log_info "Running integration tests..."

    cd "${PROJECT_ROOT}"

    # Run tmux workflow tests
    log_info "=== tmux Workflow Tests ==="
    if bun test "${INTEGRATION_TEST_DIR}/tmux-workflow.test.ts"; then
        log_success "tmux workflow tests passed"
    else
        log_error "tmux workflow tests failed"
        return 1
    fi

    echo ""

    # Run performance tests
    log_info "=== Performance Benchmark Tests ==="
    if bun test "${INTEGRATION_TEST_DIR}/performance.test.ts"; then
        log_success "Performance tests passed"
    else
        log_error "Performance tests failed"
        return 1
    fi

    return 0
}

# Run all unit tests
run_unit_tests() {
    log_info "Running unit tests..."

    cd "${PROJECT_ROOT}"

    # Run all gateway tests
    if bun test "src/gateway/tests/*.test.ts"; then
        log_success "Unit tests passed"
    else
        log_error "Unit tests failed"
        return 1
    fi

    return 0
}

# Run full test suite
run_full_suite() {
    log_info "Running full test suite..."

    setup

    if run_unit_tests && run_integration_tests; then
        log_success "All tests passed!"
        return 0
    else
        log_error "Some tests failed"
        return 1
    fi
}

# Main
main() {
    echo ""
    echo "=========================================="
    echo "  cc-bridge Integration Test Runner"
    echo "=========================================="
    echo ""

    # Parse arguments
    TEST_TYPE="${1:-full}"

    case "${TEST_TYPE}" in
        integration)
            setup
            run_integration_tests
            cleanup
            ;;
        unit)
            run_unit_tests
            ;;
        full)
            run_full_suite
            cleanup
            ;;
        clean)
            cleanup
            log_success "Cleanup complete"
            ;;
        *)
            log_error "Unknown test type: ${TEST_TYPE}"
            echo ""
            echo "Usage: $0 [integration|unit|full|clean]"
            echo ""
            echo "  integration - Run integration tests only"
            echo "  unit        - Run unit tests only"
            echo "  full        - Run all tests (default)"
            echo "  clean       - Clean up test artifacts"
            echo ""
            exit 1
            ;;
    esac
}

# Trap to ensure cleanup on exit
trap cleanup EXIT

# Run main
main "$@"
