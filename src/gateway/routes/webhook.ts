import type { Context } from "hono";
import type { TelegramChannel } from "@/gateway/channels/telegram";
import { persistence } from "@/gateway/persistence";
import type { Bot } from "@/gateway/pipeline";
import { rateLimiter } from "@/gateway/rate-limiter";
import { updateTracker } from "@/gateway/tracker";
import { logger } from "@/packages/logger";

// Webhook processing timeout (120 seconds) - allows for complex operations like web search
// Telegram webhook timeout is ~30s, but we respond immediately and process async
const WEBHOOK_PROCESSING_TIMEOUT_MS = 120000;

export interface WebhookContext {
	telegram: TelegramChannel;
	bots: Bot[];
}

/**
 * Wraps a bot's handle call with timeout protection
 * Uses atomic state transitions to prevent race conditions between timeout and completion
 */
async function handleBotWithTimeout(
	bot: Bot,
	message: { chatId: string | number; text: string },
	telegram: TelegramChannel,
): Promise<boolean> {
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
			telegram
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

export async function handleWebhook(c: Context, { telegram, bots }: WebhookContext) {
	const body = await c.req.json();
	const message = telegram.parseWebhook(body);

	if (!message) {
		logger.debug({ body }, "Ignored webhook: no message or unsupported update type");
		return c.json({ status: "ignored", reason: "no message" });
	}

	// Deduplication
	if (message.updateId && (await updateTracker.isProcessed(message.updateId))) {
		logger.debug({ updateId: message.updateId }, "Ignored duplicate update");
		return c.json({ status: "ignored", reason: "duplicate" });
	}

	// Rate Limiting
	if (!(await rateLimiter.isAllowed(message.chatId))) {
		const retry = await rateLimiter.getRetryAfter(message.chatId);
		logger.warn({ chatId: message.chatId }, "Rate limit exceeded");
		await telegram.sendMessage(message.chatId, `⚠️ Too many requests. Please try again in ${retry}s.`);
		return c.json({ status: "rate_limited" }, 429);
	}

	// Get user's current workspace for storing message
	const workspace = await persistence.getWorkspace(message.chatId);

	// Store incoming message (workspace-specific)
	await persistence.storeMessage(message.chatId, message.sender || "user", message.text, workspace);

	// Show typing indicator before processing (optional, non-blocking)
	if (telegram.showTyping) {
		telegram.showTyping(message.chatId).catch((err) => {
			logger.debug({ err }, "Failed to show typing indicator (non-critical)");
		});
	}

	// Process through Chain of Bots (Bubbling)
	logger.info(`[${message.chatId}] ==> ${message.text}`);

	let handled = false;
	let lastError: unknown = null;

	for (const bot of bots) {
		try {
			handled = await handleBotWithTimeout(bot, message, telegram);
			if (handled) {
				logger.debug({ bot: bot.name }, "Message handled by bot");
				break;
			}
		} catch (error) {
			lastError = error;
			logger.error(
				{
					bot: bot.name,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error in bot delivery",
			);
			// Continue to next bot instead of breaking
		}
	}

	// If no bot handled the message and there was an error, notify user
	if (!handled && lastError) {
		logger.warn({ chatId: message.chatId }, "No bot handled the message, and there was an error");
		await telegram
			.sendMessage(message.chatId, "❌ Sorry, something went wrong processing your request. Please try again.")
			.catch((err) => logger.error({ err }, "Failed to send error notification"));
	}

	return c.json({ status: "ok" });
}
