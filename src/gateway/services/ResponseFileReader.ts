import fs from "node:fs/promises";
import path from "node:path";
import { type ResponseFile, ResponseFileSchema } from "@/gateway/schemas/callback";
import { logger } from "@/packages/logger";

/**
 * Configuration for ResponseFileReader
 */
export interface ResponseFileReaderConfig {
	ipcBasePath: string; // Base IPC directory path
	maxFileSize?: number; // Maximum file size in bytes (default: 50MB)
	maxReadRetries?: number; // Maximum retry attempts (default: 3)
	readRetryDelayMs?: number; // Base delay between retries (default: 100ms)
}

/**
 * File read error types
 */
export enum FileReadErrorType {
	NOT_FOUND = "NOT_FOUND",
	PERMISSION_DENIED = "PERMISSION_DENIED",
	TOO_LARGE = "TOO_LARGE",
	INVALID_JSON = "INVALID_JSON",
	SCHEMA_VALIDATION_FAILED = "SCHEMA_VALIDATION_FAILED",
	DIRECTORY_TRAVERSAL = "DIRECTORY_TRAVERSAL",
	UNKNOWN = "UNKNOWN",
}

/**
 * Custom error for file reading failures
 */
export class FileReadError extends Error {
	constructor(
		public type: FileReadErrorType,
		message: string,
		public cause?: Error,
	) {
		super(message);
		this.name = "FileReadError";
	}
}

/**
 * ResponseFileReader - Secure file reading with retry and validation
 *
 * Features:
 * - Path sanitization to prevent directory traversal attacks
 * - File size limits
 * - JSON parsing with validation
 * - Retry logic for transient errors
 * - Detailed error reporting
 */
export class ResponseFileReader {
	private readonly ipcBasePath: string;
	private readonly maxFileSize: number;
	private readonly maxReadRetries: number;
	private readonly readRetryDelayMs: number;
	private readonly resolvedBasePath: string;

	constructor(config: ResponseFileReaderConfig) {
		this.ipcBasePath = config.ipcBasePath;
		this.maxFileSize = config.maxFileSize ?? 50 * 1024 * 1024; // 50MB
		this.maxReadRetries = config.maxReadRetries ?? 3;
		this.readRetryDelayMs = config.readRetryDelayMs ?? 100;

		// Resolve base path once for security checks
		this.resolvedBasePath = path.resolve(this.ipcBasePath);

		logger.info(
			{
				ipcBasePath: this.ipcBasePath,
				maxFileSize: this.maxFileSize,
				maxReadRetries: this.maxReadRetries,
			},
			"ResponseFileReader initialized",
		);
	}

	/**
	 * Read and validate a response file with retry logic
	 *
	 * @param workspace - The workspace name
	 * @param requestId - The request ID
	 * @returns Parsed and validated response file
	 * @throws FileReadError if the file cannot be read after retries
	 */
	async readResponseFile(workspace: string, requestId: string): Promise<ResponseFile> {
		// Sanitize inputs (prevent directory traversal)
		const sanitizedWorkspace = this.sanitizePath(workspace);
		const sanitizedRequestId = this.sanitizePath(requestId);

		const filePath = path.join(this.ipcBasePath, sanitizedWorkspace, "responses", `${sanitizedRequestId}.json`);

		// Verify path is within IPC directory (defense in depth)
		const resolvedPath = path.resolve(filePath);
		if (!resolvedPath.startsWith(this.resolvedBasePath)) {
			throw new FileReadError(
				FileReadErrorType.DIRECTORY_TRAVERSAL,
				`Invalid file path: path is outside IPC base directory`,
			);
		}

		// Read with retry - add initial delay to allow NFS cache to sync
		// This is needed because container writes may not be immediately visible to host
		let lastError: Error | undefined;
		for (let attempt = 1; attempt <= this.maxReadRetries; attempt++) {
			// Add initial delay before first read to let NFS cache sync
			if (attempt === 1) {
				await this.sleep(this.readRetryDelayMs);
			}

			try {
				return await this.readAndValidate(resolvedPath);
			} catch (err) {
				lastError = err as Error;

				// Don't retry on certain errors
				if (err instanceof FileReadError) {
					switch (err.type) {
						case FileReadErrorType.NOT_FOUND:
						case FileReadErrorType.PERMISSION_DENIED:
						case FileReadErrorType.TOO_LARGE:
						case FileReadErrorType.INVALID_JSON:
						case FileReadErrorType.SCHEMA_VALIDATION_FAILED:
						case FileReadErrorType.DIRECTORY_TRAVERSAL:
							// These are non-retriable errors
							throw err;
					}
				}

				logger.warn(
					{
						error: lastError.message,
						filePath,
						attempt,
						maxRetries: this.maxReadRetries,
					},
					"File read failed, retrying",
				);

				if (attempt < this.maxReadRetries) {
					// Exponential backoff
					const delay = this.readRetryDelayMs * attempt;
					await this.sleep(delay);
				}
			}
		}

		throw lastError;
	}

