---
wbs: "0123"
title: "Phase 2.4: Multi-Workspace Session Pooling"
status: "completed"
priority: "high"
complexity: "high"
estimated_hours: 6
phase: "phase-2-filesystem-polish"
dependencies: ["0111", "0120"]
created: 2026-02-07
completed: 2026-02-07
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

# Phase 2.4: Multi-Workspace Session Pooling

## Description

Implement multi-workspace support with session pooling, where each workspace gets its own tmux session. Includes workspace switching commands, per-workspace IPC directories, session lifecycle management, and workspace isolation enforcement.

## Requirements

### Functional Requirements

1. **Session Pool Management**
   - One tmux session per workspace (lazy creation)
   - Session naming: `claude-{workspace}`
   - Automatic session creation on first request
   - Session reuse for subsequent requests
   - Session cleanup on inactivity (configurable timeout)

2. **Workspace Switching Commands**
   - `/ws_switch {workspace}` - Switch to different workspace
   - `/ws_list` - List all active workspaces
   - `/ws_current` - Show current workspace
   - `/ws_create {name}` - Explicitly create workspace session
   - `/ws_delete {name}` - Delete workspace session

3. **Per-Workspace IPC Directories**
   - Separate IPC directory for each workspace: `/ipc/{workspace}/`
   - Isolated response files (no cross-contamination)
   - Workspace-specific cleanup policies
   - Automatic directory creation on first use

4. **Session Lifecycle Management**
   - Track session creation time
   - Track last activity time
   - Auto-cleanup inactive sessions (default: 1 hour)
   - Preserve sessions with pending requests
   - Graceful session termination

5. **Workspace Isolation**
   - Each session has independent Claude context
   - No message history leakage between workspaces
   - Separate environment variables per workspace
   - Isolated file system access (if configured)

6. **Session Metadata Tracking**
   - Active request count per session
   - Total requests processed per session
   - Session age and last activity
   - Memory/CPU usage per session (optional)

### Non-Functional Requirements

- Session creation must complete in <500ms
- Workspace switching must complete in <200ms
- Support up to 50 concurrent workspaces
- Session pool overhead <50MB memory
- Thread-safe session access (no race conditions)

## Design

### Session Pool Service

**File**: `src/agent/services/SessionPoolService.ts`

