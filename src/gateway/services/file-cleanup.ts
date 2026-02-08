import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { logger } from "@/packages/logger";

/**
 * Configuration for FileCleanupService
 */
export interface FileCleanupConfig {
	baseDir: string; // Base IPC directory
	ttlMs?: number; // Default: 3600000 (1 hour)
	cleanupIntervalMs?: number; // Default: 300000 (5 minutes)
	orphanGracePeriodMs?: number; // Default: 900000 (15 minutes)
	enabled?: boolean;
}

/**
 * Statistics from a cleanup run
 */
export interface CleanupStats {
	filesScanned: number;
	filesDeleted: number;
	filesSkipped: number;
	bytesFreed: number;
	orphansFound: number;
	errors: number;
	durationMs: number;
}

/**
 * Metadata about a response file
 */
export interface ResponseFileMetadata {
	requestId: string;
	workspace: string;
	filePath: string;
	ageMs: number;
	sizeBytes: number;
	isOrphan: boolean;
}

/**
 * Options for cleanup run
 */
export interface CleanupOptions {
	onStartup?: boolean;
	onShutdown?: boolean;
	periodic?: boolean;
	force?: boolean;
	workspace?: string;
	dryRun?: boolean;
}

/**
 * FileCleanupService - Manages cleanup of IPC response files
 *
 * Features:
 * - TTL-based cleanup (default 1 hour)
 * - Orphan file detection
 * - Automatic lifecycle cleanup (startup/shutdown)
 * - Request tracking (never delete active request files)
 * - Periodic cleanup every 5 minutes
 */
export class FileCleanupService extends EventEmitter {
	private readonly config: Required<FileCleanupConfig>;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private activeRequests: Set<string> = new Set();
	private isRunning: boolean = false;

	constructor(config: FileCleanupConfig) {
		super();

		this.config = {
			baseDir: config.baseDir,
			ttlMs: config.ttlMs ?? GATEWAY_CONSTANTS.FILESYSTEM_IPC.DEFAULT_FILE_TTL_MS,
			cleanupIntervalMs: config.cleanupIntervalMs ?? GATEWAY_CONSTANTS.FILESYSTEM_IPC.DEFAULT_CLEANUP_INTERVAL_MS,
			orphanGracePeriodMs: 15 * 60 * 1000, // 15 minutes
			enabled: config.enabled ?? true,
		};
	}

	/**
	 * Start periodic cleanup
	 */
	async start(): Promise<void> {
		if (!this.config.enabled) {
			logger.info("File cleanup disabled via configuration");
			return;
		}

		logger.info("Starting file cleanup service", {
			ttlMs: this.config.ttlMs,
			intervalMs: this.config.cleanupIntervalMs,
			baseDir: this.config.baseDir,
		});

		// Initial cleanup on startup (clear stale files from crashes)
		await this.runCleanup({ onStartup: true });

		// Schedule periodic cleanup
		this.cleanupTimer = setInterval(() => {
			this.runCleanup({ periodic: true }).catch((err) => {
				logger.error({ err }, "Periodic cleanup failed");
			});
		}, this.config.cleanupIntervalMs);

		logger.info("File cleanup service started", {
			nextCleanup: new Date(Date.now() + this.config.cleanupIntervalMs).toISOString(),
		});
	}

	/**
	 * Stop cleanup service
	 */
	async stop(): Promise<void> {
		logger.info("Stopping file cleanup service");

		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		// Final cleanup before shutdown
		await this.runCleanup({ onShutdown: true });

		logger.info("File cleanup service stopped");
	}

	/**
	 * Track an active request (prevents deletion)
	 */
	trackRequest(requestId: string): void {
		this.activeRequests.add(requestId);
		logger.debug({ requestId }, "Tracking active request");
	}

	/**
	 * Untrack a completed request
	 */
	untrackRequest(requestId: string): void {
		this.activeRequests.delete(requestId);
		logger.debug({ requestId }, "Untracking completed request");
	}

