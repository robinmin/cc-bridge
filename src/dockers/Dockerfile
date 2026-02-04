# Bun-based Dockerfile for cc-bridge agent
FROM oven/bun:1-slim

# Install system dependencies
# git: required for claude-code to perform git operations
# curl: for healthchecks and downloads
# tmux: for session management if needed (legacy support)
RUN apt-get update && apt-get install -y \
    git \
    curl \
    tmux \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Install Claude tools globally
RUN bun install -g @anthropic-ai/claude-code @anthropic-ai/claude-agent-sdk

# Create non-root user matching host (optional, but good practice)
USER bun

# Copy project files (needed for production build)
COPY --chown=bun:bun cc_bridge/ ./cc_bridge/

# Set working directory for project
ARG PROJECT_NAME=cc-bridge
WORKDIR /workspaces/${PROJECT_NAME}

# Default command - will be overridden by docker exec
# Note: In dev (volume mount), path is /workspaces/cc-bridge/cc_bridge/...
# In prod (no volume), path is /app/cc_bridge/...
# We default to the dev path since that's the primary use case here
CMD ["bun", "run", "cc_bridge/agents/container_agent.ts"]
