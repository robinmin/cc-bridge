import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { persistence } from "@/gateway/persistence";
import { broadcastMessage, resolveBroadcastTargets } from "@/gateway/services/broadcast";

describe("broadcast service", () => {
	type PersistenceMock = Pick<typeof persistence, "getAllSessions" | "getAllChatChannels" | "getWorkspace">;
	const persistenceMock = persistence as unknown as PersistenceMock;
	const originalGetAllSessions = persistenceMock.getAllSessions;
	const originalGetAllChatChannels = persistenceMock.getAllChatChannels;
	const originalGetWorkspace = persistenceMock.getWorkspace;

	beforeEach(() => {
		persistenceMock.getAllSessions = async () => [
			{ chat_id: "123", instance_name: "i1" },
			{ chat_id: "oc_abc", instance_name: "i2" },
			{ chat_id: "999", instance_name: "i3" },
		];
		persistenceMock.getAllChatChannels = async () => [
			{ chat_id: "123", channel: "telegram", last_updated: "2026-01-01T00:00:00.000Z" },
			{ chat_id: "999", channel: "unknown", last_updated: "2026-01-01T00:00:00.000Z" },
		];
		persistenceMock.getWorkspace = async (chatId: string | number) => `ws-${chatId}`;
	});

	afterEach(() => {
		persistenceMock.getAllSessions = originalGetAllSessions;
		persistenceMock.getAllChatChannels = originalGetAllChatChannels;
		persistenceMock.getWorkspace = originalGetWorkspace;
	});

	test("resolveBroadcastTargets infers and filters channels", async () => {
		const all = await resolveBroadcastTargets();
		expect(all).toHaveLength(3);
		expect(all.find((t) => t.chatId === "123")?.channel).toBe("telegram");
		expect(all.find((t) => t.chatId === "oc_abc")?.channel).toBe("feishu");
		// invalid stored channel falls back to inferred telegram
		expect(all.find((t) => t.chatId === "999")?.channel).toBe("telegram");
		expect(all[0].workspace).toContain("ws-");

		const filteredByChat = await resolveBroadcastTargets({ targetChatIds: ["123", "missing"] });
		expect(filteredByChat).toHaveLength(1);
		expect(filteredByChat[0].chatId).toBe("123");

		const filteredByChannel = await resolveBroadcastTargets({ channels: ["feishu"] });
		expect(filteredByChannel).toHaveLength(1);
		expect(filteredByChannel[0].chatId).toBe("oc_abc");
	});

	test("broadcastMessage sends, skips, and counts failures", async () => {
		const telegram = {
			sendMessage: async (chatId: string, _text: string) => {
				if (chatId === "999") throw new Error("telegram-send-fail");
			},
		};
		const feishu = {
			sendMessage: async (_chatId: string, _text: string) => {},
		};

		const withFeishu = await broadcastMessage(
			{ telegram: telegram as never, feishu: feishu as never },
			"hello",
		);
		expect(withFeishu).toEqual({ sent: 2, failed: 1, skipped: 0 });

		const withoutFeishu = await broadcastMessage({ telegram: telegram as never }, "hello");
		// feishu target skipped, telegram(123) sent, telegram(999) fails
		expect(withoutFeishu).toEqual({ sent: 1, failed: 1, skipped: 1 });
	});
});
