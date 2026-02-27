import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { FeishuChannel } from "@/gateway/channels/feishu";
import { TelegramChannel } from "@/gateway/channels/telegram";
import { AgentBot } from "@/gateway/pipeline/agent-bot";
import { HostBot } from "@/gateway/pipeline/host-bot";
import { MenuBot } from "@/gateway/pipeline/menu-bot";

const mockLogger = {
	info: mock(() => {}),
	warn: mock(() => {}),
	debug: mock(() => {}),
	error: mock(() => {}),
};

const mockConfigLoader = {
	load: mock(() => ({
		port: 8080,
		ipcPollInterval: 1000,
		refreshInterval: 30000,
		logLevel: "debug",
		logFormat: "json",
		serviceName: "gateway",
		projectsRoot: "/xprojects",
	})),
};

describe("Gateway Initialization - Feishu Channel", () => {
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		// Store original environment variables
		originalEnv = {
			TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
			FEISHU_APP_ID: process.env.FEISHU_APP_ID,
			FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
			FEISHU_DOMAIN: process.env.FEISHU_DOMAIN,
		};

		// Clear environment variables
		delete process.env.TELEGRAM_BOT_TOKEN;
		delete process.env.FEISHU_APP_ID;
		delete process.env.FEISHU_APP_SECRET;
		delete process.env.FEISHU_DOMAIN;

		// Clear mocks
		mockLogger.info.mockClear();
		mockLogger.warn.mockClear();
		mockLogger.debug.mockClear();
		mockLogger.error.mockClear();
		mockConfigLoader.load.mockClear();
	});

	afterEach(() => {
		// Restore original environment variables
		process.env.TELEGRAM_BOT_TOKEN = originalEnv.TELEGRAM_BOT_TOKEN;
		process.env.FEISHU_APP_ID = originalEnv.FEISHU_APP_ID;
		process.env.FEISHU_APP_SECRET = originalEnv.FEISHU_APP_SECRET;
		process.env.FEISHU_DOMAIN = originalEnv.FEISHU_DOMAIN;
	});

	afterAll(() => {
		mock.restore();
	});

	describe("Channel initialization", () => {
		test("should initialize Telegram channel with token from env", () => {
			process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";

			const telegram = new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN);

			expect(telegram).toBeDefined();
			expect(telegram.name).toBe("telegram");
		});

		test("should not initialize Feishu channel when credentials not provided", () => {
			const feishu = createFeishuChannelIfNeeded();

			expect(feishu).toBeUndefined();
			expect(mockLogger.debug).toHaveBeenCalledWith(
				"Feishu/Lark channel not configured (FEISHU_APP_ID and FEISHU_APP_SECRET not set)",
			);
		});

		test("should initialize Feishu channel when credentials are provided", () => {
			process.env.FEISHU_APP_ID = "cli_test123456";
			process.env.FEISHU_APP_SECRET = "test-secret-12345";

			const feishu = createFeishuChannelIfNeeded();

			expect(feishu).toBeDefined();
			expect(feishu).toBeInstanceOf(FeishuChannel);
			expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Feishu/Lark channel enabled"));
		});

		test("should use feishu domain by default", () => {
			process.env.FEISHU_APP_ID = "cli_test123456";
			process.env.FEISHU_APP_SECRET = "test-secret-12345";

			const feishu = createFeishuChannelIfNeeded();

			expect(feishu).toBeDefined();
			expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("(domain: feishu)"));
		});

		test("should use lark domain when specified", () => {
			process.env.FEISHU_APP_ID = "cli_test123456";
			process.env.FEISHU_APP_SECRET = "test-secret-12345";
			process.env.FEISHU_DOMAIN = "lark";

			const feishu = createFeishuChannelIfNeeded();

			expect(feishu).toBeDefined();
			expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("(domain: lark)"));
		});

		test("should handle Feishu initialization with only APP_ID", () => {
			process.env.FEISHU_APP_ID = "cli_test123456";

			const feishu = createFeishuChannelIfNeeded();

			expect(feishu).toBeUndefined();
			expect(mockLogger.debug).toHaveBeenCalled();
		});

		test("should handle Feishu initialization with only APP_SECRET", () => {
			process.env.FEISHU_APP_SECRET = "test-secret-12345";

			const feishu = createFeishuChannelIfNeeded();

			expect(feishu).toBeUndefined();
			expect(mockLogger.debug).toHaveBeenCalled();
		});
	});

	describe("Bot pipeline initialization", () => {
		test("should create bots for Telegram channel", () => {
			process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
			const telegram = new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN);

			const bots = createBotsForChannel(telegram);

			expect(bots).toHaveLength(3);
			expect(bots[0]).toBeInstanceOf(MenuBot);
			expect(bots[1]).toBeInstanceOf(HostBot);
			expect(bots[2]).toBeInstanceOf(AgentBot);

			// Verify all bots have the channel reference
			bots.forEach((bot) => {
				expect(bot).toBeDefined();
				expect(typeof bot.handle).toBe("function");
				expect(typeof bot.getMenus).toBe("function");
			});
		});

		test("should create bots for Feishu channel", () => {
			process.env.FEISHU_APP_ID = "cli_test123456";
			process.env.FEISHU_APP_SECRET = "test-secret-12345";
			const feishu = new FeishuChannel(process.env.FEISHU_APP_ID, process.env.FEISHU_APP_SECRET);

			const bots = createBotsForChannel(feishu);

			expect(bots).toHaveLength(3);
			expect(bots[0]).toBeInstanceOf(MenuBot);
			expect(bots[1]).toBeInstanceOf(HostBot);
			expect(bots[2]).toBeInstanceOf(AgentBot);

			// Verify all bots have the channel reference
			bots.forEach((bot) => {
				expect(bot).toBeDefined();
				expect(typeof bot.handle).toBe("function");
				expect(typeof bot.getMenus).toBe("function");
			});
		});

		test("should create bots for both channels independently", () => {
			process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
			process.env.FEISHU_APP_ID = "cli_test123456";
			process.env.FEISHU_APP_SECRET = "test-secret-12345";

			const telegram = new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN);
			const feishu = new FeishuChannel(process.env.FEISHU_APP_ID, process.env.FEISHU_APP_SECRET);

			const telegramBots = createBotsForChannel(telegram);
			const feishuBots = createBotsForChannel(feishu);

			// Each channel should have its own bot instances
			expect(telegramBots).toHaveLength(3);
			expect(feishuBots).toHaveLength(3);

			// Bot instances should be different
			expect(telegramBots[0]).not.toBe(feishuBots[0]);
			expect(telegramBots[1]).not.toBe(feishuBots[1]);
			expect(telegramBots[2]).not.toBe(feishuBots[2]);
		});
	});

	describe("Menu initialization", () => {
		test("should get menus from Telegram bots", () => {
			process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
			const telegram = new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN);
			const bots = createBotsForChannel(telegram);

			const menus = MenuBot.getAllMenus(bots);

			expect(Array.isArray(menus)).toBe(true);
			expect(menus.length).toBeGreaterThan(0);

			// Verify menu structure
			menus.forEach((menu) => {
				expect(menu).toHaveProperty("command");
				expect(menu).toHaveProperty("description");
			});
		});

		test("should get menus from Feishu bots", () => {
			process.env.FEISHU_APP_ID = "cli_test123456";
			process.env.FEISHU_APP_SECRET = "test-secret-12345";
			const feishu = new FeishuChannel(process.env.FEISHU_APP_ID, process.env.FEISHU_APP_SECRET);
			const bots = createBotsForChannel(feishu);

			const menus = MenuBot.getAllMenus(bots);

			expect(Array.isArray(menus)).toBe(true);
			expect(menus.length).toBeGreaterThan(0);

			// Verify menu structure
			menus.forEach((menu) => {
				expect(menu).toHaveProperty("command");
				expect(menu).toHaveProperty("description");
			});
		});

		test("should get same menus for both channels", () => {
			process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
			process.env.FEISHU_APP_ID = "cli_test123456";
			process.env.FEISHU_APP_SECRET = "test-secret-12345";

			const telegram = new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN);
			const feishu = new FeishuChannel(process.env.FEISHU_APP_ID, process.env.FEISHU_APP_SECRET);

			const telegramBots = createBotsForChannel(telegram);
			const feishuBots = createBotsForChannel(feishu);

			const telegramMenus = MenuBot.getAllMenus(telegramBots);
			const feishuMenus = MenuBot.getAllMenus(feishuBots);

			// Menu commands should be the same
			expect(telegramMenus.length).toBe(feishuMenus.length);

			telegramMenus.forEach((tm, index) => {
				expect(tm.command).toBe(feishuMenus[index].command);
			});
		});
	});

	describe("Edge cases", () => {
		test("should handle empty TELEGRAM_BOT_TOKEN", () => {
			process.env.TELEGRAM_BOT_TOKEN = "";

			const telegram = new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN);

			expect(telegram).toBeDefined();
			expect(telegram.name).toBe("telegram");
		});

		test("should handle empty FEISHU_APP_ID", () => {
			process.env.FEISHU_APP_ID = "";
			process.env.FEISHU_APP_SECRET = "test-secret-12345";

			const feishu = createFeishuChannelIfNeeded();

			expect(feishu).toBeUndefined();
		});

		test("should handle empty FEISHU_APP_SECRET", () => {
			process.env.FEISHU_APP_ID = "cli_test123456";
			process.env.FEISHU_APP_SECRET = "";

			const feishu = createFeishuChannelIfNeeded();

			expect(feishu).toBeUndefined();
		});

		test("should handle invalid FEISHU_DOMAIN value", () => {
			process.env.FEISHU_APP_ID = "cli_test123456";
			process.env.FEISHU_APP_SECRET = "test-secret-12345";
			process.env.FEISHU_DOMAIN = "invalid-domain";

			// Should still initialize, potentially with default or invalid domain
			// The FeishuChannel should handle this
			const feishu = new FeishuChannel(
				process.env.FEISHU_APP_ID,
				process.env.FEISHU_APP_SECRET,
				// @ts-expect-error - testing invalid domain
				process.env.FEISHU_DOMAIN,
			);

			expect(feishu).toBeDefined();
		});

		test("should handle whitespace in credentials", () => {
			process.env.FEISHU_APP_ID = " cli_test123456 ";
			process.env.FEISHU_APP_SECRET = " test-secret-12345 ";

			// Should trim or handle whitespace
			const feishu = createFeishuChannelIfNeeded();

			// With current implementation, this will create the channel
			// but credentials might have issues
			if (process.env.FEISHU_APP_ID.trim() && process.env.FEISHU_APP_SECRET.trim()) {
				expect(feishu).toBeDefined();
			}
		});
	});
});

// Helper functions that mirror the gateway initialization logic
function createFeishuChannelIfNeeded(): FeishuChannel | undefined {
	const FEISHU_APP_ID = process.env.FEISHU_APP_ID || "";
	const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || "";
	const FEISHU_DOMAIN = (process.env.FEISHU_DOMAIN as "feishu" | "lark") || "feishu";

	if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
		mockLogger.info(`Feishu/Lark channel enabled (domain: ${FEISHU_DOMAIN})`);
		return new FeishuChannel(FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_DOMAIN);
	}

	mockLogger.debug("Feishu/Lark channel not configured (FEISHU_APP_ID and FEISHU_APP_SECRET not set)");
	return undefined;
}

function createBotsForChannel(channel: TelegramChannel | FeishuChannel) {
	return [new MenuBot(channel), new HostBot(channel), new AgentBot(channel)];
}
