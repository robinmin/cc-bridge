import { logger } from "@/packages/logger";
import { type AnyBackend, configToBackend } from "./backends";
import { CircuitBreakerIpcClient } from "./circuit-breaker";
import { DockerExecIpcClient } from "./docker-exec-client";
import { HostIpcClient } from "./host-client";
import { RemoteIpcClient } from "./remote-client";
import { TcpIpcClient } from "./tcp-client";
import type { IIpcClient, IpcClientConfig, IpcMethod } from "./types";
import { UnixSocketIpcClient } from "./unix-client";

/**
 * IPC Factory - creates IPC clients based on method type or backend
 * Note: Using a class with static methods as a namespace pattern for better organization
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Factory pattern using static methods as namespace
export class IpcFactory {
	/**
	 * Create an IPC client based on the specified method
	 * @param method - The IPC method to use ("tcp", "unix", "docker-exec", "host", "remote", or "auto")
	 * @param config - Configuration for the IPC client
	 * @returns An IPC client instance wrapped with circuit breaker
	 */
	static create(method: IpcMethod | "host" | "remote", config: IpcClientConfig = {}): IIpcClient {
		let client: IIpcClient;

		switch (method) {
			case "tcp":
				client = new TcpIpcClient(config);
				logger.info("Created TCP IPC client");
				break;

			case "unix":
				client = new UnixSocketIpcClient(config);
				logger.info("Created Unix socket IPC client");
				break;

			case "docker-exec":
				client = new DockerExecIpcClient(config);
				logger.info("Created Docker exec IPC client");
				break;

			case "host": {
				// Host backend - agent runs on host (no Docker)
				const backend = configToBackend(config);
				if (backend.type !== "host") {
					throw new Error("Host method requires host-compatible configuration");
				}
				client = new HostIpcClient(backend);
				logger.info("Created Host IPC client (no Docker)");
				break;
			}

			case "remote": {
				// Remote backend - agent on remote machine
				const remoteBackend = configToBackend(config);
				if (remoteBackend.type !== "remote") {
					throw new Error("Remote method requires remote-compatible configuration");
				}
				client = new RemoteIpcClient(remoteBackend);
				logger.info("Created Remote IPC client");
				break;
			}

			case "auto":
				client = IpcFactory.createAuto(config);
				break;

			default:
				logger.warn({ method }, `Unknown IPC method "${method}", falling back to docker-exec`);
				client = new DockerExecIpcClient(config);
		}

		// Wrap with circuit breaker for resilience
		return new CircuitBreakerIpcClient(client);
	}

	/**
	 * Create IPC client from backend configuration
	 * @param backend - The backend configuration
	 * @returns An IPC client instance
	 */
	static createFromBackend(backend: AnyBackend): IIpcClient {
		let client: IIpcClient;

		switch (backend.type) {
			case "container":
				// Container backend - use TCP, Unix, or Docker exec
				if (process.env.AGENT_MODE === "tcp" || process.env.AGENT_TCP_PORT) {
					client = new TcpIpcClient({ instanceName: backend.instanceName });
				} else if (process.env.AGENT_SOCKET) {
					client = new UnixSocketIpcClient({ instanceName: backend.instanceName });
				} else {
					client = new DockerExecIpcClient({ containerId: backend.containerId });
				}
				break;

			case "host":
				client = new HostIpcClient(backend);
				break;

			case "remote":
				client = new RemoteIpcClient(backend);
				break;
		}

		return new CircuitBreakerIpcClient(client);
	}

	/**
	 * Create an IPC client that automatically selects the best available method
	 * Tries in order: Host TCP > Host Unix > Container TCP > Container Unix > Docker exec
	 */
	private static createAuto(config: IpcClientConfig = {}): IIpcClient {
		// First, check if we should use host backend (no Docker)
		const backend = configToBackend(config);

		if (backend.type === "host") {
			logger.info("Auto-selected Host backend (no Docker)");
			return new HostIpcClient(backend);
		}

		if (backend.type === "remote") {
			logger.info("Auto-selected Remote backend");
			return new RemoteIpcClient(backend);
		}

		// Container backend - try different IPC methods
		// Try TCP first (fastest)
		const tcpClient = new TcpIpcClient(config);
		if (tcpClient.isAvailable()) {
			logger.info("Auto-selected TCP IPC client");
			return tcpClient;
		}

		// Try Unix socket second
		const unixClient = new UnixSocketIpcClient(config);
		if (unixClient.isAvailable()) {
			logger.info("Auto-selected Unix socket IPC client");
			return unixClient;
		}

		// Fall back to docker exec
		logger.info("Auto-selected Docker exec IPC client (fallback)");
		return new DockerExecIpcClient(config);
	}

	/**
	 * Create a fallback chain of IPC clients
	 * If the primary client fails, tries the next in the chain
	 */
	static createWithFallback(methods: Array<IpcMethod | "host" | "remote">, config: IpcClientConfig = {}): IIpcClient {
		const clients = methods.map((m) => IpcFactory.create(m, config));

		return {
			async sendRequest(request: IpcRequest, timeout?: number): Promise<IpcResponse> {
				for (const client of clients) {
					if (!client.isAvailable()) continue;

					try {
						logger.debug({ method: client.getMethod() }, "Trying IPC client");
						return await client.sendRequest(request, timeout);
					} catch (error) {
						logger.warn(
							{ method: client.getMethod(), error: error instanceof Error ? error.message : String(error) },
							"IPC client failed, trying next",
						);
					}
				}

				// All clients failed
				return {
					id: request.id,
					status: 503,
					error: { message: "All IPC methods failed" },
				};
			},

			isAvailable(): boolean {
				return clients.some((c) => c.isAvailable());
			},

			getMethod(): string {
				return "fallback";
			},
		};
	}
}

// Re-export types
export type { AnyBackend, ContainerBackend, configToBackend, HostBackend, IpcBackend, RemoteBackend } from "./backends";
