---
wbs: "0146"
title: "Fix FileCleanupService Race Condition"
status: "completed"
priority: "medium"
complexity: "simple"
estimated_hours: 1
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

# Fix FileCleanupService Race Condition

## Description

Add explicit ENOENT handling around unlink() operations in `src/gateway/services/file-cleanup.ts:130-180`. Files can be deleted by another process between listing and cleanup attempts.

## Requirements

### Functional Requirements

1. Add ENOENT error handling around unlink operations
2. Handle concurrent cleanup gracefully
3. Log race conditions for debugging
4. Continue cleanup even if some files are missing

### Non-Functional Requirements

- No crashes from missing files
- Proper logging of race conditions
- Idempotent cleanup operations

## Design

### Current State

**File**: `src/gateway/services/file-cleanup.ts:130-180`

```typescript
async cleanupOldFiles(): Promise<void> {
  const files = await this.listFiles();

  for (const file of files) {
    if (this.shouldCleanup(file)) {
      await unlink(file.path); // Can fail with ENOENT
    }
  }
}
```

### Solution

**File**: `src/gateway/services/file-cleanup.ts`

```typescript
import { unlink } from 'fs/promises';
import { constants } from 'fs';

/**
 * Cleanup old files with race condition handling
 */
async cleanupOldFiles(): Promise<void> {
  const startTime = Date.now();
  let cleanedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  try {
    const files = await this.listFiles();

    this.logger.debug(
      { fileCount: files.length },
      'Starting file cleanup'
    );

    for (const file of files) {
      if (this.shouldCleanup(file)) {
        try {
          // Check if file still exists before unlinking
          await this.safeUnlink(file.path);
          cleanedCount++;
        } catch (error) {
          if (error.code === 'ENOENT') {
            // File was deleted by another process
            skippedCount++;
            this.logger.debug(
              { file: file.path },
              'File already deleted by another process (race condition)'
            );
          } else {
            errorCount++;
            this.logger.error(
              { file: file.path, error },
              'Failed to cleanup file'
            );
          }
        }
      }
    }

    const duration = Date.now() - startTime;

    this.logger.info(
      { cleanedCount, skippedCount, errorCount, duration },
      'File cleanup completed'
    );
  } catch (error) {
    this.logger.error({ error }, 'File cleanup failed');
    throw error;
  }
}

/**
 * Safely unlink a file with proper error handling
 */
private async safeUnlink(filePath: string): Promise<void> {
  try {
    // Use fileExists check for early exit
    const exists = await this.fileExists(filePath);

    if (!exists) {
      this.logger.debug({ filePath }, 'File does not exist, skipping unlink');
      return;
    }

    // Attempt to unlink
    await unlink(filePath);

    this.logger.trace({ filePath }, 'File unlinked successfully');
  } catch (error) {
    // Handle ENOENT gracefully (race condition)
    if (error.code === 'ENOENT') {
      this.logger.debug(
        { filePath },
        'File disappeared between check and unlink (race condition)'
      );
      return; // Not an error, file is gone
    }

    // Handle EACCES (permission error)
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      this.logger.warn(
        { filePath, error },
        'Permission denied when deleting file'
      );
      throw new CleanupError(
        `Permission denied: ${filePath}`,
        'PERMISSION_DENIED'
      );
    }

    // Handle other errors
    this.logger.error({ filePath, error }, 'Unexpected error unlinking file');
    throw error;
  }
}

/**
 * Check if file exists (stat-based)
 */
private async fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Enhanced file listing with metadata
 */
private async listFiles(): Promise<Array<{ path: string; age: number }>> {
  const files: Array<{ path: string; age: number }> = [];

  try {
    const entries = await readdir(this.cleanupDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = join(this.cleanupDir, entry.name);

        try {
          const stats = await stat(filePath);
          const age = Date.now() - stats.mtimeMs;
          files.push({ path: filePath, age });
        } catch (error) {
          this.logger.warn(
            { filePath, error },
            'Failed to stat file during listing'
          );
        }
      }
    }
  } catch (error) {
    this.logger.error({ cleanupDir: this.cleanupDir, error }, 'Failed to list files');
  }

  return files;
}
```

### Custom Error Class

```typescript
/**
 * Cleanup error with type
 */
class CleanupError extends Error {
  constructor(message: string, public type: string) {
    super(message);
    this.name = 'CleanupError';
  }
}
```

## Acceptance Criteria

- [ ] ENOENT errors handled gracefully
- [ ] Cleanup continues even when files are missing
- [ ] Race conditions logged appropriately
- [ ] Permission errors handled separately
- [ ] Proper statistics (cleaned, skipped, error counts)
- [ ] All tests pass

## File Changes

### New Files
1. `src/gateway/tests/file-cleanup-race-condition.test.ts` - Race condition tests

### Modified Files
1. `src/gateway/services/file-cleanup.ts` - Add ENOENT handling

### Deleted Files
- None

## Test Scenarios

### Test 1: ENOENT Handling
```typescript
const cleanup = new FileCleanupService(config, logger);

// Create file
const testFile = '/tmp/test-cleanup.txt';
await writeFile(testFile, 'test');

// Mark for cleanup
cleanup.markForCleanup(testFile);

// Delete file externally (race condition)
await unlink(testFile);

// Cleanup should not throw
await cleanup.cleanupOldFiles();
```

### Test 2: Concurrent Cleanup
```typescript
const cleanup1 = new FileCleanupService(config, logger);
const cleanup2 = new FileCleanupService(config, logger);

// Both try to cleanup same files
await Promise.all([
  cleanup1.cleanupOldFiles(),
  cleanup2.cleanupOldFiles(),
]);

// Should not throw, should handle gracefully
```

### Test 3: Permission Error Handling
```typescript
// Create read-only file
const testFile = '/tmp/readonly.txt';
await writeFile(testFile, 'test');
await chmod(testFile, 0o444);

const cleanup = new FileCleanupService(config, logger);

try {
  await cleanup.cleanupOldFiles();
  // Should throw permission error
  assert.fail('Should have thrown permission error');
} catch (error) {
  assert(error.type === 'PERMISSION_DENIED');
}
```

### Test 4: Statistics Accuracy
```typescript
const cleanup = new FileCleanupService(config, logger);

// Create files
for (let i = 0; i < 10; i++) {
  await writeFile(`/tmp/test${i}.txt`, 'test');
}

// Delete some externally
await unlink('/tmp/test5.txt');
await unlink('/tmp/test6.txt');

// Cleanup
await cleanup.cleanupOldFiles();

// Should report 8 cleaned, 2 skipped
```

## Dependencies

- None

## Implementation Notes

- Use stat-based file existence check (more reliable)
- Log race conditions at debug level
- Separate permission errors from race conditions
- Track statistics for monitoring
- Use withFileTypes when listing directories
- Handle stat failures gracefully during listing

## Rollback Plan

If new handling causes issues:
1. Make ENOENT handling optional (feature flag)
2. Add try-catch at higher level
3. Fall back to previous behavior

## Success Metrics

- No crashes from missing files
- Proper race condition logging
- Cleanup completes even with concurrent deletions
- Clear statistics on cleanup results