```typescript
import { Logger } from 'pino';
import { TmuxManager } from './TmuxManager';
import { EventEmitter } from 'events';

interface SessionMetadata {
  workspace: string;
  sessionName: string;
  createdAt: number;
  lastActivityAt: number;
  activeRequests: number;
  totalRequests: number;
  status: 'active' | 'idle' | 'terminating';
}

interface SessionPoolConfig {
  maxSessions: number;
  inactivityTimeoutMs: number;
  cleanupIntervalMs: number;
  enableAutoCleanup: boolean;
}

export class SessionPoolService extends EventEmitter {
  private sessions: Map<string, SessionMetadata>;
  private tmuxManager: TmuxManager;
  private logger: Logger;
  private config: SessionPoolConfig;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    tmuxManager: TmuxManager,
    config: Partial<SessionPoolConfig>,
    logger: Logger
  ) {
    super();
    this.tmuxManager = tmuxManager;
    this.logger = logger.child({ component: 'SessionPoolService' });
    this.sessions = new Map();
    this.config = {
      maxSessions: 50,
      inactivityTimeoutMs: 3600000, // 1 hour
      cleanupIntervalMs: 300000, // 5 minutes
      enableAutoCleanup: true,
      ...config,
    };
  }

  /**
   * Start session pool management
   */
  async start(): Promise<void> {
    this.logger.info('Starting session pool service', {
      maxSessions: this.config.maxSessions,
      inactivityTimeout: this.config.inactivityTimeoutMs,
    });

    // List existing tmux sessions and register them
    await this.discoverExistingSessions();

    // Start cleanup timer
    if (this.config.enableAutoCleanup) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupInactiveSessions().catch((err) => {
          this.logger.error({ err }, 'Session cleanup failed');
        });
      }, this.config.cleanupIntervalMs);
    }
  }

  /**
   * Stop session pool management
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping session pool service');

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Terminate all sessions gracefully
    await this.terminateAllSessions();
  }

  /**
   * Get or create session for workspace
   */
  async getOrCreateSession(workspace: string): Promise<SessionMetadata> {
    // Validate workspace name
    if (!this.isValidWorkspaceName(workspace)) {
      throw new Error(`Invalid workspace name: ${workspace}`);
    }

    // Check if session exists
    let session = this.sessions.get(workspace);

    if (session) {
      // Update last activity
      session.lastActivityAt = Date.now();
      this.logger.debug({ workspace }, 'Reusing existing session');
      return session;
    }

    // Check session limit
    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error(
        `Session limit reached (${this.config.maxSessions}). Cannot create new session.`
      );
    }

    // Create new session
    session = await this.createSession(workspace);
    this.sessions.set(workspace, session);

    this.emit('session:created', session);
    this.logger.info({ workspace, session }, 'Created new session');

    return session;
  }

  /**
   * Create new tmux session for workspace
   */
  private async createSession(workspace: string): Promise<SessionMetadata> {
    const sessionName = `claude-${workspace}`;
    const now = Date.now();

    try {
      // Create tmux session
      await this.tmuxManager.createSession(sessionName, workspace);

      const metadata: SessionMetadata = {
        workspace,
        sessionName,
        createdAt: now,
        lastActivityAt: now,
        activeRequests: 0,
        totalRequests: 0,
        status: 'active',
      };

      return metadata;
    } catch (err) {
      this.logger.error({ err, workspace }, 'Failed to create session');
      throw err;
    }
  }

  /**
   * Switch to different workspace
   */
  async switchWorkspace(
    currentWorkspace: string,
    targetWorkspace: string
  ): Promise<SessionMetadata> {
    this.logger.info({ currentWorkspace, targetWorkspace }, 'Switching workspace');

    // Get or create target session
    const targetSession = await this.getOrCreateSession(targetWorkspace);

    this.emit('workspace:switched', {
      from: currentWorkspace,
      to: targetWorkspace,
    });

    return targetSession;
  }

  /**
   * List all active sessions
   */
  listSessions(): SessionMetadata[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get session metadata
   */
  getSession(workspace: string): SessionMetadata | undefined {
    return this.sessions.get(workspace);
  }

  /**
   * Delete session
   */
  async deleteSession(workspace: string): Promise<void> {
    const session = this.sessions.get(workspace);
    if (!session) {
      throw new Error(`Session not found: ${workspace}`);
    }

    // Check for active requests
    if (session.activeRequests > 0) {
      throw new Error(
        `Cannot delete session with active requests (${session.activeRequests} pending)`
      );
    }

    // Terminate tmux session
    await this.tmuxManager.killSession(session.sessionName);

    // Remove from pool
    this.sessions.delete(workspace);

    this.emit('session:deleted', session);
    this.logger.info({ workspace }, 'Deleted session');
  }

  /**
   * Track request start
   */
  trackRequestStart(workspace: string): void {
    const session = this.sessions.get(workspace);
    if (session) {
      session.activeRequests++;
      session.totalRequests++;
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Track request completion
   */
  trackRequestComplete(workspace: string): void {
    const session = this.sessions.get(workspace);
    if (session) {
      session.activeRequests = Math.max(0, session.activeRequests - 1);
      session.lastActivityAt = Date.now();

      if (session.activeRequests === 0) {
        session.status = 'idle';
      }
    }
  }

  /**
   * Cleanup inactive sessions
   */
  private async cleanupInactiveSessions(): Promise<void> {
    const now = Date.now();
    const sessionsToClean: string[] = [];

    for (const [workspace, session] of this.sessions.entries()) {
      const inactiveMs = now - session.lastActivityAt;

      // Skip if session has active requests
      if (session.activeRequests > 0) {
        continue;
      }

      // Check if session exceeded inactivity timeout
      if (inactiveMs > this.config.inactivityTimeoutMs) {
        sessionsToClean.push(workspace);
      }
    }

    this.logger.info({ count: sessionsToClean.length }, 'Cleaning up inactive sessions');

    for (const workspace of sessionsToClean) {
      try {
        await this.deleteSession(workspace);
      } catch (err) {
        this.logger.error({ err, workspace }, 'Failed to cleanup session');
      }
    }
  }

  /**
   * Discover existing tmux sessions
   */
  private async discoverExistingSessions(): Promise<void> {
    try {
      const sessions = await this.tmuxManager.listSessions();

      for (const sessionName of sessions) {
        // Parse workspace from session name
        const match = sessionName.match(/^claude-(.+)$/);
        if (match) {
          const workspace = match[1];
          const metadata: SessionMetadata = {
            workspace,
            sessionName,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            activeRequests: 0,
            totalRequests: 0,
            status: 'active',
          };

          this.sessions.set(workspace, metadata);
          this.logger.info({ workspace }, 'Discovered existing session');
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to discover existing sessions');
    }
  }

  /**
   * Terminate all sessions
   */
  private async terminateAllSessions(): Promise<void> {
    const workspaces = Array.from(this.sessions.keys());

    for (const workspace of workspaces) {
      try {
        const session = this.sessions.get(workspace);
        if (session) {
          session.status = 'terminating';
          await this.tmuxManager.killSession(session.sessionName);
          this.sessions.delete(workspace);
        }
      } catch (err) {
        this.logger.error({ err, workspace }, 'Failed to terminate session');
      }
    }
  }

  /**
   * Validate workspace name
   */
  private isValidWorkspaceName(workspace: string): boolean {
    // Alphanumeric, hyphens, underscores only
    return /^[a-zA-Z0-9_-]+$/.test(workspace) && workspace.length <= 64;
  }

  /**
   * Get statistics
   */
  getStats() {
    const sessions = Array.from(this.sessions.values());
    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.status === 'active').length,
      idleSessions: sessions.filter(s => s.status === 'idle').length,
      totalRequests: sessions.reduce((sum, s) => sum + s.totalRequests, 0),
      activeRequests: sessions.reduce((sum, s) => sum + s.activeRequests, 0),
    };
  }
}
```

