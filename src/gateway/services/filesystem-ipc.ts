import fs from "node:fs/promises";
import path from "node:path";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import { logger } from "@/packages/logger";
import type { CallbackMetadata, ClaudeResponseFile } from "@/packages/types";

// Re-export for convenience
export type { ClaudeResponseFile, CallbackMetadata };

/**
 * Regex for validating workspace names (alphanumeric, underscore, hyphen only)
 */
const WORKSPACE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate workspace name to prevent directory traversal attacks
 */
function validateWorkspaceName(workspace: string): void {
	if (!WORKSPACE_NAME_REGEX.test(workspace)) {
		throw new Error(
			`Invalid workspace name: ${workspace}. Only alphanumeric characters, underscores, and hyphens are allowed.`,
		);
	}
}

/**
 * Configuration for FileSystemIpc
 */
export interface FileSystemIpcConfig {
	baseDir: string; // Base IPC directory (e.g., "/ipc" or "./data/ipc")
	responseTimeout?: number; // Max wait time for response file (default: 30000ms)
	cleanupInterval?: number; // Cleanup job interval (default: 300000ms)
	fileTtl?: number; // Time before orphaned files are cleaned up (default: 3600000ms)
}

/**
 * FileSystemIpc - Handles filesystem-based IPC for Claude responses
 *
 * This class:
 * - Reads response files written by the Agent
 * - Implements retry logic with timeout for missing files
 * - Cleans up orphaned files
 * - Validates file structure
 */
export class FileSystemIpc {
	private readonly config: Required<FileSystemIpcConfig>;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private destroyed = false;

	constructor(config: FileSystemIpcConfig) {
		this.config = {
			baseDir: config.baseDir,
			responseTimeout: config.responseTimeout ?? GATEWAY_CONSTANTS.FILESYSTEM_IPC.DEFAULT_RESPONSE_TIMEOUT_MS,
			cleanupInterval: config.cleanupInterval ?? GATEWAY_CONSTANTS.FILESYSTEM_IPC.DEFAULT_CLEANUP_INTERVAL_MS,
			fileTtl: config.fileTtl ?? GATEWAY_CONSTANTS.FILESYSTEM_IPC.DEFAULT_FILE_TTL_MS,
		};

		// Start periodic cleanup
		this.startCleanup();
	}

	/**
	 * Get the path to a response file
	 */
	private getResponsePath(workspace: string, requestId: string): string {
		return path.join(
			this.config.baseDir,
			workspace,
			GATEWAY_CONSTANTS.FILESYSTEM_IPC.RESPONSE_DIR,
			`${requestId}.json`,
		);
	}

	/**
	 * Read a response file by request ID
	 * Retries if file doesn't exist yet (with timeout)
	 */
	async readResponse(workspace: string, requestId: string): Promise<ClaudeResponseFile> {
		// Validate workspace name to prevent directory traversal
		validateWorkspaceName(workspace);

		const filePath = this.getResponsePath(workspace, requestId);
		const startTime = Date.now();
		const timeout = this.config.responseTimeout;
		const retryDelay = GATEWAY_CONSTANTS.FILESYSTEM_IPC.RETRY_DELAY_MS;

		logger.debug(
			{
				workspace,
				requestId,
				filePath,
				timeout,
			},
			"Reading response file",
		);

		// Retry loop with timeout
		while (Date.now() - startTime < timeout) {
			try {
				// Check if file exists
				const exists = await fs
					.access(filePath)
					.then(() => true)
					.catch(() => false);

				if (exists) {
					// Read file
					const content = await fs.readFile(filePath, "utf8");
					const response = JSON.parse(content) as ClaudeResponseFile;

					// Validate structure - throw immediately on invalid structure
					if (!response.requestId || !response.output) {
						throw new Error("Invalid response file structure");
					}

					logger.debug(
						{
							workspace,
							requestId,
							outputLength: response.output.length,
							exitCode: response.exitCode,
						},
						"Response file read successfully",
					);

					return response;
				}

				// File doesn't exist yet, wait and retry
				logger.debug(
					{
						workspace,
						requestId,
						elapsed: Date.now() - startTime,
					},
					"Response file not ready, retrying...",
				);
				await new Promise((resolve) => setTimeout(resolve, retryDelay));
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);

				// For validation errors, throw immediately (no retry)
				if (errorMessage === "Invalid response file structure") {
					throw error;
				}

				// Check if it's a JSON parse error - file might be incomplete
				if (errorMessage.includes("JSON")) {
					logger.warn(
						{
							workspace,
							requestId,
							error: errorMessage,
						},
						"Invalid JSON in response file, retrying...",
					);
				} else {
					logger.warn(
						{
							workspace,
							requestId,
							error: errorMessage,
						},
						"Error reading response file, retrying...",
					);
				}
				await new Promise((resolve) => setTimeout(resolve, retryDelay));
			}
		}

