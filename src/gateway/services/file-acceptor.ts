import fs from "node:fs/promises";
import path from "node:path";
import type { Channel } from "@/gateway/channels";
import type { FeishuChannel } from "@/gateway/channels/feishu";
import type { TelegramChannel } from "@/gateway/channels/telegram";
import type { Attachment, Message } from "@/gateway/pipeline";
import { logger } from "@/packages/logger";

type UploadsConfig = {
	enabled: boolean;
	allowedMimeTypes: string[];
	maxTextBytes: number;
	maxImageBytes: number;
	retentionHours: number;
	storageDir: string;
};

const isFeishuChannel = (channel: Channel): channel is FeishuChannel => channel.name === "feishu";
const isTelegramChannel = (channel: Channel): channel is TelegramChannel => channel.name === "telegram";

const safeName = (name: string): string => name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

const detectImageMime = (buf: Uint8Array): string | null => {
	// PNG
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
		return "image/png";
	}
	// JPEG
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
		return "image/jpeg";
	}
	// WEBP (RIFF....WEBP)
	if (
		buf.length >= 12 &&
		buf[0] === 0x52 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46 &&
		buf[3] === 0x46 &&
		buf[8] === 0x57 &&
		buf[9] === 0x45 &&
		buf[10] === 0x42 &&
		buf[11] === 0x50
	) {
		return "image/webp";
	}
	return null;
};

const normalizeMime = (mime?: string | null): string | null => {
	if (!mime) return null;
	return mime.split(";")[0]?.trim() || null;
};

const isAllowedMime = (mime: string | null, cfg: UploadsConfig): boolean => {
	if (!mime) return false;
	return cfg.allowedMimeTypes.includes(mime);
};

async function downloadToFile(
	resp: Response,
	dest: string,
	maxBytes: number,
): Promise<{ sizeBytes: number; mimeType: string | null; buffer: Uint8Array }> {
	const contentLength = Number(resp.headers.get("content-length") || "0");
	if (contentLength > 0 && contentLength > maxBytes) {
		throw new Error(`File exceeds max size (${contentLength} > ${maxBytes})`);
	}

	const buf = new Uint8Array(await resp.arrayBuffer());
	if (buf.length > maxBytes) {
		throw new Error(`File exceeds max size (${buf.length} > ${maxBytes})`);
	}

	await fs.writeFile(dest, buf);
	const mimeType = normalizeMime(resp.headers.get("content-type"));
	return { sizeBytes: buf.length, mimeType, buffer: buf };
}

async function downloadTelegram(
	channel: TelegramChannel,
	att: Attachment,
	dest: string,
	maxBytes: number,
): Promise<{ sizeBytes: number; mimeType: string | null; buffer: Uint8Array }> {
	const client = channel.getClient();
	const meta = await client.getFile(att.fileId);
	const resp = await client.downloadFile(meta.file_path);
	if (!resp.ok) {
		const error = await resp.text();
		throw new Error(`Telegram file download failed: ${error}`);
	}
	return downloadToFile(resp, dest, maxBytes);
}

async function downloadFeishu(
	channel: FeishuChannel,
	att: Attachment,
	dest: string,
	maxBytes: number,
): Promise<{ sizeBytes: number; mimeType: string | null; buffer: Uint8Array }> {
	if (!att.messageId || !att.remoteType) {
		throw new Error("Feishu attachment missing messageId or remoteType");
	}
	const client = channel.getClient();
	const resp = await client.downloadResource(att.messageId, att.fileId, att.remoteType);
	if (!resp.ok) {
		const error = await resp.text();
		throw new Error(`Feishu file download failed: ${error}`);
	}
	return downloadToFile(resp, dest, maxBytes);
}

export async function acceptAttachments(
	message: Message,
	channel: Channel,
	cfg: UploadsConfig,
): Promise<{ attachments: Attachment[]; textAppend: string }> {
	if (!cfg.enabled || !message.attachments || message.attachments.length === 0) {
		return { attachments: message.attachments || [], textAppend: "" };
	}

	const accepted: Attachment[] = [];
	let textAppend = "";

	const baseDir = path.resolve(cfg.storageDir);
	const safeChatId = safeName(String(message.chatId));
	const timePrefix = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = path.join(baseDir, message.channelId, safeChatId);
	await fs.mkdir(dir, { recursive: true });

	for (const att of message.attachments) {
		try {
			const maxBytes = att.kind === "image" ? cfg.maxImageBytes : cfg.maxTextBytes;
			const fileName = safeName(att.fileName || `file_${att.fileId}`);
			const dest = path.join(dir, `${timePrefix}_${fileName}`);

			let download;
			if (isTelegramChannel(channel) && att.source === "telegram") {
				download = await downloadTelegram(channel, att, dest, maxBytes);
			} else if (isFeishuChannel(channel) && att.source === "feishu") {
				download = await downloadFeishu(channel, att, dest, maxBytes);
			} else {
				throw new Error("Attachment source does not match channel");
			}

			// Validate MIME against allowlist (prefer response header, fallback to magic)
			let mime = download.mimeType || att.mimeType || null;
			if (att.kind === "image") {
				mime = detectImageMime(download.buffer) || mime;
			}
			if (att.kind === "text" && (!mime || mime === "application/octet-stream")) {
				mime = "text/plain";
			}
			if (mime === "application/pdf") {
				// Treat PDFs as non-text for now (stored only)
				att.kind = "other";
			}
			if (!isAllowedMime(mime, cfg)) {
				throw new Error(`Disallowed mime type: ${mime || "unknown"}`);
			}

			const relativePath = path.relative(process.cwd(), dest);
			const workspaceName = process.env.WORKSPACE_NAME || "cc-bridge";
			const workspacePath = path.join("/workspaces", workspaceName, relativePath);

			const acceptedAtt: Attachment = {
				...att,
				mimeType: mime || att.mimeType,
				download: {
					relativePath,
					workspacePath,
					sizeBytes: download.sizeBytes,
				},
			};
			accepted.push(acceptedAtt);

			if (att.kind === "text") {
				const text = new TextDecoder("utf-8", { fatal: false }).decode(download.buffer);
				const clipped = text.length > 20000 ? `${text.slice(0, 20000)}\n...[truncated]` : text;
				textAppend += `\n\n[Attachment: ${fileName}]\n${clipped}\n[End Attachment]`;
			} else if (att.kind === "image") {
				textAppend += `\n\n[Attachment: ${fileName} saved to ${relativePath}]`;
			} else {
				textAppend += `\n\n[Attachment: ${fileName} saved to ${relativePath}]`;
			}
		} catch (err) {
			logger.warn(
				{ err: err instanceof Error ? err.message : String(err), fileId: att.fileId, source: att.source },
				"Attachment rejected",
			);
		}
	}

	return { attachments: accepted, textAppend };
}
