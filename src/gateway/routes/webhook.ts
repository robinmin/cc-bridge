import type { Context } from "hono";
import type { Channel, ChannelAdapter } from "@/gateway/channels";
import type { FeishuChannel } from "@/gateway/channels/feishu";
import { decryptFeishuWebhook, isEncryptedFeishuWebhook } from "@/gateway/channels/feishu";
import type { TelegramChannel } from "@/gateway/channels/telegram";
import { markChatStart } from "@/gateway/channels/telegram";
import { setChannelForChat } from "@/gateway/channels/chat-channel-map";
import { persistence } from "@/gateway/persistence";
import type { Bot, Message } from "@/gateway/pipeline";
import { BotRouter } from "@/gateway/pipeline/bot-router";
import { rateLimiter } from "@/gateway/rate-limiter";
import { updateTracker } from "@/gateway/tracker";
import { logger } from "@/packages/logger";
import { acceptAttachments } from "@/gateway/services/file-acceptor";

// Webhook processing timeout (120 seconds) - allows for complex operations like web search
// Telegram webhook timeout is ~30s, but we respond immediately and process async
const WEBHOOK_PROCESSING_TIMEOUT_MS = 120000;

export interface WebhookContext {
	telegram: TelegramChannel;
	feishu?: FeishuChannel;
	bots: Bot[];
	feishuBots?: Bot[];
	config?: { uploads?: { enabled: boolean } };
}

/**
 * Wraps a bot's handle call with timeout protection
 * Uses atomic state transitions to prevent race conditions between timeout and completion
 */
async function handleBotWithTimeout(bot: Bot, message: Message, channel: Channel): Promise<boolean> {
	// State machine: 'pending' -> 'completed' | 'timeout'
	// Only ONE transition allowed (atomic via object reference)
	const state = { current: "pending" as "pending" | "completed" | "timeout" };
	let timeoutId: NodeJS.Timeout | null = null;

	const timeoutPromise = new Promise<boolean>((resolve) => {
		timeoutId = setTimeout(async () => {
			// Atomic state transition: only succeeds if still pending
			if (state.current !== "pending") {
				logger.debug(
					{ bot: bot.name, chatId: message.chatId, finalState: state.current },
					"Timeout fired but request already completed - skipping notification",
				);
				resolve(false); // Don't mark as handled
				return;
			}

			// Atomically claim timeout state
			state.current = "timeout";

			logger.warn(
				{ bot: bot.name, chatId: message.chatId },
				"Bot handle timeout - sending timeout notification to user",
			);

			// Send timeout notification to user (async, non-blocking)
			channel
				.sendMessage(
					message.chatId,
					"⏱️ Taking longer than expected. If you don't get a response soon, please try again.",
				)
				.catch((err) => logger.error({ err }, "Failed to send timeout notification"));

			resolve(true); // Mark as handled to stop propagation
		}, WEBHOOK_PROCESSING_TIMEOUT_MS);
	});

	// Race between bot handler and timeout
	const result = await Promise.race([
		bot.handle(message).then((handled) => {
			// Atomic state transition: only succeeds if still pending
			if (state.current === "pending") {
				state.current = "completed";
				logger.debug({ bot: bot.name, chatId: message.chatId }, "Bot completed successfully before timeout");
			}
			return handled;
		}),
		timeoutPromise,
	]);

	// Clean up timeout if it hasn't fired yet
	if (timeoutId && state.current !== "timeout") {
		clearTimeout(timeoutId);
	}

	return result;
}

/**
 * Common webhook message processing logic
 * Handles deduplication, rate limiting, persistence, and bot delivery
 */
