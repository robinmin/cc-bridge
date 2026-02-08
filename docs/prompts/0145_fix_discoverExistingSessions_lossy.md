---
wbs: "0145"
title: "Fix discoverExistingSessions Lossy"
status: "completed"
priority: "medium"
complexity: "medium"
estimated_hours: 2
phase: "code-review-fixes"
dependencies: []
created: 2026-02-07
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

# Fix discoverExistingSessions Lossy

## Description

Either store metadata persistently for session discovery or document limitation clearly. The `discoverExistingSessions` function in `src/gateway/services/SessionPoolService.ts:349-384` loses important metadata when discovering sessions.

## Requirements

### Functional Requirements

1. Choose approach: persistent metadata OR clear documentation
2. If persistent: Implement metadata storage for sessions
3. If documented: Clearly document limitations in code
4. Ensure users understand the trade-offs

### Non-Functional Requirements

- Clear documentation of behavior
- Minimal performance impact

## Design

### Current State Analysis

**File**: `src/gateway/services/SessionPoolService.ts:349-384`

```typescript
private async discoverExistingSessions(): Promise<void> {
  const sessions = await this.tmuxManager.listSessions();

  for (const session of sessions) {
    // Loses metadata: createdAt, lastActivityAt, totalRequests, etc.
    this.sessions.set(workspace, {
      name: session.name,
      workspace: this.extractWorkspace(session.name),
      status: 'active',
      // Missing: createdAt, lastActivityAt, totalRequests
    });
  }
}
```

### Solution Options

**Option 1: Persistent Metadata Storage**

```typescript
/**
 * Session metadata file structure
 */
interface SessionMetadataFile {
  sessionName: string;
  workspace: string;
  createdAt: number;
  lastActivityAt: number;
  totalRequests: number;
  status: 'active' | 'idle' | 'draining';
}

/**
 * Discover existing sessions with metadata recovery
 */
private async discoverExistingSessions(): Promise<void> {
  const sessions = await this.tmuxManager.listSessions();

  for (const session of sessions) {
    const workspace = this.extractWorkspace(session.name);

    // Try to load metadata from disk
    const metadata = await this.loadSessionMetadata(session.name);

    if (metadata) {
      // Use persisted metadata
      this.sessions.set(workspace, {
        name: session.name,
        workspace,
        status: metadata.status,
        createdAt: metadata.createdAt,
        lastActivityAt: metadata.lastActivityAt,
        totalRequests: metadata.totalRequests,
        activeRequests: 0, // Reset on restart
      });

      this.logger.debug(
        { workspace, recovered: true },
        'Session discovered with metadata'
      );
    } else {
      // Create new metadata with defaults
      const now = Date.now();
      this.sessions.set(workspace, {
        name: session.name,
        workspace,
        status: 'active',
        createdAt: now, // Best guess: now
        lastActivityAt: now,
        totalRequests: 0, // Reset on restart
        activeRequests: 0,
      });

      this.logger.warn(
        { workspace, recovered: false },
        'Session discovered without metadata - using defaults'
      );
    }
  }
}

/**
 * Load session metadata from disk
 */
private async loadSessionMetadata(
  sessionName: string
): Promise<SessionMetadataFile | null> {
  try {
    const metadataFile = this.getSessionMetadataPath(sessionName);
    const content = await readFile(metadataFile, 'utf-8');
    return JSON.parse(content) as SessionMetadataFile;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    this.logger.warn({ sessionName, error }, 'Failed to load session metadata');
    return null;
  }
}

/**
 * Save session metadata to disk
 */
private async saveSessionMetadata(
  workspace: string
): Promise<void> {
  const session = this.sessions.get(workspace);
  if (!session) {
    return;
  }

  try {
    const metadataFile = this.getSessionMetadataPath(session.name);
    const metadata: SessionMetadataFile = {
      sessionName: session.name,
      workspace: session.workspace,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      totalRequests: session.totalRequests,
      status: session.status,
    };

    await writeFile(metadataFile, JSON.stringify(metadata, null, 2));
  } catch (error) {
    this.logger.warn({ workspace, error }, 'Failed to save session metadata');
  }
}

/**
 * Get metadata file path for session
 */
private getSessionMetadataPath(sessionName: string): string {
  const safeName = sessionName.replace(/[^a-zA-Z0-9-_]/g, '_');
  return `/data/sessions/${safeName}.json`;
}

// Update metadata when session changes
private async updateSessionActivity(workspace: string): Promise<void> {
  const session = this.sessions.get(workspace);
  if (!session) {
    return;
  }

  session.lastActivityAt = Date.now();
  session.totalRequests++;

  // Persist metadata
  await this.saveSessionMetadata(workspace);
}
```

