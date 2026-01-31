# Multi-stage Dockerfile for cc-bridge
# Based on Anthropic's official Claude Code Dockerfile samples

# Stage 1: Builder
FROM ubuntu:24.04 AS builder

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    gcc \
    g++ \
    make \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy project files
COPY pyproject.toml ./
COPY cc_bridge/ ./cc_bridge/
COPY README.md ./

# Install Python dependencies
RUN pip3 install --no-cache-dir --upgrade pip setuptools wheel && \
    pip3 install --no-cache-dir .

# Stage 2: Runtime
FROM ubuntu:24.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    tmux \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
# Using UID 1000 to match common host user IDs
RUN useradd -m -u 1000 -s /bin/bash vscode

# Create app directory with correct ownership
WORKDIR /app
RUN chown -R vscode:vscode /app

# Copy Python packages from builder stage
COPY --from=builder /usr/local/lib/python3.12/dist-packages /usr/local/lib/python3.12/dist-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy project files
COPY --chown=vscode:vscode pyproject.toml ./
COPY --chown=vscode:vscode cc_bridge/ ./cc_bridge/
COPY --chown=vscode:vscode README.md ./

# Create necessary directories for Claude Code
RUN mkdir -p /home/vscode/.claude/hooks && \
    mkdir -p /home/vscode/.claude/bridge && \
    chown -R vscode:vscode /home/vscode/.claude

# Switch to non-root user
USER vscode

# Set working directory
WORKDIR /workspaces/${PROJECT_NAME:-cc-bridge}

# Set default environment variables
ENV PYTHONUNBUFFERED=1
ENV PATH="/home/vscode/.local/bin:${PATH}"

# Health check to verify container is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python3 -c "import sys; exit(0)" || exit 1

# Keep container running with stdin open and tty allocated
# This allows Claude Code to run interactively
STDIN_OPEN=true
TTY=true

# Default command: Run Claude Code with permission skip for agentic workflows
# Note: The actual command should be provided via docker-compose.yml or docker run
CMD ["claude", "--dangerously-skip-permissions"]
