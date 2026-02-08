---
wbs: "0112"
title: "Phase 1.3: Filesystem IPC Structure + Response Handler"
status: "pending"
priority: "critical"
complexity: "medium"
estimated_hours: 6
phase: "phase-1-core-persistent-sessions"
dependencies: ["0110"]
created: 2026-02-07
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

# Phase 1.3: Filesystem IPC Structure + Response Handler

## Description

Implement filesystem-based IPC for Claude outputs. The Agent writes responses to `/ipc/{workspace}/responses/{requestId}.json`, and the Gateway reads these files after receiving Stop Hook callbacks.

## Requirements

### Functional Requirements

1. **Response File Format**
   - JSON structure with metadata
   - Includes request ID, timestamp, output, exit code
   - Support for large outputs (>10MB)
   - Graceful handling of incomplete writes

2. **File Lifecycle Management**
   - Write responses atomically (temp file + rename)
   - Read and delete after processing
   - Cleanup orphaned files (TTL-based)
   - Handle concurrent access safely

3. **Gateway Response Reader**
   - Read response file by request ID
   - Parse JSON and validate structure
   - Handle file not found (retry logic)
   - Delete file after successful read

### Non-Functional Requirements

- File writes must be atomic (no partial reads)
- Read operations should timeout after 30s
- Support up to 1000 pending responses
- Cleanup orphaned files older than 1 hour
- Thread-safe file operations

## Design

### Response File Format

**File**: `/ipc/{workspace}/responses/{requestId}.json`

```typescript
export interface ClaudeResponseFile {
  requestId: string;
  chatId: string | number;
  workspace: string;
  timestamp: string; // ISO 8601
  output: string;    // Claude's stdout/stderr combined
  exitCode: number;
  error?: string;    // Optional error message
  metadata?: {
    duration?: number; // Execution time in ms
    model?: string;    // Claude model used
    tokens?: number;   // Token count if available
  };
}
```

### FileSystemIPC Class

**File**: `src/gateway/services/filesystem-ipc.ts`

```typescript
export interface FileSystemIpcConfig {
  baseDir: string;           // /ipc/
  responseTimeout?: number;  // 30000ms default
  cleanupInterval?: number;  // 300000ms (5min) default
  fileTtl?: number;          // 3600000ms (1hr) default
}

export class FileSystemIpc {
  constructor(config: FileSystemIpcConfig);

  /**
   * Read a response file by request ID
   * Retries if file doesn't exist yet (with timeout)
   */
  async readResponse(
    workspace: string,
    requestId: string
  ): Promise<ClaudeResponseFile>;

  /**
   * Delete a response file after processing
   */
  async deleteResponse(
    workspace: string,
    requestId: string
  ): Promise<void>;

  /**
   * Cleanup orphaned files older than TTL
   */
  async cleanupOrphanedFiles(): Promise<number>;

  /**
   * Check if a response file exists
   */
  async responseExists(
    workspace: string,
    requestId: string
  ): Promise<boolean>;
}
```

### Write Strategy (Agent Side)

**File**: `src/agent/utils/response-writer.ts`

```typescript
export class ResponseWriter {
  /**
   * Write response to filesystem atomically
   */
  async writeResponse(
    workspace: string,
    requestId: string,
    data: ClaudeResponseFile
  ): Promise<void> {
    const responseDir = `/ipc/${workspace}/responses`;
    const finalPath = `${responseDir}/${requestId}.json`;
    const tempPath = `${finalPath}.tmp`;

    // 1. Write to temporary file
    await fs.promises.writeFile(
      tempPath,
      JSON.stringify(data, null, 2),
      'utf8'
    );

    // 2. Atomic rename
    await fs.promises.rename(tempPath, finalPath);

    logger.debug({ requestId, workspace }, 'Response written to filesystem');
  }
}
```

### Read Strategy (Gateway Side)

```typescript
async readResponse(workspace: string, requestId: string) {
  const filePath = path.join(
    this.config.baseDir,
    workspace,
    'responses',
    `${requestId}.json`
  );

  const startTime = Date.now();
  const timeout = this.config.responseTimeout || 30000;

  // Retry loop with timeout
  while (Date.now() - startTime < timeout) {
    try {
      // Check if file exists
      const exists = await fs.promises.access(filePath).then(() => true).catch(() => false);

      if (exists) {
        // Read file
        const content = await fs.promises.readFile(filePath, 'utf8');
        const response = JSON.parse(content) as ClaudeResponseFile;

        // Validate structure
        if (!response.requestId || !response.output) {
          throw new Error('Invalid response file structure');
        }

        return response;
      }

      // File doesn't exist yet, wait and retry
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      logger.warn({ requestId, workspace, error }, 'Error reading response file');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Response file not found after ${timeout}ms: ${requestId}`);
}
```

## Acceptance Criteria

- [ ] Response files are written atomically (no partial reads)
- [ ] FileSystemIpc can read responses successfully
- [ ] Reading non-existent file retries for up to 30s before failing
- [ ] Response files are deleted after successful read
- [ ] Orphaned files are cleaned up after TTL expires
- [ ] Large responses (>10MB) are handled correctly
- [ ] Concurrent reads of same file don't cause errors
- [ ] Invalid JSON files are handled gracefully
- [ ] File permissions allow both Gateway and Agent access
- [ ] Cleanup job runs periodically without performance impact

## File Changes

### New Files
1. `src/gateway/services/filesystem-ipc.ts` - Gateway response reader
2. `src/agent/utils/response-writer.ts` - Agent response writer
3. `src/gateway/tests/filesystem-ipc.test.ts` - Unit tests
4. `src/agent/tests/response-writer.test.ts` - Unit tests

### Modified Files
1. `src/gateway/consts.ts` - Add filesystem IPC constants

### Deleted Files
- None

## Test Scenarios

### Test 1: Write and Read Response
```typescript
// Agent side: Write response
const writer = new ResponseWriter();
await writer.writeResponse('cc-bridge', 'req-001', {
  requestId: 'req-001',
  chatId: '123',
  workspace: 'cc-bridge',
  timestamp: new Date().toISOString(),
  output: 'Hello from Claude!',
  exitCode: 0,
});