### TmuxManager Enhancements

**File**: `src/agent/services/TmuxManager.ts` (add methods)

```typescript
  /**
   * Create new tmux session
   */
  async createSession(sessionName: string, workspace: string): Promise<void> {
    try {
      await this.execCommand(`tmux new-session -d -s ${sessionName}`);

      // Set workspace environment variable
      await this.execCommand(
        `tmux set-environment -t ${sessionName} WORKSPACE_NAME ${workspace}`
      );

      // Start Claude CLI in the session
      await this.execCommand(
        `tmux send-keys -t ${sessionName} "claude" C-m`
      );

      // Wait for Claude to initialize
      await this.sleep(500);

      this.logger.info({ sessionName, workspace }, 'Created tmux session');
    } catch (err) {
      this.logger.error({ err, sessionName }, 'Failed to create session');
      throw err;
    }
  }

  /**
   * Kill tmux session
   */
  async killSession(sessionName: string): Promise<void> {
    try {
      await this.execCommand(`tmux kill-session -t ${sessionName}`);
      this.logger.info({ sessionName }, 'Killed tmux session');
    } catch (err) {
      // Session may already be dead
      if (!err.message.includes('session not found')) {
        throw err;
      }
    }
  }

  /**
   * List all tmux sessions
   */
  async listSessions(): Promise<string[]> {
    try {
      const output = await this.execCommand('tmux list-sessions -F "#{session_name}"');
      return output.trim().split('\n').filter(Boolean);
    } catch (err) {
      // No sessions running
      if (err.message.includes('no server running')) {
        return [];
      }
      throw err;
    }
  }
```

