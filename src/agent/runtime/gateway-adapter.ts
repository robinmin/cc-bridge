import { RequestTracker } from "@/gateway/services/RequestTracker";
import { SessionPoolService } from "@/gateway/services/SessionPoolService";
import { TmuxManager } from "@/gateway/services/tmux-manager";
import type { RequestTrackerContract, SessionPoolContract, TmuxManagerContract } from "@/packages/agent-runtime";

export function createGatewayBackedAgentRuntime(params: {
	containerId: string;
	stateBaseDir: string;
}): {
	tmuxManager: TmuxManagerContract;
	sessionPool: SessionPoolContract;
	requestTracker: RequestTrackerContract;
} {
	const tmuxManager = new TmuxManager();
	const sessionPool = new SessionPoolService(tmuxManager, {
		containerId: params.containerId,
	});
	const requestTracker = new RequestTracker({
		stateBaseDir: params.stateBaseDir,
	});

	return {
		tmuxManager: tmuxManager as unknown as TmuxManagerContract,
		sessionPool: sessionPool as unknown as SessionPoolContract,
		requestTracker: requestTracker as unknown as RequestTrackerContract,
	};
}
