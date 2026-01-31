#!/bin/bash
# Uninstall cc-bridge Homebrew service
# This script removes the cc-bridge server service from the system

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
PLIST_PATH="${HOME}/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist"
LOG_DIR="/opt/homebrew/var/log/cc-bridge"
BACKUP_DIR="${HOME}/.cc-bridge-backup-$(date +%Y%m%d_%H%M%S)"

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

# Check if service is installed
check_installed() {
    log_info "Checking if cc-bridge service is installed..."

    if [ ! -f "${PLIST_PATH}" ]; then
        log_warning "Service plist file not found: ${PLIST_PATH}"
        log_warning "Service may not be installed"
        return 1
    fi

    log_success "Service plist file found"
    return 0
}

# Stop the service
stop_service() {
    log_info "Stopping cc-bridge service..."

    # Check if service is loaded
    if launchctl list | grep -q "homebrew.mxcl.cc-bridge"; then
        log_info "Unloading service..."

        # Stop the service
        launchctl stop homebrew.mxcl.cc-bridge 2>/dev/null || true

        # Unload the service
        launchctl unload "${PLIST_PATH}" 2>/dev/null || true

        log_success "Service stopped and unloaded"
    else
        log_warning "Service not loaded or already stopped"
    fi

    # Kill any remaining processes
    if pgrep -f "cc-bridge server" > /dev/null; then
        log_info "Terminating remaining cc-bridge server processes..."
        pkill -f "cc-bridge server" || true
        sleep 2

        # Force kill if still running
        if pgrep -f "cc-bridge server" > /dev/null; then
            log_warning "Force killing remaining processes..."
            pkill -9 -f "cc-bridge server" || true
        fi

        log_success "All processes terminated"
    fi
}

# Remove plist file
remove_plist() {
    log_info "Removing plist file..."

    if [ -f "${PLIST_PATH}" ]; then
        # Backup plist file
        log_info "Backing up plist file to ${BACKUP_DIR}..."
        mkdir -p "${BACKUP_DIR}"
        cp "${PLIST_PATH}" "${BACKUP_DIR}/homebrew.mxcl.cc-bridge.plist"

        # Remove plist file
        rm "${PLIST_PATH}"
        log_success "plist file removed (backup saved)"
    else
        log_warning "plist file not found, skipping"
    fi
}

# Handle log files
handle_logs() {
    echo ""
    log_info "Log files are located at: ${LOG_DIR}"
    echo ""

    # Ask user if they want to remove logs
    read -p "Do you want to remove log files? (y/N): " -n 1 -r
    echo ""

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log_info "Removing log directory..."

        if [ -d "${LOG_DIR}" ]; then
            # Backup logs
            log_info "Backing up logs to ${BACKUP_DIR}..."
            mkdir -p "${BACKUP_DIR}"
            cp -r "${LOG_DIR}" "${BACKUP_DIR}/logs"

            # Remove logs
            sudo rm -rf "${LOG_DIR}"
            log_success "Log directory removed (backup saved)"
        else
            log_warning "Log directory not found, skipping"
        fi
    else
        log_info "Keeping log files at ${LOG_DIR}"
        log_info "You can manually remove them later:"
        echo "  sudo rm -rf ${LOG_DIR}"
    fi
}

# Show summary
show_summary() {
    echo ""
    echo "=================================="
    echo "Uninstallation Summary"
    echo "=================================="
    echo ""

    echo "Removed components:"
    echo "  - Service plist: ${PLIST_PATH}"
    echo "  - Launchd registration"

    # Check if logs were removed
    if [ -d "${LOG_DIR}" ]; then
        echo "  - Log files: Kept at ${LOG_DIR}"
    else
        echo "  - Log files: Removed"
    fi

    echo ""
    echo "Backup location:"
    echo "  ${BACKUP_DIR}"
    echo ""

    # Verify cleanup
    if [ -f "${PLIST_PATH}" ]; then
        log_warning "plist file still exists (may need manual removal)"
    else
        log_success "plist file removed successfully"
    fi

    if pgrep -f "cc-bridge server" > /dev/null; then
        log_warning "cc-bridge server process still running"
        log_warning "You may need to manually kill it:"
        echo "  pkill -f 'cc-bridge server'"
    else
        log_success "All processes terminated"
    fi

    echo ""
    log_success "Uninstallation complete!"
    echo ""
    echo "Note: This only uninstalled the service. The cc-bridge package itself is still installed."
    echo "To uninstall cc-bridge completely:"
    echo "  pip uninstall cc-bridge"
    echo ""
}

# Main uninstallation flow
main() {
    echo ""
    echo "=================================="
    echo "cc-bridge Service Uninstallation"
    echo "=================================="
    echo ""

    # Check if service is installed
    if ! check_installed; then
        echo ""
        log_warning "Service does not appear to be installed"
        read -p "Continue anyway? (y/N): " -n 1 -r
        echo ""

        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Uninstallation cancelled"
            exit 0
        fi
    fi

    # Confirm uninstallation
    echo ""
    log_warning "This will:"
    echo "  - Stop the cc-bridge service"
    echo "  - Remove the launchd plist file"
    echo "  - Optionally remove log files"
    echo ""
    read -p "Continue with uninstallation? (y/N): " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Uninstallation cancelled"
        exit 0
    fi

    echo ""

    # Stop service
    stop_service

    # Remove plist
    remove_plist

    # Handle logs
    handle_logs

    # Show summary
    show_summary
}

# Run main function
main "$@"