### Workspace Commands

**File**: `src/gateway/commands/workspace.ts`

```typescript
import { TelegramBot } from '../bot';
import { SessionPoolService } from '../../agent/services/SessionPoolService';
import { logger } from '../utils/logger';

export function registerWorkspaceCommands(
  bot: TelegramBot,
  sessionPool: SessionPoolService
) {
  // Switch workspace
  bot.onText(/\/ws_switch (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const targetWorkspace = match![1].trim();

    try {
      // Get current workspace from context
      const currentWorkspace = await getCurrentWorkspace(chatId);

      // Switch to target workspace
      const session = await sessionPool.switchWorkspace(currentWorkspace, targetWorkspace);

      // Update user's current workspace in DB
      await updateUserWorkspace(chatId, targetWorkspace);

      bot.sendMessage(
        chatId,
        `✓ Switched to workspace: **${targetWorkspace}**\n` +
        `Session: ${session.sessionName}\n` +
        `Requests: ${session.totalRequests}`
      );
    } catch (err) {
      logger.error({ err, chatId, targetWorkspace }, 'Workspace switch failed');
      bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // List workspaces
  bot.onText(/\/ws_list/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      const sessions = sessionPool.listSessions();

      if (sessions.length === 0) {
        bot.sendMessage(chatId, 'No active workspaces');
        return;
      }

      const list = sessions
        .map(s => {
          const age = Math.round((Date.now() - s.createdAt) / 1000 / 60);
          return `• **${s.workspace}** (${s.status}, ${s.activeRequests} active, ${age}m old)`;
        })
        .join('\n');

      bot.sendMessage(chatId, `Active workspaces:\n\n${list}`);
    } catch (err) {
      logger.error({ err, chatId }, 'List workspaces failed');
      bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // Show current workspace
  bot.onText(/\/ws_current/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      const workspace = await getCurrentWorkspace(chatId);
      const session = sessionPool.getSession(workspace);

      if (session) {
        bot.sendMessage(
          chatId,
          `Current workspace: **${workspace}**\n` +
          `Status: ${session.status}\n` +
          `Active requests: ${session.activeRequests}\n` +
          `Total requests: ${session.totalRequests}\n` +
          `Age: ${Math.round((Date.now() - session.createdAt) / 1000 / 60)} minutes`
        );
      } else {
        bot.sendMessage(chatId, `Current workspace: **${workspace}** (no session)`);
      }
    } catch (err) {
      logger.error({ err, chatId }, 'Get current workspace failed');
      bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // Create workspace
  bot.onText(/\/ws_create (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const workspace = match![1].trim();

    try {
      const session = await sessionPool.getOrCreateSession(workspace);

      bot.sendMessage(
        chatId,
        `✓ Created workspace: **${workspace}**\n` +
        `Session: ${session.sessionName}`
      );
    } catch (err) {
      logger.error({ err, chatId, workspace }, 'Create workspace failed');
      bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // Delete workspace
  bot.onText(/\/ws_delete (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const workspace = match![1].trim();

    try {
      await sessionPool.deleteSession(workspace);

      bot.sendMessage(chatId, `✓ Deleted workspace: **${workspace}**`);
    } catch (err) {
      logger.error({ err, chatId, workspace }, 'Delete workspace failed');
      bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });
}

// Helper functions
async function getCurrentWorkspace(chatId: number): Promise<string> {
  // Get from database or default
  return 'cc-bridge'; // Placeholder
}

async function updateUserWorkspace(chatId: number, workspace: string): Promise<void> {
  // Update in database
  // Placeholder
}
```

## Acceptance Criteria

