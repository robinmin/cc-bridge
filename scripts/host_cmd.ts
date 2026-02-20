import { AgentBot } from "@/gateway/pipeline/agent-bot";
import type { Channel } from "@/gateway/channels";
import type { Message } from "@/gateway/pipeline";

class StdoutChannel implements Channel {
	name = "host";
	async sendMessage(_chatId: string | number, text: string): Promise<void> {
		// Print raw output (no formatting)
		process.stdout.write(`${text}\n`);
	}
}

async function main(): Promise<void> {
	const cmd = process.argv[2];
	const arg = process.argv[3];
	const customChatId = process.argv[4];

	if (!cmd) {
		process.stderr.write("Missing command\n");
		process.exitCode = 1;
		return;
	}

	const slash = `/${cmd}${arg ? ` ${arg}` : ""}`;

	const channel = new StdoutChannel();
	const bot = new AgentBot(channel);

	const effectiveChatId = customChatId || "host-cli";

	const message: Message = {
		channelId: "host",
		chatId: effectiveChatId,
		text: slash,
		user: { id: effectiveChatId },
	};

	const handled = await bot.handle(message);
	if (!handled) {
		process.stderr.write(`Command not handled: ${slash}\n`);
		process.exitCode = 1;
	}
}

await main();
