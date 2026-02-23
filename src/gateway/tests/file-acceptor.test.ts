import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { Channel } from "@/gateway/channels";
import type { FeishuChannel } from "@/gateway/channels/feishu";
import type { TelegramChannel } from "@/gateway/channels/telegram";
import type { Attachment, Message } from "@/gateway/pipeline";
import { acceptAttachments } from "@/gateway/services/file-acceptor";

const cfg = {
	enabled: true,
	allowedMimeTypes: ["text/plain", "image/png", "image/jpeg", "image/webp", "application/pdf"],
	maxTextBytes: 10_000,
	maxImageBytes: 10_000,
	retentionHours: 24,
	storageDir: "./tmp-uploads",
};

function makeMsg(att: Attachment[]): Message {
	return {
		channelId: "telegram",
		chatId: 123,
		text: "hello",
		attachments: att,
	};
}

describe("file-acceptor", () => {
	beforeEach(() => {
		spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
		spyOn(fs, "writeFile").mockResolvedValue(undefined as never);
	});

	test("returns early when disabled or empty", async () => {
		const msg = makeMsg([]);
		const disabled = await acceptAttachments(msg, { name: "telegram" } as unknown as Channel, {
			...cfg,
			enabled: false,
		});
		expect(disabled).toEqual({ attachments: [], textAppend: "" });

		const noAtt = await acceptAttachments(
			{ ...msg, attachments: undefined },
			{ name: "telegram" } as unknown as Channel,
			cfg,
		);
		expect(noAtt).toEqual({ attachments: [], textAppend: "" });
	});

	test("accepts telegram text attachment and appends content", async () => {
		const att: Attachment = {
			source: "telegram",
			fileId: "f1",
			fileName: "notes.txt",
			kind: "text",
			mimeType: "text/plain",
		};
		const telegram = {
			name: "telegram",
			getClient: () => ({
				getFile: async () => ({ file_path: "abc/file.txt" }),
				downloadFile: async () => new Response("hello file", { headers: { "content-type": "text/plain" } }),
			}),
		} as unknown as TelegramChannel;

		const result = await acceptAttachments(makeMsg([att]), telegram, cfg);
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0].download?.relativePath).toContain(path.join("tmp-uploads", "telegram"));
		expect(result.textAppend).toContain("[Attachment: notes.txt]");
		expect(result.textAppend).toContain("hello file");
	});

	test("accepts feishu image with mime detected from magic bytes", async () => {
		const att: Attachment = {
			source: "feishu",
			fileId: "img1",
			fileName: "img.bin",
			kind: "image",
			messageId: "mid-1",
			remoteType: "image",
		};
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
		const feishu = {
			name: "feishu",
			getClient: () => ({
				downloadResource: async () => new Response(png, { headers: { "content-type": "application/octet-stream" } }),
			}),
		} as unknown as FeishuChannel;

		const result = await acceptAttachments(
			{ ...makeMsg([att]), channelId: "feishu" },
			feishu,
			{ ...cfg, allowedMimeTypes: [...cfg.allowedMimeTypes, "application/octet-stream"] },
		);
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0].mimeType).toBe("image/png");
		expect(result.textAppend).toContain("saved to");
	});

	test("detects jpeg and webp image signatures", async () => {
		const jpegAtt: Attachment = {
			source: "feishu",
			fileId: "img-jpeg",
			fileName: "a.bin",
			kind: "image",
			messageId: "m1",
			remoteType: "image",
		};
		const webpAtt: Attachment = {
			source: "feishu",
			fileId: "img-webp",
			fileName: "b.bin",
			kind: "image",
			messageId: "m2",
			remoteType: "image",
		};
		const feishu = {
			name: "feishu",
			getClient: () => ({
				downloadResource: async (_mid: string, fid: string) => {
					if (fid === "img-jpeg") {
						return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
							headers: { "content-type": "application/octet-stream" },
						});
					}
					return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), {
						headers: { "content-type": "application/octet-stream" },
					});
				},
			}),
		} as unknown as FeishuChannel;

		const res = await acceptAttachments(
			{ ...makeMsg([jpegAtt, webpAtt]), channelId: "feishu" },
			feishu,
			{ ...cfg, allowedMimeTypes: [...cfg.allowedMimeTypes, "application/octet-stream"] },
		);
		expect(res.attachments).toHaveLength(2);
		expect(res.attachments.find((a) => a.fileId === "img-jpeg")?.mimeType).toBe("image/jpeg");
		expect(res.attachments.find((a) => a.fileId === "img-webp")?.mimeType).toBe("image/webp");
	});

	test("rejects invalid combinations and size/mime violations", async () => {
		const badSource: Attachment = {
			source: "feishu",
			fileId: "x1",
			fileName: "x.pdf",
			kind: "other",
		};
		const tooLarge: Attachment = {
			source: "telegram",
			fileId: "x2",
			fileName: "too-big.txt",
			kind: "text",
		};
		const disallowed: Attachment = {
			source: "telegram",
			fileId: "x3",
			fileName: "evil.bin",
			kind: "other",
		};
		const missingFeishuMeta: Attachment = {
			source: "feishu",
			fileId: "x4",
			fileName: "f.bin",
			kind: "image",
		};

		const telegram = {
			name: "telegram",
			getClient: () => ({
				getFile: async () => ({ file_path: "any" }),
				downloadFile: async () =>
					new Response("body", {
						headers: {
							"content-type": "application/octet-stream",
							"content-length": "999999",
						},
					}),
			}),
		} as unknown as TelegramChannel;

		const result = await acceptAttachments(makeMsg([badSource, tooLarge, disallowed]), telegram, {
			...cfg,
			maxTextBytes: 5,
			allowedMimeTypes: ["text/plain"],
		});
		expect(result.attachments).toHaveLength(0);

		const feishu = {
			name: "feishu",
			getClient: () => ({ downloadResource: async () => new Response("x") }),
		} as unknown as FeishuChannel;
		const missing = await acceptAttachments(
			{ ...makeMsg([missingFeishuMeta]), channelId: "feishu" },
			feishu,
			cfg,
		);
		expect(missing.attachments).toHaveLength(0);
	});

	test("handles telegram and feishu non-ok download responses", async () => {
		const tgAtt: Attachment = {
			source: "telegram",
			fileId: "x-tg",
			fileName: "x.txt",
			kind: "text",
		};
		const tg = {
			name: "telegram",
			getClient: () => ({
				getFile: async () => ({ file_path: "p" }),
				downloadFile: async () => new Response("bad tg", { status: 500 }),
			}),
		} as unknown as TelegramChannel;
		const tgRes = await acceptAttachments(makeMsg([tgAtt]), tg, cfg);
		expect(tgRes.attachments).toHaveLength(0);

		const fsAtt: Attachment = {
			source: "feishu",
			fileId: "x-fs",
			fileName: "x.txt",
			kind: "text",
			messageId: "m",
			remoteType: "file",
		};
		const feishu = {
			name: "feishu",
			getClient: () => ({
				downloadResource: async () => new Response("bad fs", { status: 500 }),
			}),
		} as unknown as FeishuChannel;
		const fsRes = await acceptAttachments({ ...makeMsg([fsAtt]), channelId: "feishu" }, feishu, cfg);
		expect(fsRes.attachments).toHaveLength(0);
	});

	test("maps octet-stream text to text/plain and rejects oversized body by bytes", async () => {
		const textAtt: Attachment = {
			source: "telegram",
			fileId: "txt-octet",
			fileName: "plain.txt",
			kind: "text",
		};
		const oversizedAtt: Attachment = {
			source: "telegram",
			fileId: "txt-big",
			fileName: "big.txt",
			kind: "text",
		};
		const tg = {
			name: "telegram",
			getClient: () => ({
				getFile: async (id: string) => ({ file_path: id }),
				downloadFile: async (filePath: string) =>
					filePath === "txt-octet"
						? new Response("hello", { headers: { "content-type": "application/octet-stream" } })
						: new Response("x".repeat(100), { headers: { "content-type": "text/plain" } }),
			}),
		} as unknown as TelegramChannel;

		const res = await acceptAttachments(makeMsg([textAtt, oversizedAtt]), tg, {
			...cfg,
			maxTextBytes: 20,
			allowedMimeTypes: ["text/plain"],
		});
		expect(res.attachments).toHaveLength(1);
		expect(res.attachments[0].mimeType).toBe("text/plain");
	});

	test("handles pdf as non-text and truncates long text attachment", async () => {
		const pdf: Attachment = {
			source: "telegram",
			fileId: "pdf",
			fileName: "doc.pdf",
			kind: "text",
			mimeType: "application/pdf",
		};
		const longTxt: Attachment = {
			source: "telegram",
			fileId: "txt",
			fileName: "long.txt",
			kind: "text",
			mimeType: "text/plain",
		};
		const telegram = {
			name: "telegram",
			getClient: () => ({
				getFile: async (id: string) => ({ file_path: id }),
				downloadFile: async (filePath: string) =>
					filePath === "pdf"
						? new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } })
						: new Response("a".repeat(21000), { headers: { "content-type": "text/plain" } }),
			}),
		} as unknown as TelegramChannel;

		const result = await acceptAttachments(makeMsg([pdf, longTxt]), telegram, {
			...cfg,
			maxTextBytes: 30_000,
			allowedMimeTypes: [...cfg.allowedMimeTypes, "application/octet-stream"],
		});
		expect(result.attachments).toHaveLength(2);
		expect(result.attachments.find((a) => a.fileId === "pdf")?.kind).toBe("other");
		expect(result.attachments.find((a) => a.fileId === "txt")?.kind).toBe("text");
		expect(result.textAppend).toContain("...[truncated]");
	});
});