- [ ] Session pool creates one tmux session per workspace
- [ ] Sessions named correctly: `claude-{workspace}`
- [ ] Lazy session creation (only when needed)
- [ ] Session reuse for same workspace
- [ ] `/ws_switch` command works correctly
- [ ] `/ws_list` shows all active workspaces
- [ ] `/ws_current` displays current workspace info
- [ ] `/ws_create` creates new workspace session
- [ ] `/ws_delete` deletes workspace session
- [ ] Per-workspace IPC directories created automatically
- [ ] Workspace isolation (no context leakage)
- [ ] Inactive sessions cleaned up after 1 hour
- [ ] Sessions with active requests not cleaned up
- [ ] Session creation completes in <500ms
- [ ] Workspace switching completes in <200ms
- [ ] Support 50 concurrent workspaces
- [ ] Invalid workspace names rejected
- [ ] Session metadata tracked accurately

## File Changes

### New Files
1. `src/agent/services/SessionPoolService.ts` - Session pool management
2. `src/gateway/commands/workspace.ts` - Workspace commands
3. `tests/unit/SessionPoolService.test.ts` - Unit tests
4. `tests/integration/multi-workspace.test.ts` - Integration tests

### Modified Files
1. `src/agent/services/TmuxManager.ts` - Add session management methods
2. `src/agent/index.ts` - Initialize SessionPoolService
3. `src/gateway/index.ts` - Register workspace commands
4. `src/gateway/services/ClaudeExecutor.ts` - Use SessionPoolService
5. `.env.example` - Add session pool configuration

### Deleted Files
- None

## Test Scenarios

### Test 1: Session Creation and Reuse

```typescript
describe('SessionPoolService', () => {
  it('should create session on first request', async () => {
    const session1 = await sessionPool.getOrCreateSession('project-a');

    expect(session1.workspace).toBe('project-a');
    expect(session1.sessionName).toBe('claude-project-a');
    expect(session1.activeRequests).toBe(0);

    // Verify tmux session exists
    const sessions = await tmuxManager.listSessions();
    expect(sessions).toContain('claude-project-a');
  });

  it('should reuse existing session', async () => {
    const session1 = await sessionPool.getOrCreateSession('project-a');
    const session2 = await sessionPool.getOrCreateSession('project-a');

    // Same session object
    expect(session1.sessionName).toBe(session2.sessionName);
    expect(session1.createdAt).toBe(session2.createdAt);
  });
});
```

### Test 2: Workspace Switching

```bash
# Start in default workspace
/start

# Ask Claude something
"What is 2+2?"
# Response in cc-bridge workspace

# Switch to different project
/ws_switch project-alpha

# Ask Claude something else
"What is the capital of France?"
# Response in project-alpha workspace, fresh context

# Switch back
/ws_switch cc-bridge

# Claude should remember first conversation
"What was the math problem I asked earlier?"
# Claude: "You asked what 2+2 is, which equals 4"
```

### Test 3: Session Isolation

```typescript
it('should isolate contexts between workspaces', async () => {
  // Create two sessions
  await sessionPool.getOrCreateSession('workspace-a');
  await sessionPool.getOrCreateSession('workspace-b');

  // Send command to workspace-a
  await executeInWorkspace('workspace-a', 'export TEST_VAR=hello');

  // Send command to workspace-b
  const result = await executeInWorkspace('workspace-b', 'echo $TEST_VAR');

  // workspace-b should not see workspace-a's variable
  expect(result.output).toBe('');
});
```

### Test 4: Inactive Session Cleanup

```typescript
it('should cleanup inactive sessions', async () => {
  // Create session
  const session = await sessionPool.getOrCreateSession('temp-workspace');

  // Mark as inactive (simulate time passing)
  session.lastActivityAt = Date.now() - 7200000; // 2 hours ago
  session.activeRequests = 0;

  // Run cleanup
  await sessionPool['cleanupInactiveSessions']();

  // Session should be deleted
  expect(sessionPool.getSession('temp-workspace')).toBeUndefined();
});

it('should not cleanup sessions with active requests', async () => {
  const session = await sessionPool.getOrCreateSession('active-workspace');

  // Mark as old but with active requests
  session.lastActivityAt = Date.now() - 7200000; // 2 hours ago
  session.activeRequests = 3;

  // Run cleanup
  await sessionPool['cleanupInactiveSessions']();

  // Session should still exist
  expect(sessionPool.getSession('active-workspace')).toBeDefined();
});
```

