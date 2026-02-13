import { createDecipheriv, createHash } from "node:crypto";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";
import type { Message } from "@/gateway/pipeline";
import { logger } from "@/packages/logger";
import { consumeChatElapsed } from "@/gateway/channels/telegram";
import type { Channel, ChannelAdapter } from "./index";

// Default timeout for Feishu API calls (30 seconds)
const FEISHU_API_TIMEOUT_MS = 30000;
const _TOKEN_CACHE_TTL_MS = 3600000; // 1 hour

// Feishu/Lark domain types
type FeishuDomain = "feishu" | "lark";

// Feishu API response types
interface FeishuTokenResponse {
	code: number;
	msg: string;
	tenant_access_token?: string;
	expire?: number;
}

interface FeishuMessageResponse {
	code: number;
	msg: string;
}

interface FeishuWebhookBody {
	schema: string;
	header: {
		event_id: string;
		timestamp: string;
		event_type: string;
		tenant_key: string;
		app_id: string;
	};
	event: {
		sender: {
			sender_id: {
				open_id: string;
				union_id?: string;
			};
			sender_type: string;
			tenant_key: string;
		};
		message: {
			message_id: string;
			chat_id: string;
			chat_type: string;
			content: string;
			message_type: string;
		};
	};
}

// Encrypted webhook types
interface FeishuEncryptedWebhook {
	encrypt: string;
}

interface FeishuDecryptedPayload {
	challenge?: string;
	// Other fields when decrypted (schema, header, event, etc.)
	[key: string]: unknown;
}

/**
 * Decrypt Feishu/Lark encrypted webhook payload
 *
 * Feishu/Lark uses AES-256-CBC encryption with:
 * - Key: SHA-256 hash of the encrypt key (32 bytes for AES-256)
 * - IV: First 16 bytes of the Base64-decoded encrypted data
 * - Padding: PKCS#7 (auto)
 *
 * Official documentation:
 * - Feishu: https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 * - Lark: https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case
 *
 * @param encrypted Base64-encoded encrypted string
 * @param encryptKey The encryption key configured in Feishu/Lark Open Platform
 * @returns Decrypted JSON object
 */
export function decryptFeishuWebhook(encrypted: string, encryptKey: string): unknown {
	// Base64 decode the encrypted data
	const encryptedBuffer = Buffer.from(encrypted, "base64");

	if (encryptedBuffer.length < 16) {
		throw new Error("Encrypted payload too short");
	}

	// Extract IV (first 16 bytes)
	const iv = encryptedBuffer.subarray(0, 16);
	const encryptedData = encryptedBuffer.subarray(16);

	logger.debug(
		{
			algorithm: "aes-256-cbc",
			dataLength: encryptedData.length,
			encryptKeyLength: encryptKey.length,
			encryptedBufferLength: encryptedBuffer.length,
		},
		"Attempting Feishu/Lark webhook decryption",
	);

	// Derive key from encryptKey using SHA-256 (NOT MD5)
	const key = createHash("sha256").update(encryptKey).digest();

	logger.debug(
		{
			algorithm: "aes-256-cbc",
			keyLength: key.length,
			ivLength: iv.length,
			firstBytesEncryptKey: Buffer.from(encryptKey).subarray(0, 4).toString("hex"),
			firstBytesDerivedKey: key.subarray(0, 4).toString("hex"),
		},
		"Feishu/Lark decryption parameters (SHA-256 key derivation)",
	);

	// Decrypt using AES-256-CBC
	const decipher = createDecipheriv("aes-256-cbc", key, iv);
	decipher.setAutoPadding(true);

	let decryptedData = decipher.update(encryptedData);
	decryptedData = Buffer.concat([decryptedData, decipher.final()]);

	// Parse JSON
	const decryptedStr = decryptedData.toString("utf-8");
	const parsed = JSON.parse(decryptedStr);

	logger.info(
		{ algorithm: "aes-256-cbc", dataLength: encryptedData.length },
		"Successfully decrypted Feishu/Lark webhook",
	);

	return parsed;
}

/**
 * Check if a webhook body is an encrypted Feishu webhook
 */
export function isEncryptedFeishuWebhook(body: unknown): body is FeishuEncryptedWebhook {
	if (!body || typeof body !== "object") return false;
	const bodyObj = body as Record<string, unknown>;
	return "encrypt" in bodyObj && typeof bodyObj.encrypt === "string";
}

