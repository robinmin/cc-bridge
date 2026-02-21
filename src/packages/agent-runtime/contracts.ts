export interface SessionMetadataContract {
	workspace: string;
	sessionName: string;
	containerId: string;
	createdAt: number;
	lastActivityAt: number;
	activeRequests: number;
	totalRequests: number;
	status: "active" | "idle" | "terminating";
}

export interface SessionPoolContract {
	start(): Promise<void>;
	stop(): Promise<void>;
	getOrCreateSession(workspace: string): Promise<SessionMetadataContract>;
	getSession(workspace: string): SessionMetadataContract | undefined;
	deleteSession(workspace: string): Promise<void>;
	listSessions(): SessionMetadataContract[];
	getStats(): unknown;
	trackRequestStart(workspace: string): void;
	trackRequestComplete(workspace: string): void;
}

export interface RequestTrackerState {
	requestId: string;
	workspace: string;
	state: string;
	createdAt: number;
	completedAt?: number;
	error?: string;
}

export interface RequestTrackerContract {
	start(): Promise<void>;
	stop(): Promise<void>;
	createRequest(input: { requestId: string; chatId: string; workspace: string; prompt: string }): Promise<void>;
	updateState(
		requestId: string,
		updates: Partial<{
			state: string;
			queuedAt: number;
			processingStartedAt: number;
			completedAt: number;
			exitCode: number;
			output: string;
			error: string;
		}>,
	): Promise<void>;
	getRequest(requestId: string): Promise<RequestTrackerState | null>;
}

export interface TmuxManagerContract {
	start(): Promise<void>;
	stop(): Promise<void>;
	sendToSession(
		containerId: string,
		sessionName: string,
		command: string,
		context: { requestId: string; chatId: string; workspace: string },
		timeoutMs?: number,
	): Promise<void>;
	listAllSessions(containerId: string): Promise<string[]>;
}

