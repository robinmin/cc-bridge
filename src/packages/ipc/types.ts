/**
 * Common types for IPC communication
 */

// IPC Request format
export interface IpcRequest {
	id: string;
	method: string;
	path: string;
	body?: unknown;
}

// IPC Response format
export interface IpcResponse {
	id: string;
	status: number;
	result?: unknown;
	error?: { message: string };
}

// IPC Client configuration
export interface IpcClientConfig {
	containerId?: string;
	instanceName?: string;
	timeout?: number;
}

// IPC Client interface - all IPC implementations must implement this
export interface IIpcClient {
	/**
	 * Send an IPC request and wait for response
	 * @param request - The IPC request to send
	 * @param timeout - Optional timeout in milliseconds
	 * @returns Promise resolving to the IPC response
	 */
	sendRequest(request: IpcRequest, timeout?: number): Promise<IpcResponse>;

	/**
	 * Check if this IPC method is available
	 * @returns true if the IPC method can be used
	 */
	isAvailable(): boolean;

	/**
	 * Get the name of this IPC method
	 */
	getMethod(): string;
}

// IPC Method types
export type IpcMethod = "tcp" | "unix" | "docker-exec" | "host" | "remote" | "auto";

// Circuit breaker state for fallback handling
export interface CircuitState {
	failures: number;
	lastFailureTime: number;
	state: "closed" | "open" | "half-open";
}