async function processWebhookMessage(
	c: Context,
	message: Message,
	channel: Channel,
	channelBots: Bot[],
	config?: { uploads?: unknown },
): Promise<Response> {
	// Deduplication
	if (message.updateId && (await updateTracker.isProcessed(message.updateId))) {
		logger.debug({ updateId: message.updateId }, "Ignored duplicate update");
		return c.json({ status: "ignored", reason: "duplicate" });
	}

	// Rate Limiting
	if (!(await rateLimiter.isAllowed(message.chatId))) {
		const retry = await rateLimiter.getRetryAfter(message.chatId);
		logger.warn({ chatId: message.chatId }, "Rate limit exceeded");
		await channel.sendMessage(message.chatId, `⚠️ Too many requests. Please try again in ${retry}s.`);
		return c.json({ status: "rate_limited" }, 429);
	}

	// Note: User message storage is handled by the bot (agent-bot.ts)
	// to avoid duplicate storage in async mode

	// Show typing indicator before processing (optional, non-blocking)
	if (channel.showTyping) {
		channel.showTyping(message.chatId).catch((err) => {
			logger.debug({ err }, "Failed to show typing indicator (non-critical)");
		});
	}

	// Process through Bot Router (instant pattern-based routing)
	markChatStart(message.chatId);
	setChannelForChat(message.chatId, channel.name);
	logger.info(`[${message.chatId}] ==> ${message.text}`);

	// Handle attachments (download + validation)
	if (message.attachments && message.attachments.length > 0) {
		const cfg = config?.uploads as {
			enabled: boolean;
			allowedMimeTypes: string[];
			maxTextBytes: number;
			maxImageBytes: number;
			retentionHours: number;
			storageDir: string;
		};
		if (cfg?.enabled) {
			const { attachments, textAppend } = await acceptAttachments(message, channel, cfg);
			message.attachments = attachments;
			if (textAppend) {
				message.text = `${message.text || ""}${textAppend}`;
			} else if (!message.text) {
				message.text = "[User sent attachments]";
			}
		}
	}

	let handled = false;
	let lastError: unknown = null;

	// Use BotRouter for instant routing (eliminates sequential timeout exposure)
	const router = new BotRouter(channelBots);
	const targetBot = router.route(message);

	if (targetBot) {
		try {
			handled = await handleBotWithTimeout(targetBot, message, channel);
			if (handled) {
				logger.debug({ bot: targetBot.name }, "Message handled by bot");
			}
		} catch (error) {
			lastError = error;
			logger.error(
				{
					bot: targetBot.name,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error in bot delivery",
			);
		}
	} else {
		logger.warn({ chatId: message.chatId }, "BotRouter returned null - no bot available");
	}

	// If no bot handled the message and there was an error, notify user
	if (!handled && lastError) {
		logger.warn({ chatId: message.chatId }, "No bot handled the message, and there was an error");
		await channel
			.sendMessage(message.chatId, "❌ Sorry, something went wrong processing your request. Please try again.")
			.catch((err) => logger.error({ err }, "Failed to send error notification"));
	}

	return c.json({ status: "ok" });
}

/**
 * Handle Telegram webhook
 * Route: POST /webhook/telegram
 */
export async function handleTelegramWebhook(c: Context, { telegram, bots, config }: WebhookContext): Promise<Response> {
	const body = await c.req.json();

	// Parse webhook using the Telegram channel adapter
	const message = (telegram as ChannelAdapter).parseWebhook(body);

	if (!message) {
		logger.debug({ body }, "Ignored Telegram webhook: no message or unsupported update type");
		return c.json({ status: "ignored", reason: "no message" });
	}

	// Process the message through common logic
	return processWebhookMessage(c, message, telegram, bots, config);
}

/**
 * Handle Feishu/Lark webhook
 * Route: POST /webhook/feishu
 */
export async function handleFeishuWebhook(
	c: Context,
	{ feishu, feishuBots, config }: WebhookContext,
): Promise<Response> {
	// Check if Feishu channel is configured
	if (!feishu || !feishuBots) {
		logger.debug("Received Feishu webhook but Feishu channel is not configured");
		return c.json({ status: "ignored", reason: "feishu not configured" }, 503);
	}

	const rawBody = await c.req.json();
	logger.debug({ body: rawBody, headers: c.req.header() }, "Received Feishu/Lark webhook request");
	let body = rawBody;

	// Handle encrypted webhooks
	if (isEncryptedFeishuWebhook(rawBody)) {
		const encryptKey = feishu.getEncryptKey();
		if (!encryptKey) {
			logger.warn({ body: rawBody }, "Received encrypted Feishu webhook but FEISHU_ENCRYPT_KEY is not configured");
			return c.json({ status: "error", message: "FEISHU_ENCRYPT_KEY not configured" }, 500);
		}

		try {
			// Decrypt the webhook payload
			const decrypted = decryptFeishuWebhook(rawBody.encrypt, encryptKey);

			// Handle URL verification challenge
			const urlVerification = feishu.handleUrlVerification(decrypted);
			if (urlVerification) {
				logger.info("Feishu/Lark URL verification challenge handled successfully");
				return c.json(urlVerification);
			}

			// Use decrypted payload for normal processing
			body = decrypted;
		} catch (error) {
			logger.error(
				{ error, rawBody },
				"Failed to decrypt Feishu webhook - possibly encryption key mismatch or corrupted payload",
			);
			return c.json({ status: "error", message: "Failed to decrypt webhook" }, 400);
		}
	}

	// Parse webhook using the Feishu channel adapter
	const message = (feishu as ChannelAdapter).parseWebhook(body);

	if (!message) {
		logger.debug(
			{ body },
			"Feishu webhook ignored: no message found in event or unsupported update type (expected im.message.receive_v1)",
		);
		return c.json({ status: "ignored", reason: "no message" });
	}

	// Process the message through common logic
	return processWebhookMessage(c, message, feishu, feishuBots, config);
}

/**
 * Legacy unified webhook handler for backward compatibility
 * Route: POST /webhook
 *
 * @deprecated Use /webhook/telegram or /webhook/feishu instead
 *
 * This handler detects the channel type based on request body structure
 * and delegates to the appropriate channel-specific handler.
 */
export async function handleWebhook(c: Context, context: WebhookContext): Promise<Response> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		logger.debug({ body: "invalid json" }, "Ignored webhook: invalid JSON");
		return c.json({ status: "ignored", reason: "unknown channel" });
	}

	// Handle null/undefined body
	if (!body || typeof body !== "object") {
		logger.debug({ body }, "Ignored webhook: null or non-object body");
		return c.json({ status: "ignored", reason: "unknown channel" });
	}

	// Detect channel type based on body structure
	const bodyObj = body as Record<string, unknown>;

	// Check if this is an encrypted Feishu webhook
	if ("encrypt" in bodyObj && typeof bodyObj.encrypt === "string") {
		return handleFeishuWebhook(c, context);
	}

	// Check if this is a Feishu webhook (has schema and header.event_type)
	if ("schema" in bodyObj && "header" in bodyObj) {
		const header = bodyObj.header as Record<string, unknown>;
		if ("event_type" in header) {
			return handleFeishuWebhook(c, context);
		}
	}

	// Check if this is a Telegram webhook (has update_id)
	if ("update_id" in bodyObj) {
		return handleTelegramWebhook(c, context);
	}

	// Unknown channel type
	logger.debug({ body }, "Ignored webhook: unknown channel type");
	return c.json({ status: "ignored", reason: "unknown channel" });
}
