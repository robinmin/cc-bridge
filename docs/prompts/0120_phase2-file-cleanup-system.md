---
wbs: "0120"
title: "Phase 2.1: File Cleanup System Implementation"
status: "completed"
priority: "high"
complexity: "medium"
estimated_hours: 4
phase: "phase-2-filesystem-polish"
dependencies: ["0116"]
created: 2026-02-07
completed: 2026-02-07
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

# Phase 2.1: File Cleanup System Implementation

## Description

Implement a production-ready file cleanup system for the IPC directory to prevent disk space exhaustion from abandoned response files. The system includes TTL-based cleanup, orphan detection, automatic cleanup on container lifecycle events, and manual cleanup commands for debugging.

## Requirements

### Functional Requirements

1. **TTL-Based Cleanup**
   - Configurable TTL via environment variable (default: 1 hour)
   - Periodic cleanup runs every 5 minutes
   - Delete response files older than TTL
   - Preserve files for active requests (in-flight queries)

2. **Orphan File Detection**
   - Identify response files without corresponding active requests
   - Track request lifecycle (created → processing → completed/failed)
   - Clean up orphaned files after grace period (15 minutes)
   - Log orphan detections for debugging

3. **Automatic Lifecycle Cleanup**
   - Run cleanup on container start (clear stale files from crashes)
   - Run cleanup on graceful shutdown
   - Emergency cleanup when disk space < 10%
   - Preserve files from last 5 minutes on crash recovery

4. **Manual Cleanup Commands**
   - CLI command to list all response files with ages
   - CLI command to force cleanup (bypass TTL)
   - CLI command to clean specific workspace
   - Dry-run mode for safety

### Non-Functional Requirements

- Cleanup runs must not block request processing
- Cleanup operations must be atomic (no partial deletions)
- Must handle concurrent cleanup attempts (file locking)
- Must log all cleanup operations for audit
- Must complete cleanup in < 5 seconds for typical loads

## Design

### File Cleanup Service

**File**: `src/agent/services/FileCleanupService.ts`

