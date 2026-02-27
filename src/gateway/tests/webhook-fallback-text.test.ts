import { describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import * as fileAcceptor from "@/gateway/services/file-acceptor";
import type { TelegramChannel } from "@/gateway/channels/telegram";
import type { Message } from "@/gateway/pipeline";
import type { Bot } from "@/gateway/pipeline";

describe("webhook fallback text", () => {
	test("sets fallback text when accepted attachments produce empty text append", async () => {
		const acceptSpy = spyOn(fileAcceptor, "acceptAttachments").mockResolvedValue({
			attachments: [],
			textAppend: "",
		});
		const { handleWebhook } = await import("@/gateway/routes/webhook");

		const parseWebhook = mock(
			() =>
				({
					channelId: "telegram",
					chatId: `chat-${Date.now()}`,
					text: "",
					updateId: `update-${Date.now()}-${Math.random()}`,
					user: { id: "user-1" },
					attachments: [
						{
							kind: "text",
							source: "telegram",
							fileId: "f-1",
							fileName: "note.bin",
							mimeType: "application/octet-stream",
						},
					],
				}) as Message,
		);

		const attachmentClient = {
			getFile: mock(async () => ({ file_path: "doc.bin" })),
			downloadFile: mock(
				async () =>
					new Response("binary", {
						status: 200,
						headers: { "content-type": "application/octet-stream" },
					}),
			),
		};

		const telegram = {
			name: "telegram",
			parseWebhook,
			sendMessage: mock(async () => {}),
			showTyping: mock(async () => {}),
			getClient: () => attachmentClient,
		} as unknown as TelegramChannel;

		let handledText = "";
		const bot: Bot = {
			name: "AgentBot",
			handle: mock(async (message: Message) => {
				handledText = message.text;
				return true;
			}),
			getMenus: () => [],
		};

		const app = new Hono();
		app.post("/webhook", (c) =>
			handleWebhook(c, {
				telegram,
				bots: [bot],
				config: {
					uploads: {
						enabled: true,
						allowedMimeTypes: ["text/plain"],
						maxTextBytes: 1024,
						maxImageBytes: 1024,
						retentionHours: 1,
						storageDir: "data/uploads",
					},
				},
			}),
		);

		const response = await app.request("/webhook", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ update_id: 1, message: { chat: { id: 1 } } }),
		});

		expect(response.status).toBe(200);
		expect(acceptSpy).toHaveBeenCalledTimes(1);
		expect(handledText).toBe("[User sent attachments]");
		acceptSpy.mockRestore();
	});
});
