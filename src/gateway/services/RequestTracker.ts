import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	RequestQueryOptions,
	RequestState,
	RequestStateValue,
	RequestTrackerConfig,
} from "@/gateway/schemas/request-state";
import { logger } from "@/packages/logger";

/**
 * RequestTracker - Tracks Claude execution requests through their lifecycle
 *
 * Features:
 * - State management (created → processing → completed/failed)
 * - Persistent state storage
 * - Crash recovery
 * - Automatic cleanup of old state
 * - Workspace-indexed queries
 */
export class RequestTracker {
	private stateDir: string;
	private workspaceDir: string;
	private cache: Map<string, RequestState> = new Map();
	private config: Required<RequestTrackerConfig>;
	private started = false;
	private static readonly REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
	private static readonly WORKSPACE_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

	constructor(config: RequestTrackerConfig) {
		this.config = {
			stateBaseDir: config.stateBaseDir,
			enableCache: config.enableCache ?? true,
			cacheTtlMs: config.cacheTtlMs ?? 60000, // 1 minute
		};

		this.stateDir = path.join(this.config.stateBaseDir, "requests");
		this.workspaceDir = path.join(this.stateDir, "by-workspace");

		logger.info({ stateDir: this.stateDir }, "RequestTracker created");
	}

	/**
	 * Initialize tracker - recover existing state
	 */
	async start(): Promise<void> {
		if (this.started) {
			logger.warn("RequestTracker already started");
			return;
		}

		logger.info("Starting RequestTracker");

		// Create directories
		await fs.mkdir(this.stateDir, { recursive: true });
		await fs.mkdir(this.workspaceDir, { recursive: true });

		// Recover existing state
		await this.recoverState();

		this.started = true;
		logger.info("RequestTracker started");
	}

	/**
	 * Stop tracker and cleanup
	 */
	async stop(): Promise<void> {
		if (!this.started) {
			return;
		}

		logger.info("Stopping RequestTracker");
		this.cache.clear();
		this.started = false;
	}

	/**
	 * Create new request
	 */
	async createRequest(
		request: Omit<RequestState, "state" | "createdAt" | "lastUpdatedAt" | "timedOut">,
	): Promise<RequestState> {
		this.assertValidRequestId(request.requestId);
		this.assertValidWorkspace(request.workspace);

		const state: RequestState = {
			...request,
			state: "created",
			createdAt: Date.now(),
			lastUpdatedAt: Date.now(),
			timedOut: false,
		};

		await this.writeState(state);
		if (this.config.enableCache) {
			this.cache.set(state.requestId, state);
		}

		logger.info({ requestId: state.requestId, workspace: state.workspace }, "Request created");

		return state;
	}

	/**
	 * Update request state
	 */
	async updateState(
		requestId: string,
		updates: Partial<Omit<RequestState, "requestId" | "chatId" | "workspace" | "createdAt">>,
	): Promise<RequestState | null> {
		const current = await this.getRequest(requestId);
		if (!current) {
			logger.warn({ requestId }, "Cannot update non-existent request");
			return null;
		}

		const updated: RequestState = {
			...current,
			...updates,
			lastUpdatedAt: Date.now(),
			previousState: current.state,
		};

		await this.writeState(updated);
		if (this.config.enableCache) {
			this.cache.set(requestId, updated);
		}

		logger.debug({ requestId, from: current.state, to: updated.state }, "State transition");

		return updated;
	}

	/**
	 * Get request state
	 */
	async getRequest(requestId: string): Promise<RequestState | null> {
		if (!this.isValidRequestId(requestId)) {
			logger.warn({ requestId }, "Invalid requestId for getRequest");
			return null;
		}

		// Check cache first
		if (this.config.enableCache) {
			const cached = this.cache.get(requestId);
			if (cached) {
				return cached;
			}
		}

		// Read from filesystem
		const statePath = this.getStateFilePath(requestId);
		try {
			const content = await fs.readFile(statePath, "utf-8");
			const state: RequestState = JSON.parse(content);

			if (this.config.enableCache) {
				this.cache.set(requestId, state);
			}

			return state;
		} catch (_err) {
			// File doesn't exist or is corrupted
			return null;
		}
	}

	/**
	 * List requests by workspace with optional filters
	 */
	async listRequests(workspace: string, options?: RequestQueryOptions): Promise<RequestState[]> {
		if (!this.isValidWorkspace(workspace)) {
			logger.warn({ workspace }, "Invalid workspace for listRequests");
			return [];
		}

		const wsDir = this.getWorkspaceDirPath(workspace);
		try {
			const files = await fs.readdir(wsDir);
			const requests: RequestState[] = [];

			for (const file of files) {
				if (!file.endsWith(".json")) continue;

				try {
					const content = await fs.readFile(path.join(wsDir, file), "utf-8");
					const state: RequestState = JSON.parse(content);

					// Apply filters
					if (options?.state && state.state !== options.state) {
						continue;
					}
					if (options?.chatId && state.chatId !== options.chatId) {
						continue;
					}

					requests.push(state);

					// Apply limit
					if (options?.limit && requests.length >= options.limit) {
						break;
					}
				} catch (err) {
					logger.warn({ file, error: err }, "Failed to read state file");
				}
			}

			// Sort by creation time (newest first)
			return requests.sort((a, b) => b.createdAt - a.createdAt);
		} catch {
			// Directory doesn't exist yet
			return [];
		}
	}