```typescript
import { Logger } from 'pino';
import { promises as fs } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

interface CleanupConfig {
  ipcBasePath: string;
  ttlMs: number; // Default: 3600000 (1 hour)
  cleanupIntervalMs: number; // Default: 300000 (5 minutes)
  orphanGracePeriodMs: number; // Default: 900000 (15 minutes)
  minDiskSpacePercent: number; // Default: 10
  enabled: boolean;
}

interface CleanupStats {
  filesScanned: number;
  filesDeleted: number;
  bytesFreed: number;
  orphansFound: number;
  errors: number;
  durationMs: number;
}

interface ResponseFileMetadata {
  requestId: string;
  workspace: string;
  filePath: string;
  ageMs: number;
  sizeBytes: number;
  isOrphan: boolean;
}

export class FileCleanupService extends EventEmitter {
  private config: CleanupConfig;
  private logger: Logger;
  private cleanupTimer?: NodeJS.Timeout;
  private activeRequests: Set<string>; // Track in-flight request IDs
  private isRunning: boolean = false;

  constructor(config: CleanupConfig, logger: Logger) {
    super();
    this.config = {
      ttlMs: 3600000, // 1 hour
      cleanupIntervalMs: 300000, // 5 minutes
      orphanGracePeriodMs: 900000, // 15 minutes
      minDiskSpacePercent: 10,
      enabled: true,
      ...config,
    };
    this.logger = logger.child({ component: 'FileCleanupService' });
    this.activeRequests = new Set();
  }

  /**
   * Start periodic cleanup
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info('File cleanup disabled via configuration');
      return;
    }

    this.logger.info('Starting file cleanup service', {
      ttlMs: this.config.ttlMs,
      intervalMs: this.config.cleanupIntervalMs,
    });

    // Initial cleanup on startup (clear stale files)
    await this.runCleanup({ onStartup: true });

    // Schedule periodic cleanup
    this.cleanupTimer = setInterval(() => {
      this.runCleanup({ periodic: true }).catch((err) => {
        this.logger.error({ err }, 'Periodic cleanup failed');
      });
    }, this.config.cleanupIntervalMs);
  }

  /**
   * Stop cleanup service
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping file cleanup service');

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Final cleanup before shutdown
    await this.runCleanup({ onShutdown: true });
  }

  /**
   * Track active request
   */
  trackRequest(requestId: string): void {
    this.activeRequests.add(requestId);
  }

  /**
   * Untrack completed request
   */
  untrackRequest(requestId: string): void {
    this.activeRequests.delete(requestId);
  }

  /**
   * Run cleanup operation
   */
  async runCleanup(options: {
    onStartup?: boolean;
    onShutdown?: boolean;
    periodic?: boolean;
    force?: boolean;
    workspace?: string;
    dryRun?: boolean;
  } = {}): Promise<CleanupStats> {
    if (this.isRunning && !options.force) {
      this.logger.warn('Cleanup already running, skipping');
      return this.emptyStats();
    }

    this.isRunning = true;
    const startTime = Date.now();

    const stats: CleanupStats = {
      filesScanned: 0,
      filesDeleted: 0,
      bytesFreed: 0,
      orphansFound: 0,
      errors: 0,
      durationMs: 0,
    };

    try {
      this.logger.info({ options }, 'Running file cleanup');

      // Get all response files
      const files = await this.scanResponseFiles(options.workspace);
      stats.filesScanned = files.length;

      // Determine cleanup threshold
      const now = Date.now();
      const ttl = options.onStartup ? 0 : this.config.ttlMs;

      for (const file of files) {
        try {
          // Check if file should be deleted
          const shouldDelete = this.shouldDeleteFile(file, now, ttl, options);

          if (shouldDelete) {
            if (file.isOrphan) {
              stats.orphansFound++;
            }

            if (!options.dryRun) {
              await this.deleteFile(file.filePath);
              stats.bytesFreed += file.sizeBytes;
            }
            stats.filesDeleted++;

            this.logger.debug({
              requestId: file.requestId,
              workspace: file.workspace,
              ageMs: file.ageMs,
              isOrphan: file.isOrphan,
              dryRun: options.dryRun,
            }, 'Deleted response file');
          }
        } catch (err) {
          stats.errors++;
          this.logger.error({ err, file }, 'Failed to delete file');
        }
      }

      stats.durationMs = Date.now() - startTime;

      this.logger.info({ stats, options }, 'Cleanup completed');
      this.emit('cleanup:complete', stats);

      return stats;
    } catch (err) {
      this.logger.error({ err, options }, 'Cleanup failed');
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * List all response files with metadata
   */
  async listFiles(workspace?: string): Promise<ResponseFileMetadata[]> {
    return this.scanResponseFiles(workspace);
  }

  /**
   * Check disk space and trigger emergency cleanup if needed
   */
  async checkDiskSpace(): Promise<void> {
    // Implementation would use statvfs or similar
    // Placeholder for now
    this.logger.debug('Checking disk space');
  }

  /**
   * Scan all response files
   */
  private async scanResponseFiles(workspace?: string): Promise<ResponseFileMetadata[]> {
    const files: ResponseFileMetadata[] = [];
    const basePath = this.config.ipcBasePath;

    try {
      const workspaces = workspace
        ? [workspace]
        : await fs.readdir(basePath);

      for (const ws of workspaces) {
        const responsesDir = path.join(basePath, ws, 'responses');

        try {
          const responseFiles = await fs.readdir(responsesDir);

          for (const filename of responseFiles) {
            if (!filename.endsWith('.json')) continue;

            const filePath = path.join(responsesDir, filename);
            const requestId = filename.replace('.json', '');

            try {
              const stats = await fs.stat(filePath);
              const ageMs = Date.now() - stats.mtimeMs;
              const isOrphan = !this.activeRequests.has(requestId);

              files.push({
                requestId,
                workspace: ws,
                filePath,
                ageMs,
                sizeBytes: stats.size,
                isOrphan,
              });
            } catch (err) {
              this.logger.warn({ err, filePath }, 'Failed to stat file');
            }
          }
        } catch (err) {
          // Workspace directory may not exist yet
          if ((err as any).code !== 'ENOENT') {
            this.logger.warn({ err, workspace: ws }, 'Failed to read responses directory');
          }
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to scan response files');
      throw err;
    }

    return files;
  }

  /**
   * Determine if file should be deleted
   */
  private shouldDeleteFile(
    file: ResponseFileMetadata,
    now: number,
    ttl: number,
    options: { force?: boolean; onStartup?: boolean }
  ): boolean {
    // Force delete mode
    if (options.force) return true;

    // Startup cleanup - delete files older than grace period (5 minutes)
    if (options.onStartup) {
      const graceMs = 300000; // 5 minutes
      return file.ageMs > graceMs;
    }

    // Active request - never delete
    if (this.activeRequests.has(file.requestId)) {
      return false;
    }

    // TTL-based deletion
    if (file.ageMs > ttl) {
      return true;
    }

    // Orphan detection - delete after grace period
    if (file.isOrphan && file.ageMs > this.config.orphanGracePeriodMs) {
      return true;
    }

    return false;
  }

  /**
   * Delete file atomically
   */
  private async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if ((err as any).code !== 'ENOENT') {
        throw err;
      }
      // File already deleted (race condition)
    }
  }

  /**
   * Empty stats object
   */
  private emptyStats(): CleanupStats {
    return {
      filesScanned: 0,
      filesDeleted: 0,
      bytesFreed: 0,
      orphansFound: 0,
      errors: 0,
      durationMs: 0,
    };
  }
}
```

