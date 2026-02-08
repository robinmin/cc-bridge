import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "@/packages/logger";
import type { ClaudeResponseFile } from "@/packages/types";

// Re-export for convenience
export type { ClaudeResponseFile };

/**
 * ResponseWriter - Writes Claude responses to filesystem atomically
 *
 * This class:
 * - Writes responses to temporary files first
 * - Atomically renames to final path
 * - Ensures no partial reads by Gateway
 */
export class ResponseWriter {
	private readonly baseDir: string;

	constructor(baseDir: string = "/ipc") {
		this.baseDir = baseDir;
	}

	/**
	 * Get the path to a response file
	 */
	private getResponsePath(workspace: string, requestId: string): string {
		return path.join(this.baseDir, workspace, "responses", `${requestId}.json`);
	}

	/**
	 * Write response to filesystem atomically
	 *
	 * Strategy:
	 * 1. Write to temporary file (.tmp extension)
	 * 2. Atomic rename to final path
	 *
	 * This ensures Gateway never reads partial files.
	 */
	async writeResponse(workspace: string, requestId: string, data: ClaudeResponseFile): Promise<void> {
		const responseDir = path.join(this.baseDir, workspace, "responses");
		const finalPath = this.getResponsePath(workspace, requestId);
		const tempPath = `${finalPath}.tmp`;

		logger.debug(
			{
				workspace,
				requestId,
				finalPath,
				outputLength: data.output.length,
			},
			"Writing response to filesystem",
		);

		try {
			// Ensure response directory exists
			await fs.mkdir(responseDir, { recursive: true });

			// Step 1: Write to temporary file
			const jsonContent = JSON.stringify(data, null, 2);
			await fs.writeFile(tempPath, jsonContent, "utf8");

			// Step 2: Atomic rename
			await fs.rename(tempPath, finalPath);

			logger.debug(
				{
					workspace,
					requestId,
					sizeBytes: jsonContent.length,
				},
				"Response written successfully",
			);
		} catch (error) {
			// Clean up temp file on error
			try {
				await fs.unlink(tempPath).catch(() => {
					// Ignore cleanup errors
				});
			} catch {
				// Ignore
			}

			logger.error(
				{
					workspace,
					requestId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to write response file",
			);

			throw new Error(`Failed to write response file: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Write a simple text response (convenience method)
	 */
	async writeTextResponse(
		workspace: string,
		requestId: string,
		chatId: string | number,
		output: string,
		exitCode: number = 0,
	): Promise<void> {
		const response: ClaudeResponseFile = {
			requestId,
			chatId,
			workspace,
			timestamp: new Date().toISOString(),
			output,
			exitCode,
		};

		await this.writeResponse(workspace, requestId, response);
	}

	/**
	 * Write an error response (convenience method)
	 */
	async writeErrorResponse(
		workspace: string,
		requestId: string,
		chatId: string | number,
		errorMessage: string,
	): Promise<void> {
		const response: ClaudeResponseFile = {
			requestId,
			chatId,
			workspace,
			timestamp: new Date().toISOString(),
			output: "",
			exitCode: 1,
			error: errorMessage,
		};

		await this.writeResponse(workspace, requestId, response);
	}
}