// Feishu API client
class FeishuClient {
	private appId: string;
	private appSecret: string;
	private domain: FeishuDomain;
	private baseUrl: string;
	private accessToken: string | null = null;
	private tokenExpireTime: number | null = null;

	constructor(appId: string, appSecret: string, domain: FeishuDomain = "feishu") {
		this.appId = appId;
		this.appSecret = appSecret;
		this.domain = domain;
		this.baseUrl =
			domain === "lark"
				? GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.LARK_API_BASE
				: GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.FEISHU_API_BASE;
	}

	/**
	 * Get the tenant access token for API calls
	 * Tokens are cached for up to 1 hour
	 */
	async getTenantAccessToken(): Promise<string> {
		// Return cached token if still valid
		if (this.accessToken && this.tokenExpireTime && Date.now() < this.tokenExpireTime) {
			return this.accessToken;
		}

		const url = `${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`;
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				app_id: this.appId,
				app_secret: this.appSecret,
			}),
			signal: AbortSignal.timeout(FEISHU_API_TIMEOUT_MS),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Feishu API error (getTenantAccessToken): ${error}`);
		}

		const data = (await response.json()) as FeishuTokenResponse;

		if (data.code !== 0 || !data.tenant_access_token) {
			throw new Error(`Feishu API error: ${data.msg} (code: ${data.code})`);
		}

		// Cache the token with expiration buffer (5 minutes before actual expiration)
		this.accessToken = data.tenant_access_token;
		this.tokenExpireTime = Date.now() + (data.expire || 7200) * 1000 - 300000;

		return this.accessToken;
	}

	/**
	 * Send a text message to a Feishu chat
	 */
	async sendMessage(chatId: string, text: string): Promise<void> {
		const token = await this.getTenantAccessToken();
		const url = `${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;

		// Build message content in Feishu text format
		const content = JSON.stringify({
			text,
		});

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				receive_id: chatId,
				msg_type: "text",
				content,
			}),
			signal: AbortSignal.timeout(FEISHU_API_TIMEOUT_MS),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Feishu API error (sendMessage): ${error}`);
		}

		const data = (await response.json()) as FeishuMessageResponse;

		if (data.code !== 0) {
			throw new Error(`Feishu API error: ${data.msg} (code: ${data.code})`);
		}
	}

	async downloadResource(messageId: string, fileKey: string, type: "file" | "image"): Promise<Response> {
		const token = await this.getTenantAccessToken();
		const url = `${this.baseUrl}/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;
		return fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
			},
			signal: AbortSignal.timeout(FEISHU_API_TIMEOUT_MS),
		});
	}

	/**
	 * Send a chat action (typing indicator) to a Feishu chat
	 * Note: Feishu doesn't have a native typing indicator API
	 * This is a no-op for now
	 */
	async sendChatAction(chatId: string): Promise<void> {
		// Feishu doesn't support typing indicators natively
		// This is a no-op for compatibility with the Channel interface
		logger.debug({ chatId }, "Feishu does not support chat actions (typing indicator)");
	}

	/**
	 * Set bot menu commands
	 * Note: Feishu uses different bot menu mechanism
	 * This would require additional bot configuration setup
	 */
	async setCommands(commands: { command: string; description: string }[]): Promise<void> {
		logger.debug(
			{ count: commands.length, commands },
			"Feishu bot menu commands setup requires manual configuration in Feishu Open Platform",
		);
		// Feishu bot commands are configured in the Feishu Open Platform console
		// This is a no-op for API configuration
	}

	/**
	 * Get webhook information
	 */
	async getWebhookInfo(): Promise<{ appId: string; domain: string }> {
		return {
			appId: this.appId,
			domain: this.domain,
		};
	}
}

export class FeishuChannel implements Channel, ChannelAdapter {
	name = "feishu";
	private client: FeishuClient;
	private encryptKey?: string;

	constructor(appId: string, appSecret: string, domain?: FeishuDomain, encryptKey?: string) {
		this.client = new FeishuClient(appId, appSecret, domain);
		this.encryptKey = encryptKey;
	}

	getClient(): FeishuClient {
		return this.client;
	}

	/**
	 * Get the encrypt key (for use by webhook handler)
	 */
	getEncryptKey(): string | undefined {
		return this.encryptKey;
	}