### Configuration

**File**: `src/agent/config.ts` (add to existing config)

```typescript
export const cleanupConfig = {
  enabled: process.env.FILE_CLEANUP_ENABLED !== 'false',
  ttlMs: parseInt(process.env.FILE_CLEANUP_TTL_MS || '3600000', 10),
  cleanupIntervalMs: parseInt(process.env.FILE_CLEANUP_INTERVAL_MS || '300000', 10),
  orphanGracePeriodMs: parseInt(process.env.FILE_CLEANUP_ORPHAN_GRACE_MS || '900000', 10),
  minDiskSpacePercent: parseInt(process.env.FILE_CLEANUP_MIN_DISK_PERCENT || '10', 10),
  ipcBasePath: process.env.IPC_BASE_PATH || '/ipc',
};
```

### CLI Commands

**File**: `src/agent/cli/cleanup.ts`

```typescript
import { Command } from 'commander';
import { FileCleanupService } from '../services/FileCleanupService';
import { logger } from '../utils/logger';
import { cleanupConfig } from '../config';

const program = new Command();

program
  .name('cleanup')
  .description('Manage IPC file cleanup');

program
  .command('list')
  .option('-w, --workspace <name>', 'Filter by workspace')
  .description('List all response files')
  .action(async (options) => {
    const service = new FileCleanupService(cleanupConfig, logger);
    const files = await service.listFiles(options.workspace);

    console.table(files.map(f => ({
      RequestID: f.requestId,
      Workspace: f.workspace,
      Age: `${Math.round(f.ageMs / 1000)}s`,
      Size: `${Math.round(f.sizeBytes / 1024)}KB`,
      Orphan: f.isOrphan ? 'YES' : 'NO',
    })));
  });

program
  .command('run')
  .option('-w, --workspace <name>', 'Clean specific workspace')
  .option('-f, --force', 'Bypass TTL, delete all files')
  .option('-d, --dry-run', 'Show what would be deleted')
  .description('Run cleanup now')
  .action(async (options) => {
    const service = new FileCleanupService(cleanupConfig, logger);
    const stats = await service.runCleanup({
      workspace: options.workspace,
      force: options.force,
      dryRun: options.dryRun,
    });

    console.log('Cleanup complete:', stats);
  });

program.parse();
```

## Acceptance Criteria