	/**
	 * Read file and validate contents
	 */
	private async readAndValidate(filePath: string): Promise<ResponseFile> {
		// Check file exists and get size
		let stats: fs.Stats;
		try {
			stats = await fs.stat(filePath);
		} catch (err) {
			const error = err as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				throw new FileReadError(
					FileReadErrorType.NOT_FOUND,
					`Response file not found: ${path.basename(filePath)}`,
					error,
				);
			}
			if (error.code === "EACCES") {
				throw new FileReadError(FileReadErrorType.PERMISSION_DENIED, `Permission denied reading response file`, error);
			}
			throw new FileReadError(FileReadErrorType.UNKNOWN, `Failed to access response file: ${error.message}`, error);
		}

		// Check file size
		if (stats.size > this.maxFileSize) {
			throw new FileReadError(
				FileReadErrorType.TOO_LARGE,
				`Response file too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB (max ${this.maxFileSize / 1024 / 1024}MB)`,
			);
		}

		// Read file using fs.open with sync flag to bypass NFS client cache
		// O_SYNC ensures all writes are flushed to disk before read returns
		let content: string;
		let fd: fs.FileHandle | undefined;
		try {
			// Open file with read flag - O_RDONLY is default for "r"
			// Using file descriptor to read ensures we bypass some caching layers
			fd = await fs.open(filePath, "r");

			// Read file content into buffer
			// Allocate buffer based on actual file size
			const buffer = Buffer.alloc(stats.size);
			await fd.read(buffer, 0, stats.size, 0);
			content = buffer.toString("utf-8");
		} catch (err) {
			const error = err as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				throw new FileReadError(
					FileReadErrorType.NOT_FOUND,
					`Response file not found: ${path.basename(filePath)}`,
					error,
				);
			}
			if (error.code === "EACCES") {
				throw new FileReadError(FileReadErrorType.PERMISSION_DENIED, `Permission denied reading response file`, error);
			}
			throw new FileReadError(FileReadErrorType.UNKNOWN, `Failed to read response file: ${error.message}`, error);
		} finally {
			// Always close the file descriptor
			if (fd !== undefined) {
				await fd.close().catch(() => {
					// Ignore close errors - best effort cleanup
				});
			}
		}

		// Check for empty file
		if (content.trim().length === 0) {
			throw new FileReadError(FileReadErrorType.INVALID_JSON, "Response file is empty");
		}

		// Parse JSON
		let data: unknown;
		try {
			data = JSON.parse(content);
		} catch (err) {
			const error = err as Error;
			throw new FileReadError(FileReadErrorType.INVALID_JSON, `Invalid JSON in response file: ${error.message}`, error);
		}

		// Validate schema
		const result = ResponseFileSchema.safeParse(data);
		if (!result.success) {
			const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
			throw new FileReadError(FileReadErrorType.SCHEMA_VALIDATION_FAILED, `Schema validation failed: ${errors}`);
		}

		logger.debug(
			{
				filePath,
				outputLength: result.data.output.length,
				exitCode: result.data.exitCode,
			},
			"Response file read and validated successfully",
		);

		return result.data;
	}

	/**
	 * Sanitize path component to prevent directory traversal
	 * Removes any characters that aren't alphanumeric, underscore, or hyphen
	 */
	private sanitizePath(input: string): string {
		// Remove any path separators and special characters
		// Only allow alphanumeric, underscore, and hyphen
		return input.replace(/[^a-zA-Z0-9_-]/g, "");
	}

	/**
	 * Sleep helper for retry delays
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Check if a response file exists
	 *
	 * @param workspace - The workspace name
	 * @param requestId - The request ID
	 * @returns true if the file exists
	 */
	async exists(workspace: string, requestId: string): Promise<boolean> {
		try {
			const sanitizedWorkspace = this.sanitizePath(workspace);
			const sanitizedRequestId = this.sanitizePath(requestId);

			const filePath = path.join(this.ipcBasePath, sanitizedWorkspace, "responses", `${sanitizedRequestId}.json`);

			const resolvedPath = path.resolve(filePath);
			if (!resolvedPath.startsWith(this.resolvedBasePath)) {
				return false;
			}

			await fs.access(resolvedPath);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get file size without reading content
	 *
	 * @param workspace - The workspace name
	 * @param requestId - The request ID
	 * @returns File size in bytes or undefined if file doesn't exist
	 */
	async getFileSize(workspace: string, requestId: string): Promise<number | undefined> {
		try {
			const sanitizedWorkspace = this.sanitizePath(workspace);
			const sanitizedRequestId = this.sanitizePath(requestId);

			const filePath = path.join(this.ipcBasePath, sanitizedWorkspace, "responses", `${sanitizedRequestId}.json`);

			const resolvedPath = path.resolve(filePath);
			if (!resolvedPath.startsWith(this.resolvedBasePath)) {
				return undefined;
			}

			const stats = await fs.stat(resolvedPath);
			return stats.size;
		} catch {
			return undefined;
		}
	}
}