**Option 2: Clear Documentation (Alternative)**

```typescript
/**
 * Discover existing tmux sessions and add to pool.
 *
 * ⚠️ LIMITATION: Metadata Loss on Restart
 *
 * This method discovers active tmux sessions but cannot recover:
 * - createdAt timestamps (will be set to current time)
 * - lastActivityAt timestamps (will be set to current time)
 * - totalRequests count (will be reset to 0)
 *
 * This is because tmux does not store this metadata. Only the session
 * name and workspace are recoverable.
 *
 * To preserve metadata across restarts, consider using persistent storage
 * (see Option 1 above).
 *
 * @returns Promise that resolves when discovery is complete
 */
private async discoverExistingSessions(): Promise<void> {
  // ... implementation ...
}
```

### Recommended Approach: Option 1 (Persistent Metadata)

Persistent metadata provides:
1. Accurate session tracking across restarts
2. Better observability and debugging
3. Historical request counts
4. Proper age tracking

## Acceptance Criteria

- [ ] Session metadata persisted to disk
- [ ] Metadata recovered on session discovery
- [ ] Graceful fallback when metadata not found
- [ ] Metadata updated on session activity
- [ ] Clear logging for recovery/fallback cases
- [ ] All tests pass

## File Changes

### New Files
1. `src/gateway/tests/session-metadata.test.ts` - Metadata persistence tests

### Modified Files
1. `src/gateway/services/SessionPoolService.ts` - Add metadata persistence

### Deleted Files
- None

## Test Scenarios

### Test 1: Metadata Persistence
```typescript
const pool = new SessionPoolService(config, logger);

// Create session
await pool.getOrCreateSession('test-workspace');
const session1 = pool.getSession('test-workspace');
const originalCreatedAt = session1.createdAt;

// Save metadata
await pool.saveSessionMetadata('test-workspace');

// Simulate restart: create new pool instance
const pool2 = new SessionPoolService(config, logger);
await pool2.discoverExistingSessions();

const session2 = pool2.getSession('test-workspace');
assert(session2.createdAt === originalCreatedAt); // Preserved!
```

### Test 2: Metadata Recovery
```typescript
// Create session metadata file manually
const metadata: SessionMetadataFile = {
  sessionName: 'claude-test-workspace',
  workspace: 'test-workspace',
  createdAt: Date.now() - 1000000, // Old timestamp
  lastActivityAt: Date.now() - 500000,
  totalRequests: 42,
  status: 'active',
};

const metadataPath = `/data/sessions/claude-test-workspace.json`;
await writeFile(metadataPath, JSON.stringify(metadata));

// Discover sessions
await pool.discoverExistingSessions();

const session = pool.getSession('test-workspace');
assert(session.createdAt === metadata.createdAt);
assert(session.totalRequests === 42);
```

### Test 3: Fallback When No Metadata
```typescript
// Create tmux session without metadata
await tmuxManager.createSession('test-workspace');

// Delete metadata if exists
const metadataPath = `/data/sessions/claude-test-workspace.json`;
await unlink(metadataPath).catch(() => {});

// Discover should use defaults
await pool.discoverExistingSessions();

const session = pool.getSession('test-workspace');
assert(session.createdAt > 0); // Should be set to now
assert(session.totalRequests === 0); // Should be reset
```

### Test 4: Metadata Cleanup on Session Delete
```typescript
await pool.getOrCreateSession('test-workspace');
const metadataPath = `/data/sessions/claude-test-workspace.json`;

assert(await fileExists(metadataPath));

await pool.deleteSession('test-workspace');

assert(!await fileExists(metadataPath)); // Should be deleted
```

## Dependencies

- None

## Implementation Notes

- Store metadata in `/data/sessions/` directory
- Use JSON format for easy debugging
- Clean up metadata files when sessions are deleted
- Handle read/write errors gracefully
- Consider adding metadata compression for large pools
- Add metadata TTL for old sessions

## Rollback Plan

If persistent metadata causes issues:
1. Add feature flag to disable persistence
2. Fall back to in-memory only
3. Keep metadata operations optional

## Success Metrics

- Metadata persisted for all sessions
- Metadata recovered on restart
- Graceful fallback when metadata missing
- <10ms overhead for metadata operations