- [ ] Cleanup service starts automatically with agent
- [ ] Periodic cleanup runs every 5 minutes
- [ ] Files older than TTL are deleted correctly
- [ ] Active request files are never deleted (tracked correctly)
- [ ] Orphaned files are detected and cleaned after grace period
- [ ] Startup cleanup removes stale files from previous runs
- [ ] Shutdown cleanup runs on graceful container stop
- [ ] CLI command lists all response files with metadata
- [ ] CLI command with --dry-run shows deletions without executing
- [ ] CLI command with --force deletes all files regardless of TTL
- [ ] Cleanup stats are logged with metrics (files deleted, bytes freed)
- [ ] Concurrent cleanup attempts are handled safely (no duplicate runs)
- [ ] Cleanup completes in < 5 seconds for 1000 files

## File Changes

### New Files
1. `src/agent/services/FileCleanupService.ts` - Main cleanup service
2. `src/agent/cli/cleanup.ts` - CLI commands for manual cleanup
3. `tests/unit/FileCleanupService.test.ts` - Unit tests
4. `tests/integration/cleanup-integration.test.ts` - Integration tests

### Modified Files
1. `src/agent/config.ts` - Add cleanup configuration
2. `src/agent/index.ts` - Initialize and start cleanup service
3. `src/agent/services/TmuxManager.ts` - Track/untrack active requests
4. `.env.example` - Add cleanup environment variables

### Deleted Files
- None

## Test Scenarios

### Test 1: TTL-Based Cleanup

```typescript
describe('FileCleanupService - TTL', () => {
  it('should delete files older than TTL', async () => {
    // Create old file (2 hours ago)
    const oldFile = '/ipc/test/responses/old-request.json';
    await fs.writeFile(oldFile, JSON.stringify({ data: 'test' }));
    await fs.utimes(oldFile, Date.now() / 1000 - 7200, Date.now() / 1000 - 7200);

    // Create recent file (30 minutes ago)
    const recentFile = '/ipc/test/responses/recent-request.json';
    await fs.writeFile(recentFile, JSON.stringify({ data: 'test' }));
    await fs.utimes(recentFile, Date.now() / 1000 - 1800, Date.now() / 1000 - 1800);

    const service = new FileCleanupService({
      ipcBasePath: '/ipc',
      ttlMs: 3600000, // 1 hour
    }, logger);

    const stats = await service.runCleanup();

    expect(stats.filesDeleted).toBe(1);
    expect(await fs.access(oldFile).catch(() => false)).toBe(false); // Deleted
    expect(await fs.access(recentFile).then(() => true).catch(() => false)).toBe(true); // Exists
  });
});
```

### Test 2: Active Request Protection

```typescript
it('should never delete files for active requests', async () => {
  const activeRequestId = 'active-001';
  const file = `/ipc/test/responses/${activeRequestId}.json`;

  // Create old file (2 hours ago)
  await fs.writeFile(file, JSON.stringify({ data: 'test' }));
  await fs.utimes(file, Date.now() / 1000 - 7200, Date.now() / 1000 - 7200);

  const service = new FileCleanupService({
    ipcBasePath: '/ipc',
    ttlMs: 3600000,
  }, logger);

  // Track as active request
  service.trackRequest(activeRequestId);

  const stats = await service.runCleanup();

  expect(stats.filesDeleted).toBe(0);
  expect(await fs.access(file).then(() => true).catch(() => false)).toBe(true); // Still exists
});
```

### Test 3: Orphan Detection

```typescript
it('should detect and clean orphaned files', async () => {
  const orphanFile = '/ipc/test/responses/orphan-001.json';

  // Create orphan file (30 minutes ago, not tracked)
  await fs.writeFile(orphanFile, JSON.stringify({ data: 'test' }));
  await fs.utimes(orphanFile, Date.now() / 1000 - 1800, Date.now() / 1000 - 1800);

  const service = new FileCleanupService({
    ipcBasePath: '/ipc',
    ttlMs: 3600000,
    orphanGracePeriodMs: 900000, // 15 minutes
  }, logger);

  const stats = await service.runCleanup();

  expect(stats.orphansFound).toBe(1);
  expect(stats.filesDeleted).toBe(1);
});
```