	/**
	 * Delete request state
	 */
	async deleteRequest(requestId: string): Promise<void> {
		if (!this.isValidRequestId(requestId)) {
			logger.warn({ requestId }, "Invalid requestId for deleteRequest");
			return;
		}

		// Get state to find workspace
		const state = await this.getRequest(requestId);
		if (!state) {
			return;
		}

		// Remove main file
		const mainPath = this.getStateFilePath(requestId);
		await fs.unlink(mainPath).catch(() => {});

		// Remove workspace-indexed file
		if (!this.isValidWorkspace(state.workspace)) {
			logger.warn({ requestId, workspace: state.workspace }, "Invalid workspace in stored state during delete");
			this.cache.delete(requestId);
			return;
		}
		const wsPath = this.getWorkspaceRequestFilePath(state.workspace, requestId);
		await fs.unlink(wsPath).catch(() => {});

		// Remove from cache
		this.cache.delete(requestId);

		logger.debug({ requestId }, "Request state deleted");
	}

	/**
	 * Write state to filesystem (atomic)
	 */
	private async writeState(state: RequestState): Promise<void> {
		this.assertValidRequestId(state.requestId);
		this.assertValidWorkspace(state.workspace);

		const json = JSON.stringify(state, null, 2);

		// Write to main location (atomic write with temp file)
		const mainPath = this.getStateFilePath(state.requestId);
		const tmpPath = `${mainPath}.tmp`;
		await fs.writeFile(tmpPath, json);
		await fs.rename(tmpPath, mainPath);

		// Write to workspace-indexed location
		const wsDir = this.getWorkspaceDirPath(state.workspace);
		await fs.mkdir(wsDir, { recursive: true });
		const wsPath = this.getWorkspaceRequestFilePath(state.workspace, state.requestId);
		const wsTmpPath = `${wsPath}.tmp`;
		await fs.writeFile(wsTmpPath, json);
		await fs.rename(wsTmpPath, wsPath);
	}

	private isValidRequestId(requestId: string): boolean {
		return RequestTracker.REQUEST_ID_PATTERN.test(requestId);
	}

	private assertValidRequestId(requestId: string): void {
		if (!this.isValidRequestId(requestId)) {
			throw new Error(`Invalid requestId: ${requestId}`);
		}
	}

	private isValidWorkspace(workspace: string): boolean {
		return RequestTracker.WORKSPACE_PATTERN.test(workspace);
	}

	private assertValidWorkspace(workspace: string): void {
		if (!this.isValidWorkspace(workspace)) {
			throw new Error(`Invalid workspace: ${workspace}`);
		}
	}

	private getStateFilePath(requestId: string): string {
		this.assertValidRequestId(requestId);
		return path.join(this.stateDir, `${requestId}.json`);
	}

	private getWorkspaceDirPath(workspace: string): string {
		this.assertValidWorkspace(workspace);
		return path.join(this.workspaceDir, workspace);
	}

	private getWorkspaceRequestFilePath(workspace: string, requestId: string): string {
		this.assertValidWorkspace(workspace);
		this.assertValidRequestId(requestId);
		return path.join(this.workspaceDir, workspace, `${requestId}.json`);
	}

	/**
	 * Recover state from filesystem on startup
	 */
	private async recoverState(): Promise<void> {
		const files = await fs.readdir(this.stateDir).catch(() => []);
		let recovered = 0;
		let cleaned = 0;

		const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours
		const hungThreshold = 60 * 60 * 1000; // 1 hour

		for (const file of files) {
			if (!file.endsWith(".json")) continue;

			try {
				const content = await fs.readFile(path.join(this.stateDir, file), "utf-8");
				const state: RequestState = JSON.parse(content);

				// Check for stale requests (>24 hours since last update)
				const age = Date.now() - state.lastUpdatedAt;
				if (age > staleThreshold) {
					await this.deleteRequest(state.requestId);
					cleaned++;
					continue;
				}

				// Check for hung requests (processing for >1 hour)
				if (
					state.state === "processing" &&
					state.processingStartedAt &&
					Date.now() - state.processingStartedAt > hungThreshold
				) {
					logger.warn({ requestId: state.requestId, processingTime: age }, "Found hung request, marking as timeout");

					const updated: RequestState = {
						...state,
						state: "timeout",
						timedOut: true,
						lastUpdatedAt: Date.now(),
						previousState: state.state,
					};

					await this.writeState(updated);
					// Update cache with new state (don't overwrite below)
					this.cache.set(state.requestId, updated);
					recovered++;
				} else {
					// No update needed, cache original state
					this.cache.set(state.requestId, state);
					recovered++;
				}
			} catch (err) {
				logger.warn({ file, error: err }, "Failed to recover state file");
			}
		}

		logger.info({ recovered, cleaned, total: recovered + cleaned }, "State recovery complete");
	}

	/**
	 * Get statistics
	 */
	getStats(): {
		totalCached: number;
		byState: Record<RequestStateValue, number>;
	} {
		const byState: Record<string, number> = {
			created: 0,
			queued: 0,
			processing: 0,
			completed: 0,
			failed: 0,
			timeout: 0,
		};

		for (const state of this.cache.values()) {
			byState[state.state]++;
		}

		return {
			totalCached: this.cache.size,
			byState,
		};
	}

	/**
	 * Check if tracker is started
	 */
	isRunning(): boolean {
		return this.started;
	}
}