// Gateway side: Read response
const ipc = new FileSystemIpc({ baseDir: './data/ipc' });
const response = await ipc.readResponse('cc-bridge', 'req-001');

expect(response.requestId).toBe('req-001');
expect(response.output).toBe('Hello from Claude!');

// Cleanup
await ipc.deleteResponse('cc-bridge', 'req-001');
```

### Test 2: Retry Logic for Missing File
```typescript
const ipc = new FileSystemIpc({
  baseDir: './data/ipc',
  responseTimeout: 2000
});

// Start read (file doesn't exist yet)
const readPromise = ipc.readResponse('cc-bridge', 'req-002');

// Write file after 500ms
setTimeout(async () => {
  const writer = new ResponseWriter();
  await writer.writeResponse('cc-bridge', 'req-002', { /* data */ });
}, 500);

// Should successfully read after retry
const response = await readPromise;
expect(response.requestId).toBe('req-002');
```

### Test 3: Timeout on Missing File
```typescript
const ipc = new FileSystemIpc({
  baseDir: './data/ipc',
  responseTimeout: 1000
});

// File never gets written
await expect(
  ipc.readResponse('cc-bridge', 'req-nonexistent')
).rejects.toThrow('Response file not found after 1000ms');
```

### Test 4: Orphaned File Cleanup
```typescript
const ipc = new FileSystemIpc({
  baseDir: './data/ipc',
  fileTtl: 1000 // 1 second TTL
});

// Write old file
const writer = new ResponseWriter();
await writer.writeResponse('cc-bridge', 'req-old', { /* data */ });

// Wait for TTL expiration
await new Promise(resolve => setTimeout(resolve, 1500));

// Run cleanup
const cleaned = await ipc.cleanupOrphanedFiles();
expect(cleaned).toBe(1);

// Verify file is gone
expect(await ipc.responseExists('cc-bridge', 'req-old')).toBe(false);
```

### Test 5: Large Response Handling
```typescript
const largeOutput = 'x'.repeat(15 * 1024 * 1024); // 15MB

const writer = new ResponseWriter();
await writer.writeResponse('cc-bridge', 'req-large', {
  requestId: 'req-large',
  chatId: '123',
  workspace: 'cc-bridge',
  timestamp: new Date().toISOString(),
  output: largeOutput,
  exitCode: 0,
});

const ipc = new FileSystemIpc({ baseDir: './data/ipc' });
const response = await ipc.readResponse('cc-bridge', 'req-large');

expect(response.output.length).toBe(15 * 1024 * 1024);
```

### Test 6: Concurrent Reads
```typescript
const ipc = new FileSystemIpc({ baseDir: './data/ipc' });

// Write response
const writer = new ResponseWriter();
await writer.writeResponse('cc-bridge', 'req-concurrent', { /* data */ });

// Multiple concurrent reads
const reads = [
  ipc.readResponse('cc-bridge', 'req-concurrent'),
  ipc.readResponse('cc-bridge', 'req-concurrent'),
  ipc.readResponse('cc-bridge', 'req-concurrent'),
];

const responses = await Promise.all(reads);
expect(responses.length).toBe(3);
expect(responses[0].requestId).toBe('req-concurrent');
```

### Test 7: Invalid JSON Handling
```typescript
// Write invalid JSON manually
const filePath = path.join(
  './data/ipc/cc-bridge/responses',
  'req-invalid.json'
);
await fs.promises.writeFile(filePath, 'invalid json{', 'utf8');

const ipc = new FileSystemIpc({
  baseDir: './data/ipc',
  responseTimeout: 1000
});

// Should retry and eventually timeout
await expect(
  ipc.readResponse('cc-bridge', 'req-invalid')
).rejects.toThrow();
```

## Dependencies

- Task 0110 (Docker + tmux setup) must be complete
- Node.js fs.promises API
- Shared volume configuration from docker-compose.yml

## Implementation Notes

### Atomic Write Pattern

```bash
# Why atomic writes matter:
# 1. Write to temp file: /ipc/responses/req-001.json.tmp
# 2. Rename to final: /ipc/responses/req-001.json
# Rename is atomic on most filesystems (POSIX)
```

### Cleanup Strategy

```typescript
// Run cleanup every 5 minutes
setInterval(() => {
  fileSystemIpc.cleanupOrphanedFiles()
    .then(count => logger.debug({ count }, 'Cleaned up orphaned files'))
    .catch(err => logger.error({ err }, 'Cleanup failed'));
}, 300000);
```

### Error Recovery

```typescript
// If file is corrupt or incomplete:
// 1. Log error with request ID
// 2. Move file to /ipc/responses/failed/ for debugging
// 3. Return error to user
```

## Rollback Plan

If filesystem IPC fails:
1. Fall back to existing stdio IPC
2. Files are additive, don't break existing functionality
3. Can disable via: `USE_FILESYSTEM_IPC=false`

## Success Metrics

- File write completes in <50ms
- File read completes in <500ms (including retries)
- 100% atomic writes (no partial files)
- Cleanup removes >95% of orphaned files
- Zero data loss
- All test scenarios pass