### Test 4: Startup Cleanup

```bash
# Simulate crash recovery - create stale files
echo '{"data":"stale"}' > /ipc/cc-bridge/responses/stale-001.json
touch -t 202402070000 /ipc/cc-bridge/responses/stale-001.json

# Start container
docker-compose up -d claude-agent

# Wait for startup cleanup
sleep 3

# Verify stale file deleted
docker exec claude-cc-bridge test ! -f /ipc/cc-bridge/responses/stale-001.json
echo "✓ Stale files cleaned on startup"
```

### Test 5: CLI List Command

```bash
# List all response files
docker exec claude-cc-bridge bun run src/agent/cli/cleanup.ts list

# Expected output:
# RequestID        Workspace    Age      Size    Orphan
# req-001          cc-bridge    120s     4KB     NO
# req-002          cc-bridge    3600s    15KB    YES
```

### Test 6: CLI Dry-Run

```bash
# Run cleanup in dry-run mode
docker exec claude-cc-bridge bun run src/agent/cli/cleanup.ts run --dry-run

# Expected output:
# Cleanup complete: {
#   filesScanned: 10,
#   filesDeleted: 3,  (would be deleted)
#   bytesFreed: 45KB,
#   orphansFound: 1,
#   errors: 0,
#   durationMs: 25
# }

# Verify files still exist
docker exec claude-cc-bridge ls /ipc/cc-bridge/responses/
# Should show all files (nothing deleted)
```

### Test 7: Concurrent Cleanup Safety

```typescript
it('should handle concurrent cleanup attempts safely', async () => {
  const service = new FileCleanupService({
    ipcBasePath: '/ipc',
    ttlMs: 3600000,
  }, logger);

  // Start two cleanups simultaneously
  const cleanup1 = service.runCleanup();
  const cleanup2 = service.runCleanup();

  const [stats1, stats2] = await Promise.all([cleanup1, cleanup2]);

  // One should complete, one should skip
  expect(stats1.filesScanned + stats2.filesScanned).toBeGreaterThan(0);
  expect(Math.min(stats1.filesScanned, stats2.filesScanned)).toBe(0); // One skipped
});
```

## Dependencies

- Task 0116 (Phase 1 Integration Test) must be complete
- Node.js filesystem APIs (fs.promises)
- Commander.js for CLI (already in project)
- Pino logger (already in project)

## Implementation Notes

### Request Tracking Integration

Modify `TmuxManager.ts` to track requests:

```typescript
async sendCommand(command: string, context: ExecutionContext): Promise<void> {
  // Track request start
  this.cleanupService.trackRequest(context.requestId);

  try {
    // Execute command...
  } finally {
    // Untrack on completion (handled by callback endpoint)
  }
}
```

### Startup Integration

Modify `src/agent/index.ts`:

```typescript
import { FileCleanupService } from './services/FileCleanupService';

const cleanupService = new FileCleanupService(cleanupConfig, logger);

// Start cleanup on boot
await cleanupService.start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await cleanupService.stop();
  process.exit(0);
});
```

### Environment Variables

```bash
FILE_CLEANUP_ENABLED=true
FILE_CLEANUP_TTL_MS=3600000          # 1 hour
FILE_CLEANUP_INTERVAL_MS=300000      # 5 minutes
FILE_CLEANUP_ORPHAN_GRACE_MS=900000  # 15 minutes
FILE_CLEANUP_MIN_DISK_PERCENT=10
```

## Rollback Plan

If cleanup causes issues:

1. Disable via environment variable:
   ```bash
   FILE_CLEANUP_ENABLED=false
   docker-compose restart claude-agent
   ```

2. Files will accumulate but system will continue working

3. Manual cleanup with:
   ```bash
   find /ipc -name "*.json" -mtime +1 -delete
   ```

## Success Metrics

- Cleanup runs complete in < 5 seconds for 1000 files
- Zero accidental deletions of active request files
- Disk space usage stays below 100MB in normal operation
- 100% detection rate for orphaned files
- No performance impact on request processing
- All CLI commands execute in < 1 second