### Test 5: Session Limit

```typescript
it('should enforce session limit', async () => {
  const sessionPool = new SessionPoolService(tmuxManager, {
    maxSessions: 3,
  }, logger);

  // Create 3 sessions (should succeed)
  await sessionPool.getOrCreateSession('workspace-1');
  await sessionPool.getOrCreateSession('workspace-2');
  await sessionPool.getOrCreateSession('workspace-3');

  // Try to create 4th session (should fail)
  await expect(
    sessionPool.getOrCreateSession('workspace-4')
  ).rejects.toThrow('Session limit reached');
});
```

### Test 6: Concurrent Requests to Different Workspaces

```bash
# Terminal 1: Send to workspace-a
curl -X POST http://localhost:8080/execute \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "123",
    "workspace": "workspace-a",
    "command": "What is 2+2?"
  }' &

# Terminal 2: Send to workspace-b
curl -X POST http://localhost:8080/execute \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "123",
    "workspace": "workspace-b",
    "command": "What is the capital of France?"
  }' &

# Both should execute concurrently in separate sessions
wait

# Verify both responses received
# workspace-a: "4"
# workspace-b: "Paris"
```

### Test 7: Invalid Workspace Names

```typescript
it('should reject invalid workspace names', async () => {
  await expect(
    sessionPool.getOrCreateSession('../etc/passwd')
  ).rejects.toThrow('Invalid workspace name');

  await expect(
    sessionPool.getOrCreateSession('workspace with spaces')
  ).rejects.toThrow('Invalid workspace name');

  await expect(
    sessionPool.getOrCreateSession('workspace@special')
  ).rejects.toThrow('Invalid workspace name');
});
```

## Dependencies

- Task 0111 (TmuxManager implementation)
- Task 0120 (File Cleanup) for per-workspace cleanup
- Existing tmux infrastructure
- SQLite for workspace-user mapping

## Implementation Notes

### Session Naming Convention

```
claude-{workspace}
```

Examples:
- `claude-cc-bridge`
- `claude-project-alpha`
- `claude-client-xyz`

### IPC Directory Structure

```
/ipc/
  ├── cc-bridge/
  │   └── responses/
  │       └── {requestId}.json
  ├── project-alpha/
  │   └── responses/
  │       └── {requestId}.json
  └── client-xyz/
      └── responses/
          └── {requestId}.json
```

### Environment Variables per Session

Each tmux session has isolated environment:
- `WORKSPACE_NAME` - Current workspace
- `REQUEST_ID` - Set per command
- `CHAT_ID` - Set per command
- Custom variables per workspace (optional)

### Cleanup Strategy

1. Every 5 minutes, check all sessions
2. If session has 0 active requests AND last activity > 1 hour → delete
3. If session has active requests → preserve
4. On container shutdown → terminate all sessions gracefully

## Rollback Plan

If multi-workspace causes issues:

1. Disable session pooling:
   ```bash
   ENABLE_SESSION_POOLING=false
   ```

2. Fall back to single default session:
   ```typescript
   // Always use 'cc-bridge' workspace
   const workspace = 'cc-bridge';
   ```

3. All workspaces route to same session (lose isolation)

## Success Metrics

- Session creation: <500ms
- Workspace switching: <200ms
- Support 50 concurrent workspaces
- 100% context isolation between workspaces
- Zero session leaks (all cleaned up)
- Memory overhead <50MB for 50 sessions
- Zero race conditions in concurrent access
- All test scenarios pass

