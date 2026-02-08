/**
 * Backend types for different IPC communication targets
 */

import type { IpcClientConfig } from "./types";

// Base backend configuration
export interface IpcBackend {
	type: "container" | "host" | "remote";
}

// Container backend - agent runs inside Docker container
export interface ContainerBackend extends IpcBackend {
	type: "container";
	containerId: string;
	instanceName?: string;
}

// Host backend - agent runs directly on host (no Docker)
export interface HostBackend extends IpcBackend {
	type: "host";
	socketPath?: string; // Path to Unix socket on host
	port?: number; // TCP port if agent listening on TCP
	host?: string; // Host address (default: localhost)
}

// Remote backend - agent runs on remote machine
export interface RemoteBackend extends IpcBackend {
	type: "remote";
	url: string; // HTTP/HTTPS URL of remote agent
	apiKey?: string; // Optional API key for authentication
}

// Union type for all backends
export type AnyBackend = ContainerBackend | HostBackend | RemoteBackend;

/**
 * Convert legacy IpcClientConfig to Backend
 */
export function configToBackend(config: IpcClientConfig): AnyBackend {
	// If containerId is provided, use container backend
	if (config.containerId) {
		return {
			type: "container",
			containerId: config.containerId,
			instanceName: config.instanceName,
		} as ContainerBackend;
	}

	// Check for host backend indicators
	const hostPort = process.env.AGENT_TCP_PORT || process.env.AGENT_PORT;
	const hostSocket = process.env.AGENT_SOCKET;
	const hostHost = process.env.AGENT_HOST || process.env.AGENT_TCP_HOST;

	if (hostPort || hostSocket) {
		return {
			type: "host",
			socketPath: hostSocket,
			port: hostPort ? Number.parseInt(hostPort, 10) : undefined,
			host: hostHost,
		} as HostBackend;
	}

	// Check for remote backend
	const remoteUrl = process.env.AGENT_REMOTE_URL;
	if (remoteUrl) {
		return {
			type: "remote",
			url: remoteUrl,
			apiKey: process.env.AGENT_REMOTE_API_KEY,
		} as RemoteBackend;
	}

	// Default to host backend for development
	return {
		type: "host",
		port: 3001,
		host: "localhost",
	} as HostBackend;
}
