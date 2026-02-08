/**
 * Callback metadata from Stop Hook
 */
export interface CallbackMetadata {
	success: boolean;
	attempts: number;
	error?: string;
	retryTimestamps: string[];
}

/**
 * Standard Claude response file format
 *
 * This interface defines the structure of Claude response files
 * written to the filesystem for IPC between Agent and Gateway.
 */
export interface ClaudeResponseFile {
	/** Unique request identifier */
	requestId: string;

	/** Chat ID for this request */
	chatId: string | number;

	/** Workspace name */
	workspace: string;

	/** ISO 8601 timestamp of response generation */
	timestamp: string;

	/** Claude's stdout/stderr combined */
	output: string;

	/** Process exit code */
	exitCode: number;

	/** Optional error message */
	error?: string;

	/** Additional execution metadata */
	metadata?: {
		/** Execution time in ms */
		duration?: number;
		/** Claude model used */
		model?: string;
		/** Token count if available */
		tokens?: number;
	};

	/** Optional callback status from Stop Hook */
	callback?: CallbackMetadata;
}