	/**
	 * Handle URL verification challenge from Feishu/Lark
	 * Returns the challenge string if present, otherwise null
	 */
	handleUrlVerification(decrypted: unknown): { challenge: string } | null {
		try {
			const payload = decrypted as FeishuDecryptedPayload;
			if (payload.challenge) {
				return { challenge: payload.challenge };
			}
			return null;
		} catch {
			return null;
		}
	}

	async sendMessage(chatId: string | number, text: string, _options?: unknown): Promise<void> {
		await this.client.sendMessage(String(chatId), text);

		// Log outgoing message with truncated content (after send completes)
		const maxLength = 256;
		const truncatedText = text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
		const elapsedSec = consumeChatElapsed(chatId);
		const elapsedSuffix = elapsedSec !== null ? ` (${elapsedSec.toFixed(2)}s)` : "";
		logger.info(`[Feishu:${chatId}] <== ${truncatedText.replace(/\n/g, "\\n")}${elapsedSuffix}`);
	}

	async showTyping(chatId: string | number): Promise<void> {
		// Feishu doesn't support typing indicators
		await this.client.sendChatAction(String(chatId));
	}

	async setMenu(commands: { command: string; description: string }[]): Promise<void> {
		await this.client.setCommands(commands);
	}

	async getStatus(): Promise<unknown> {
		return this.client.getWebhookInfo();
	}

	parseWebhook(body: unknown): Message | null {
		try {
			const webhookBody = body as Partial<FeishuWebhookBody>;

			// Validate Feishu webhook structure
			if (!webhookBody?.header?.event_type || !webhookBody?.event?.message) {
				return null;
			}

			// Filter for message received events only
			if (webhookBody.header.event_type !== "im.message.receive_v1") {
				return null;
			}

			const { sender, message } = webhookBody.event;
			const attachments: Message["attachments"] = [];

			// Parse message content (it's a JSON string)
			let messageText = "";
			try {
				const content = JSON.parse(message.content);
				if (content.text) {
					messageText = content.text;
				} else if (message.message_type === "post") {
					// Handle post format messages
					const postContent = content.post?.zh_cn?.content;
					if (Array.isArray(postContent) && postContent.length > 0) {
						// Extract text from post format
						const textElements = postContent.flat().filter((item: unknown) => {
							if (typeof item === "object" && item !== null && "tag" in item && item.tag === "text") {
								return true;
							}
							return false;
						});
						messageText = textElements
							.map((item: unknown) => {
								if (typeof item === "object" && item !== null && "text" in item) {
									return String(item.text);
								}
								return "";
							})
							.join("");
					}
				}
			} catch {
				// If parsing fails, try to use content as-is
				messageText = message.content;
			}

			// Parse attachments (image / file)
			try {
				const content = JSON.parse(message.content);
				if (message.message_type === "image" && content.image_key) {
					attachments.push({
						source: "feishu",
						fileId: String(content.image_key),
						fileName: `image_${String(content.image_key)}.jpg`,
						mimeType: "image/jpeg",
						kind: "image",
						sizeBytes: typeof content.image_size === "number" ? content.image_size : undefined,
						remoteType: "image",
						messageId: message.message_id,
					});
				}
				if (message.message_type === "file" && content.file_key) {
					const fileName = content.file_name ? String(content.file_name) : `file_${String(content.file_key)}`;
					const mimeType = content.mime_type ? String(content.mime_type) : undefined;
					const sizeBytes = typeof content.file_size === "number" ? content.file_size : undefined;
					const kind = mimeType === "application/pdf" ? "other" : mimeType?.startsWith("image/") ? "image" : "text";
					attachments.push({
						source: "feishu",
						fileId: String(content.file_key),
						fileName,
						mimeType,
						sizeBytes,
						kind: kind as "text" | "image" | "other",
						remoteType: "file",
						messageId: message.message_id,
					});
				}
			} catch {
				// ignore attachment parsing errors
			}

			return {
				channelId: "feishu",
				chatId: message.chat_id,
				text: messageText,
				updateId: webhookBody.header.event_id,
				user: {
					id: sender.sender_id.open_id,
					username: undefined, // Feishu doesn't expose username by default
				},
				attachments,
			};
		} catch (error) {
			logger.error({ error, body }, "Failed to parse Feishu webhook");
			return null;
		}
	}
}
