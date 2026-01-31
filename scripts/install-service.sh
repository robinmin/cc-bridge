#!/bin/bash
# Install cc-bridge as a Homebrew service
# This script sets up cc-bridge server to run automatically on system boot

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLIST_SOURCE="${PROJECT_ROOT}/contrib/homebrew.mxcl.cc-bridge.plist"
# Use brew's naming convention for better integration
PLIST_NAME="homebrew.mxcl.cc-bridge"
PLIST_DEST="${HOME}/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="/opt/homebrew/var/log/cc-bridge"

# Helper functions
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

# Check if Homebrew is installed
check_homebrew() {
    log_info "Checking for Homebrew installation..."

    if ! command -v brew &> /dev/null; then
        log_error "Homebrew is not installed!"
        echo ""
        echo "Please install Homebrew first:"
        echo "  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        exit 1
    fi

    log_success "Homebrew found: $(brew --version | head -n 1)"
}

# Check if cc-bridge is installed
check_cc_bridge() {
    log_info "Checking for cc-bridge installation..."

    # First check PATH
    if command -v cc-bridge &> /dev/null; then
        log_success "cc-bridge found: $(which cc-bridge)"
        return 0
    fi

    # Check virtual environment
    local venv_cc_bridge="${PROJECT_ROOT}/.venv/bin/cc-bridge"
    if [ -f "${venv_cc_bridge}" ]; then
        log_success "cc-bridge found in venv: ${venv_cc_bridge}"
        return 0
    fi

    log_error "cc-bridge is not installed!"
    echo ""
    echo "Please install cc-bridge first:"
    echo "  cd ${PROJECT_ROOT}"
    echo "  pip install -e ."
    exit 1
}

# Create log directory
create_log_dir() {
    log_info "Creating log directory at ${LOG_DIR}..."

    if [ ! -d "${LOG_DIR}" ]; then
        sudo mkdir -p "${LOG_DIR}"
        sudo chown "$(whoami):admin" "${LOG_DIR}"
        log_success "Log directory created"
    else
        log_success "Log directory already exists"
    fi
}

# Validate plist file
validate_plist() {
    log_info "Validating plist file..."

    if [ ! -f "${PLIST_SOURCE}" ]; then
        log_error "plist file not found: ${PLIST_SOURCE}"
        exit 1
    fi

    if plutil -lint "${PLIST_SOURCE}" &> /dev/null; then
        log_success "plist file is valid"
    else
        log_error "plist file is invalid!"
        plutil -lint "${PLIST_SOURCE}"
        exit 1
    fi
}

# Install plist file
install_plist() {
    log_info "Installing plist file to ${PLIST_DEST}..."

    # Backup existing plist if it exists
    if [ -f "${PLIST_DEST}" ]; then
        log_warning "Backing up existing plist file..."
        cp "${PLIST_DEST}" "${PLIST_DEST}.backup.$(date +%Y%m%d_%H%M%S)"
    fi

    # Copy plist file
    cp "${PLIST_SOURCE}" "${PLIST_DEST}"
    log_success "plist file installed"

    # Set proper permissions
    chmod 644 "${PLIST_DEST}"
}

# Install and start the service
install_service() {
    log_info "Installing and starting cc-bridge service..."

    # Unload first if already loaded (via launchctl)
    if launchctl list | grep -q "${PLIST_NAME}"; then
        log_warning "Service already loaded, unloading first..."
        launchctl unload "${PLIST_DEST}" 2>/dev/null || true
    fi

    # Load the service using launchctl
    launchctl load "${PLIST_DEST}"

    log_success "Service loaded"

    # Start the service
    launchctl start "${PLIST_NAME}"

    log_success "Service started"
}

# Wait for service to start
wait_for_service() {
    log_info "Waiting for service to start..."

    local max_attempts=30
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        # Check if the service is running by checking the health endpoint
        if curl -s http://localhost:8080/health &> /dev/null; then
            log_success "Service is responding!"
            return 0
        fi

        sleep 1
        attempt=$((attempt + 1))
        echo -n "."
    done

    echo ""
    log_warning "Service did not respond within ${max_attempts} seconds"
    log_warning "Check the logs for errors:"
    echo "  tail -f ${LOG_DIR}/server.log"
    return 1
}

# Show service status
show_status() {
    echo ""
    log_info "Service Status:"
    echo ""

    # Check if service is loaded
    if launchctl list | grep -q "${PLIST_NAME}"; then
        echo "  Status: Loaded (via launchd)"
    else
        echo "  Status: Not loaded"
    fi

    # Check if service is running
    if pgrep -f "cc-bridge server" > /dev/null; then
        echo "  Process: Running (PID: $(pgrep -f "cc-bridge server"))"
    else
        echo "  Process: Not running"
    fi

    # Show log locations
    echo ""
    echo "  Log files:"
    echo "    Standard output: ${LOG_DIR}/server.log"
    echo "    Standard error:  ${LOG_DIR}/server.error.log"

    # Show management commands
    echo ""
    echo "  Management commands:"
    echo "    Start:  make start"
    echo "    Stop:   make stop"
    echo "    Restart: make restart"
    echo "    Or use launchctl directly:"
    echo "      launchctl start ${PLIST_NAME}"
    echo "      launchctl stop ${PLIST_NAME}"
    echo "      launchctl kickstart -k gui/$(id -u)/${PLIST_NAME}"
    echo "    Logs:   tail -f ${LOG_DIR}/server.log"
}

# Main installation flow
main() {
    echo ""
    echo "=================================="
    echo "cc-bridge Service Installation"
    echo "=================================="
    echo ""

    # Check prerequisites
    check_homebrew
    check_cc_bridge

    # Create directories
    create_log_dir

    # Validate and install plist
    validate_plist
    install_plist

    # Install and start service via brew services
    install_service

    # Wait for service to start
    echo ""
    wait_for_service

    # Show status
    show_status

    echo ""
    log_success "Installation complete!"
    echo ""
    echo "Next steps:"
    echo "  1. Check logs: tail -f ${LOG_DIR}/server.log"
    echo "  2. Test webhook: curl http://localhost:8080/health"
    echo "  3. Uninstall: ${PROJECT_ROOT}/scripts/uninstall-service.sh"
    echo ""
}

# Run main function
main "$@"
