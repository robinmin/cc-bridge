import { type Context } from "hono";
import { logger } from "@/packages/logger";
import { type TelegramChannel } from "@/gateway/channels/telegram";
import { type Bot } from "@/gateway/pipeline";
import { updateTracker } from "@/gateway/tracker";
import { rateLimiter } from "@/gateway/rate-limiter";
import { persistence } from "@/gateway/persistence";

export interface WebhookContext {
    telegram: TelegramChannel;
    bots: Bot[];
}

export async function handleWebhook(c: Context, { telegram, bots }: WebhookContext) {
    const body = await c.req.json();
    const message = telegram.parseWebhook(body);

    if (!message) {
        logger.debug({ body }, "Ignored webhook: no message or unsupported update type");
        return c.json({ status: "ignored", reason: "no message" });
    }

    // Deduplication
    if (message.updateId && await updateTracker.isProcessed(message.updateId)) {
        logger.debug({ updateId: message.updateId }, "Ignored duplicate update");
        return c.json({ status: "ignored", reason: "duplicate" });
    }

    // Rate Limiting
    if (!await rateLimiter.isAllowed(message.chatId)) {
        const retry = await rateLimiter.getRetryAfter(message.chatId);
        logger.warn({ chatId: message.chatId }, "Rate limit exceeded");
        await telegram.sendMessage(message.chatId, `⚠️ Too many requests. Please try again in ${retry}s.`);
        return c.json({ status: "rate_limited" }, 429);
    }

    // Store incoming message
    await persistence.storeMessage(message.chatId, message.sender || "user", message.text);

    // Process through Chain of Bots (Bubbling)
    logger.info({ chatId: message.chatId, text: message.text }, "Processing message");
    for (const bot of bots) {
        try {
            const handled = await bot.handle(message);
            if (handled) {
                logger.debug({ bot: bot.name }, "Message handled by bot");
                break;
            }
        } catch (error) {
            logger.error({ bot: bot.name, err: error }, "Error in bot delivery");
            break; // Stop propagation if a bot fails
        }
    }

    return c.json({ status: "ok" });
}
