/**
 * Memory File Watcher
 *
 * Auto-re-indexes memory files when they change.
 * Uses Node.js fs.watch with debouncing to avoid rapid re-indexing during saves.
 */

import fsSync from "node:fs";
import path from "node:path";
import type { MemoryIndexer } from "./indexer";
import { logger } from "@/packages/logger";

/**
 * Memory file watcher options
 */
export interface MemoryFileWatcherOptions {
	/** Debounce delay in ms (default: 1000) */
	debounceMs?: number;
	/** Paths to watch (default: auto from indexer) */
	watchPaths?: string[];
}

/**
 * Memory File Watcher
 *
 * Watches .memory directories and triggers incremental re-index on changes.
 */
export class MemoryFileWatcher {
	private watchers: Map<string, fsSync.FSWatcher> = new Map();
	private indexer: MemoryIndexer;
	private debounceTimer: Timer | null = null;
	private pendingFiles: Set<string> = new Set();
	private debounceMs: number;
	private watchPaths: string[];

	constructor(indexer: MemoryIndexer, options: MemoryFileWatcherOptions = {}) {
		this.indexer = indexer;
		this.debounceMs = options.debounceMs ?? 1000;
		this.watchPaths = options.watchPaths ?? [];
	}

	/**
	 * Start watching memory files
	 */
	start(): void {
		if (this.watchers.size > 0) {
			logger.warn("MemoryFileWatcher already started");
			return;
		}

		// If no specific paths, use the memory paths from the indexer
		let pathsToWatch = this.watchPaths;
		if (pathsToWatch.length === 0) {
			const memPaths = this.indexer.getPaths();
			pathsToWatch = [
				memPaths.root,
				memPaths.daily,
				memPaths.bank,
			];
		}

		for (const dirPath of pathsToWatch) {
			this.watchDirectory(dirPath);
		}

		logger.info({ paths: pathsToWatch }, "MemoryFileWatcher started");
	}

	/**
	 * Watch a directory for changes
	 */
	private watchDirectory(dirPath: string): void {
		try {
			// Ensure directory exists
			fsSync.accessSync(dirPath);

			// Watch the directory
			const watcher = fsSync.watch(dirPath, { persistent: false }, (_eventType, filename) => {
				if (!filename) return;

				// Only process markdown files in .memory directory
				if (!filename.endsWith(".md") && !filename.endsWith(".md/")) return;

				const fullPath = path.join(dirPath, filename);
				this.pendingFiles.add(fullPath);
				this.scheduleReindex();
			});

			this.watchers.set(dirPath, watcher);
			logger.debug({ dirPath }, "Watching directory");
		} catch (error) {
			logger.debug({ error, dirPath }, "Cannot watch directory (may not exist yet)");
		}
	}

	/**
	 * Schedule a debounced re-index
	 */
	private scheduleReindex(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(async () => {
			await this.reindexPending();
		}, this.debounceMs);
	}

	/**
	 * Re-index all pending files
	 */
	private async reindexPending(): Promise<void> {
		if (this.pendingFiles.size === 0) return;

		const files = Array.from(this.pendingFiles);
		this.pendingFiles.clear();

		logger.info({ files: files.length }, "Re-indexing changed memory files");

		try {
			// For incremental updates, we'd ideally update each file individually
			// For now, trigger a full rebuild since the FTS indexer doesn't have
			// efficient single-file update yet
			const result = await this.indexer.rebuild();

			if (result.ok) {
				logger.info({ count: files.length }, "Memory reindex completed");
			} else {
				logger.warn({ error: result.reason }, "Memory reindex failed");
			}
		} catch (error) {
			logger.error({ error }, "Memory reindex error");
		}
	}

	/**
	 * Stop watching and cleanup
	 */
	stop(): void {
		// Clear pending timer
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		// Close all watchers
		for (const [_name, watcher] of this.watchers) {
			watcher.close();
		}
		this.watchers.clear();
		this.pendingFiles.clear();

		logger.info("MemoryFileWatcher stopped");
	}

	/**
	 * Check if watcher is running
	 */
	isRunning(): boolean {
		return this.watchers.size > 0;
	}
}

/**
 * Create a file watcher for a memory indexer
 */
export function createMemoryFileWatcher(indexer: MemoryIndexer, options?: MemoryFileWatcherOptions): MemoryFileWatcher {
	return new MemoryFileWatcher(indexer, options);
}
