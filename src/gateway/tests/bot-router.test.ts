import { describe, expect, test } from "bun:test";
import { BotRouter } from "@/gateway/pipeline/bot-router";

describe("BotRouter", () => {
	const menuBot = { name: "MenuBot", handle: async () => false, getMenus: () => [] };
	const hostBot = { name: "HostBot", handle: async () => false, getMenus: () => [] };
	const agentBot = { name: "AgentBot", handle: async () => false, getMenus: () => [] };

	test("routes /ws_add to AgentBot when both MenuBot and AgentBot are present", () => {
		const router = new BotRouter([menuBot, hostBot, agentBot]);
		const target = router.route({
			channelId: "telegram",
			chatId: "123",
			text: "/ws_add my-workspace",
			user: { id: "u1" },
		});

		expect(target?.name).toBe("AgentBot");
	});

	test("routes /ws_switch to AgentBot", () => {
		const router = new BotRouter([menuBot, hostBot, agentBot]);
		const target = router.route({
			channelId: "telegram",
			chatId: "123",
			text: "/ws_switch my-workspace",
			user: { id: "u1" },
		});

		expect(target?.name).toBe("AgentBot");
	});
});
