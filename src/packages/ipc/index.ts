/**
 * IPC Package - Common interface and factory for different IPC communication methods
 *
 * Supported methods:
 * - "tcp": Fast TCP socket communication (requires agent running with AGENT_MODE=tcp)
 * - "unix": Unix domain socket communication (requires agent running with AGENT_MODE=server)
 * - "docker-exec": Docker exec stdio fallback (always available)
 * - "host": Agent running directly on host (no Docker) - fastest for development
 * - "remote": Agent running on remote machine - for distributed systems
 * - "auto": Automatically select best available method (prefers host > tcp > unix > docker-exec)
 *
 * @example
 * ```ts
 * import { IpcFactory } from "@/packages/ipc";
 *
 * // Create TCP client (container-based)
 * const tcpClient = IpcFactory.create("tcp", { instanceName: "cc-bridge" });
 *
 * // Create Host client (no Docker - for development)
 * const hostClient = IpcFactory.create("host", { port: 3001 });
 *
 * // Create auto-selecting client (smartest)
 * const autoClient = IpcFactory.create("auto", { instanceName: "cc-bridge" });
 *
 * // Create client with fallback chain
 * const fallbackClient = IpcFactory.createWithFallback(
 *   ["host", "tcp", "unix", "docker-exec"],
 *   { instanceName: "cc-bridge" }
 * );
 *
 * // Create from backend configuration
 * const backendClient = IpcFactory.createFromBackend({
 *   type: "host",
 *   port: 3001,
 *   host: "localhost"
 * });
 *
 * // Use the client
 * const response = await autoClient.sendRequest({
 *   id: "123",
 *   method: "POST",
 *   path: "/execute",
 *   body: { command: "echo", args: ["hello"] }
 * });
 * ```
 */

export type { AnyBackend, ContainerBackend, configToBackend, HostBackend, IpcBackend, RemoteBackend } from "./backends";
export { CircuitBreakerIpcClient } from "./circuit-breaker";
export { DockerExecIpcClient } from "./docker-exec-client";
// Export factory
export { IpcFactory } from "./factory";
export { HostIpcClient } from "./host-client";
export { RemoteIpcClient } from "./remote-client";
// Export StdioIpcAdapter (for agent-side use)
export { StdioIpcAdapter } from "./stdio-adapter";
// Export individual client implementations (for direct use if needed)
export { TcpIpcClient } from "./tcp-client";
// Re-export types
export type { CircuitState, IIpcClient, IpcClientConfig, IpcMethod, IpcRequest, IpcResponse } from "./types";
export { UnixSocketIpcClient } from "./unix-client";

// Legacy export for backward compatibility
// TODO: Remove this after updating all imports
import { IpcFactory as LegacyIpcFactory } from "./factory";
import type { IpcRequest, IpcResponse } from "./types";

/**
 * @deprecated Use IpcFactory.create() instead
 */
export class IpcClient {
	constructor(
		private containerId: string,
		private instanceName?: string,
	) {}

	async sendRequest(request: IpcRequest, timeout = 120000): Promise<IpcResponse> {
		// Use factory with auto method
		const client = LegacyIpcFactory.create("auto", {
			containerId: this.containerId,
			instanceName: this.instanceName,
		});
		return client.sendRequest(request, timeout);
	}

	/**
	 * @deprecated Use IpcFactory.create().resetCircuitBreaker() instead
	 */
	static resetCircuitBreaker() {
		// No-op for backward compatibility
	}

	/**
	 * @deprecated Use IpcFactory.create().getCircuitState() instead
	 */
	static getCircuitState() {
		return { failures: 0, lastFailureTime: 0, state: "closed" as const };
	}
}