		throw new Error(`Response file not found after ${timeout}ms: ${requestId}`);
	}

	/**
	 * Delete a response file after processing
	 */
	async deleteResponse(workspace: string, requestId: string): Promise<void> {
		// Validate workspace name to prevent directory traversal
		validateWorkspaceName(workspace);

		const filePath = this.getResponsePath(workspace, requestId);

		try {
			await fs.unlink(filePath);
			logger.debug(
				{
					workspace,
					requestId,
				},
				"Response file deleted",
			);
		} catch (error) {
			logger.warn(
				{
					workspace,
					requestId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to delete response file",
			);
		}
	}

	/**
	 * Check if a response file exists
	 */
	async responseExists(workspace: string, requestId: string): Promise<boolean> {
		// Validate workspace name to prevent directory traversal
		validateWorkspaceName(workspace);

		const filePath = this.getResponsePath(workspace, requestId);

		try {
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Cleanup orphaned files older than TTL
	 */
	async cleanupOrphanedFiles(): Promise<number> {
		if (this.destroyed) {
			return 0;
		}

		let cleanedCount = 0;
		const now = Date.now();
		const ttl = this.config.fileTtl;

		logger.debug(
			{
				ttl,
				ttlMinutes: ttl / 60000,
			},
			"Starting orphaned file cleanup",
		);

		try {
			// List all workspace directories in base IPC directory
			const baseEntries = await fs.readdir(this.config.baseDir, {
				withFileTypes: true,
			});

			for (const entry of baseEntries) {
				if (!entry.isDirectory()) continue;

				const workspacePath = path.join(this.config.baseDir, entry.name);
				const responsesPath = path.join(workspacePath, GATEWAY_CONSTANTS.FILESYSTEM_IPC.RESPONSE_DIR);

				// Skip if responses directory doesn't exist
				try {
					await fs.access(responsesPath);
				} catch {
					continue;
				}

				// Read all response files
				const responseFiles = await fs.readdir(responsesPath);

				for (const file of responseFiles) {
					if (!file.endsWith(".json")) continue;

					const filePath = path.join(responsesPath, file);

					try {
						const stats = await fs.stat(filePath);
						const age = now - stats.mtimeMs;

						// Delete if older than TTL
						if (age > ttl) {
							await fs.unlink(filePath);
							cleanedCount++;

							logger.debug(
								{
									file,
									workspace: entry.name,
									ageMinutes: Math.floor(age / 60000),
								},
								"Cleaned up orphaned response file",
							);
						}
					} catch (error) {
						logger.warn(
							{
								file,
								error: error instanceof Error ? error.message : String(error),
							},
							"Failed to cleanup file",
						);
					}
				}
			}

			logger.info(
				{
					cleanedCount,
				},
				"Orphaned file cleanup complete",
			);

			return cleanedCount;
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to cleanup orphaned files",
			);
			return cleanedCount;
		}
	}

	/**
	 * Start periodic cleanup job
	 */
	private startCleanup(): void {
		if (this.destroyed || this.cleanupTimer) {
			return; // Don't start if destroyed or already started
		}
		if (this.config.cleanupInterval <= 0) {
			logger.debug({ intervalMs: this.config.cleanupInterval }, "Skipping periodic file cleanup (interval <= 0)");
			return;
		}

		this.cleanupTimer = setInterval(() => {
			if (!this.destroyed) {
				this.cleanupOrphanedFiles().catch((error) => {
					logger.error(
						{
							error: error instanceof Error ? error.message : String(error),
						},
						"Periodic cleanup failed",
					);
				});
			}
		}, this.config.cleanupInterval);

		logger.info(
			{
				intervalMs: this.config.cleanupInterval,
				intervalMinutes: this.config.cleanupInterval / 60000,
			},
			"Started periodic file cleanup job",
		);
	}

	/**
	 * Stop periodic cleanup job
	 */
	stopCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
			logger.info("Stopped periodic file cleanup job");
		}
	}

	/**
	 * Destroy the service and cleanup resources
	 */
	destroy(): void {
		if (this.destroyed) {
			return;
		}

		logger.info("Destroying FileSystemIpc service");

		// Stop cleanup timer
		this.stopCleanup();

		// Mark as destroyed
		this.destroyed = true;

		logger.info("FileSystemIpc service destroyed");
	}

	/**
	 * Check if service is destroyed
	 */
	isDestroyed(): boolean {
		return this.destroyed;
	}

	/**
	 * Read response and delete file (convenience method)
	 */
	async readAndDeleteResponse(workspace: string, requestId: string): Promise<ClaudeResponseFile> {
		const response = await this.readResponse(workspace, requestId);
		await this.deleteResponse(workspace, requestId);
		return response;
	}
}
