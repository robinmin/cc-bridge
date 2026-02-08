/**
 * Request State Schema for tracking Claude execution requests
 */

/**
 * Possible states for a request throughout its lifecycle
 */
export type RequestStateValue = "created" | "queued" | "processing" | "completed" | "failed" | "timeout";

/**
 * Complete request state information
 */
export interface RequestState {
	/** Unique request identifier (UUID) */
	requestId: string;
	/** Telegram chat ID */
	chatId: string | number;
	/** Workspace name */
	workspace: string;

	/** Current state */
	state: RequestStateValue;
	/** Previous state (for transition tracking) */
	previousState?: RequestStateValue;

	/** When request was created */
	createdAt: number;
	/** When request was queued */
	queuedAt?: number;
	/** When processing started */
	processingStartedAt?: number;
	/** When request completed (success or failure) */
	completedAt?: number;
	/** Last state update timestamp */
	lastUpdatedAt: number;

	/** Original prompt */
	prompt?: string;
	/** Claude model used */
	model?: string;
	/** Tokens consumed */
	tokens?: number;
	/** Process exit code */
	exitCode?: number;
	/** Command output */
	output?: string;
	/** Error output (if any) */
	error?: string;

	/** Callback metadata */
	callback?: {
		/** Whether callback succeeded */
		success: boolean;
		/** Number of callback attempts */
		attempts: number;
		/** Timestamps of each retry attempt */
		retryTimestamps: string[];
		/** Error message (if callback failed) */
		error?: string;
	};

	/** When request should timeout */
	timeoutAt?: number;
	/** Whether request timed out */
	timedOut: boolean;
}

/**
 * State transition record
 */
export interface StateTransition {
	from: RequestStateValue;
	to: RequestStateValue;
	timestamp: number;
}

/**
 * Query options for listing requests
 */
export interface RequestQueryOptions {
	state?: RequestStateValue;
	limit?: number;
	workspace?: string;
	chatId?: string | number;
}

/**
 * Request tracker configuration
 */
export interface RequestTrackerConfig {
	stateBaseDir: string;
	enableCache?: boolean;
	cacheTtlMs?: number;
}
