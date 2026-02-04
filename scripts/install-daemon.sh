#!/bin/bash
# Install cc-bridge as a system LaunchDaemon
# This script sets up cc-bridge server to run at system boot (before login)

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
PLIST_SOURCE="${PROJECT_ROOT}/contrib/com.cc-bridge.daemon.plist"
PLIST_DEST="/Library/LaunchDaemons/com.cc-bridge.daemon.plist"
LOG_DIR="/Users/$(logname)/.claude/bridge/logs"

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

# Check if running as root
check_root() {
    log_info "Checking for root privileges..."

    if [ "$EUID" -ne 0 ]; then
        log_error "This script must be run as root (use sudo)"
        echo ""
        echo "Please run:"
        echo "  sudo ${SCRIPT_DIR}/install-daemon.sh"
        exit 1
    fi

    log_success "Running with root privileges"
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

# Check if Bun is installed
check_bun() {
    log_info "Checking for Bun installation..."

    if ! command -v bun &> /dev/null; then
        log_error "Bun is not installed!"
        echo ""
        echo "Please install Bun first:"
        echo "  curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi

    log_success "Bun found: $(bun --version)"
}

# Create log directory
create_log_dir() {
    log_info "Creating log directory at ${LOG_DIR}..."

    if [ ! -d "${LOG_DIR}" ]; then
        mkdir -p "${LOG_DIR}"
        chown "$(logname):admin" "${LOG_DIR}"
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

# Update plist with current user's username
update_plist_username() {
    log_info "Updating plist with current user's username..."

    local current_user="$(logname)"
    log_info "Setting UserName to: ${current_user}"

    # Create a temporary plist with the correct username
    plutil -replace UserName "${current_user}" "${PLIST_SOURCE}" 2>/dev/null || true

    # Also update HOME and paths
    local user_home="/Users/${current_user}"
    plutil -replace EnvironmentVariables.HOME "${user_home}" "${PLIST_SOURCE}" 2>/dev/null || true
    plutil -replace WorkingDirectory "${PROJECT_ROOT}" "${PLIST_SOURCE}" 2>/dev/null || true

    log_success "plist updated for user: ${current_user}"
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
    chmod 644 "${PLIST_DEST}"
    log_success "plist file installed"
}

# Load the daemon
load_daemon() {
    log_info "Loading cc-bridge daemon..."

    # Unload first if already loaded
    if launchctl list | grep -q "com.cc-bridge.daemon"; then
        log_warning "Daemon already loaded, unloading first..."
        # Force kill any existing gateway processes to avoid EADDRINUSE
        pkill -9 -f "bun run src/gateway/index.ts" 2>/dev/null || true
        lsof -ti :8080 | xargs kill -9 2>/dev/null || true
        
        launchctl unload "${PLIST_DEST}" 2>/dev/null || true
    fi

    # Load the daemon
    launchctl load "${PLIST_DEST}"
    log_success "Daemon loaded"
}

# Start the daemon
start_daemon() {
    log_info "Starting cc-bridge daemon..."

    launchctl start com.cc-bridge.daemon

    log_success "Daemon started"
}

# Wait for daemon to start
wait_for_daemon() {
    log_info "Waiting for daemon to start..."

    local max_attempts=30
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        # Check if the daemon is running by checking the health endpoint
        if curl -s http://localhost:8080/health &> /dev/null; then
            log_success "Daemon is responding!"
            return 0
        fi

        sleep 1
        attempt=$((attempt + 1))
        echo -n "."
    done

    echo ""
    log_warning "Daemon did not respond within ${max_attempts} seconds"
    log_warning "Check the logs for errors:"
    echo "  tail -f ${LOG_DIR}/server.log"
    return 1
}

# Show daemon status
show_status() {
    echo ""
    log_info "Daemon Status:"
    echo ""

    # Check if daemon is loaded
    if launchctl list | grep -q "com.cc-bridge.daemon"; then
        echo "  Status: Loaded (system-level)"
    else
        echo "  Status: Not loaded"
    fi

    # Check if daemon is running
    # In Bun, the process name might be 'bun' or the script path
    if pgrep -f "bun run src/gateway/index.ts" > /dev/null || pgrep -f "src/gateway/index.ts" > /dev/null; then
        local pid=$(pgrep -f "src/gateway/index.ts" | head -n 1)
        echo "  Process: Running (PID: ${pid})"
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
    echo "    Start:  sudo launchctl start com.cc-bridge.daemon"
    echo "    Stop:   sudo launchctl stop com.cc-bridge.daemon"
    echo "    Restart: sudo launchctl kickstart -k com.cc-bridge.daemon"
    echo "    Logs:   tail -f ${LOG_DIR}/server.log"
    echo ""
    echo "  Or use make targets (from project directory):"
    echo "    make gateway-start"
    echo "    make gateway-stop"
    echo "    make gateway-restart"
}

# Main installation flow
main() {
    echo ""
    echo "=================================="
    echo "cc-bridge Daemon Installation"
    echo "(System-Level - Starts at Boot)"
    echo "=================================="
    echo ""

    # Check prerequisites
    check_root
    check_homebrew
    check_bun

    # Create directories
    create_log_dir

    # Validate and update plist
    validate_plist
    update_plist_username

    # Install plist
    install_plist

    # Load and start daemon
    load_daemon
    start_daemon

    # Wait for daemon to start
    echo ""
    wait_for_daemon

    # Show status
    show_status

    echo ""
    log_success "Installation complete!"
    echo ""
    echo "The daemon will start automatically at system boot."
    echo ""
    echo "Next steps:"
    echo "  1. Check logs: tail -f ${LOG_DIR}/server.log"
    echo "  2. Test webhook: curl http://localhost:8080/health"
    echo "  3. Uninstall: sudo ${PROJECT_ROOT}/scripts/uninstall-daemon.sh"
    echo ""
}

# Run main function
main "$@"