	/**
	 * Run cleanup operation
	 */
	async runCleanup(options: CleanupOptions = {}): Promise<CleanupStats> {
		if (this.isRunning && !options.force) {
			logger.warn("Cleanup already running, skipping");
			return this.emptyStats();
		}

		this.isRunning = true;
		const startTime = Date.now();

		const stats: CleanupStats = {
			filesScanned: 0,
			filesDeleted: 0,
			filesSkipped: 0,
			bytesFreed: 0,
			orphansFound: 0,
			errors: 0,
			durationMs: 0,
		};

		try {
			logger.info({ options }, "Running file cleanup");

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
							const deleted = await this.deleteFile(file.filePath);
							if (deleted) {
								stats.bytesFreed += file.sizeBytes;
							} else {
								stats.filesSkipped++;
							}
						}
						stats.filesDeleted++;

						logger.debug(
							{
								requestId: file.requestId,
								workspace: file.workspace,
								ageMs: file.ageMs,
								isOrphan: file.isOrphan,
								dryRun: options.dryRun,
							},
							"Deleted response file",
						);
					}
				} catch (err) {
					stats.errors++;
					logger.error({ err, file }, "Failed to delete file");
				}
			}

			stats.durationMs = Date.now() - startTime;

			logger.info(
				{
					filesScanned: stats.filesScanned,
					filesDeleted: stats.filesDeleted,
					filesSkipped: stats.filesSkipped,
					bytesFreed: stats.bytesFreed,
					orphansFound: stats.orphansFound,
					errors: stats.errors,
					durationMs: stats.durationMs,
					options,
				},
				"Cleanup completed",
			);

			this.emit("cleanup:complete", stats);

			return stats;
		} catch (err) {
			logger.error({ err, options }, "Cleanup failed");
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
	 * Get cleanup service status
	 */
	getStatus(): {
		isRunning: boolean;
		activeRequests: number;
		config: {
			ttlMs: number;
			cleanupIntervalMs: number;
			orphanGracePeriodMs: number;
			enabled: boolean;
		};
	} {
		return {
			isRunning: this.isRunning,
			activeRequests: this.activeRequests.size,
			config: {
				ttlMs: this.config.ttlMs,
				cleanupIntervalMs: this.config.cleanupIntervalMs,
				orphanGracePeriodMs: this.config.orphanGracePeriodMs,
				enabled: this.config.enabled,
			},
		};
	}

	/**
	 * Scan all response files
	 */
	private async scanResponseFiles(workspace?: string): Promise<ResponseFileMetadata[]> {
		const files: ResponseFileMetadata[] = [];
		const basePath = this.config.baseDir;

		try {
			// Check if base directory exists
			await fs.access(basePath);
		} catch {
			// Base directory doesn't exist yet
			return files;
		}

		const workspaces = workspace ? [workspace] : await fs.readdir(basePath);

		for (const ws of workspaces) {
			const responsesDir = path.join(basePath, ws, "responses");

			try {
				// Check if responses directory exists
				await fs.access(responsesDir);
			} catch {
				continue;
			}

			try {
				const responseFiles = await fs.readdir(responsesDir);

				for (const filename of responseFiles) {
					if (!filename.endsWith(".json")) continue;

					const filePath = path.join(responsesDir, filename);
					const requestId = filename.replace(".json", "");

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
						logger.warn({ err, filePath }, "Failed to stat file");
					}
				}
			} catch (err) {
				// Workspace directory may not have responses subdirectory
				logger.debug({ err, workspace: ws }, "Failed to read responses directory");
			}
		}

		return files;
	}

	/**
	 * Determine if file should be deleted
	 */
	private shouldDeleteFile(file: ResponseFileMetadata, _now: number, ttl: number, options: CleanupOptions): boolean {
		// Force delete mode
		if (options.force) return true;

		// Active request - never delete
		if (this.activeRequests.has(file.requestId)) {
			return false;
		}

		// Startup cleanup - delete files older than grace period (5 minutes)
		if (options.onStartup) {
			const graceMs = 5 * 60 * 1000; // 5 minutes
			return file.ageMs > graceMs;
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
	 * Delete file atomically with race condition handling
	 * @returns true if file was deleted, false if it was already gone (ENOENT)
	 */
	private async deleteFile(filePath: string): Promise<boolean> {
		try {
			await fs.unlink(filePath);
			return true;
		} catch (err) {
			const errno = err as NodeJS.ErrnoException;

			if (errno.code === "ENOENT") {
				// File already deleted by another process (race condition)
				logger.debug({ filePath }, "File already deleted by another process (race condition)");
				return false;
			}

			if (errno.code === "EACCES" || errno.code === "EPERM") {
				// Permission denied - this is a real error
				logger.warn({ filePath, error: errno }, "Permission denied when deleting file");
				throw new Error(`Permission denied: ${filePath}`);
			}

			// Other errors - rethrow
			logger.error({ filePath, error: errno }, "Unexpected error deleting file");
			throw err;
		}
	}

	/**
	 * Empty stats object
	 */
	private emptyStats(): CleanupStats {
		return {
			filesScanned: 0,
			filesDeleted: 0,
			filesSkipped: 0,
			bytesFreed: 0,
			orphansFound: 0,
			errors: 0,
			durationMs: 0,
		};
	}
}
