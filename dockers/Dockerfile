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
    curl \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy project files
COPY pyproject.toml ./
COPY cc_bridge/ ./cc_bridge/
COPY README.md ./

# Install Python dependencies
RUN pip3 install --no-cache-dir . --break-system-packages

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
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN if getent passwd 1000; then \
        USER_NAME=$(getent passwd 1000 | cut -d: -f1); \
        GROUP_NAME=$(getent group 1000 | cut -d: -f1); \
        usermod -l vscode $USER_NAME && \
        groupmod -n vscode $GROUP_NAME || true && \
        usermod -d /home/vscode -m vscode; \
    else \
        groupadd -g 1000 vscode && \
        useradd -m -u 1000 -g 1000 -s /bin/bash vscode; \
    fi

# Create app directory with correct ownership
WORKDIR /app
RUN chown -R vscode:vscode /app

# Copy Python packages from builder stage
COPY --from=builder /usr/local/lib/python3.12/dist-packages /usr/local/lib/python3.12/dist-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy project files from project root
COPY --chown=vscode:vscode pyproject.toml ./
COPY --chown=vscode:vscode cc_bridge/ ./cc_bridge/
COPY --chown=vscode:vscode README.md ./

# Create necessary directories for Claude Code
RUN mkdir -p /home/vscode/.claude/hooks && \
    mkdir -p /home/vscode/.claude/bridge && \
    mkdir -p /home/vscode/.claude/plugins && \
    chown -R vscode:vscode /home/vscode/.claude

# Switch to non-root user

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

# Default command
CMD ["claude", "--dangerously-skip-permissions"]
