const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_SIZE = 10000;

type ChannelEntry = {
	channel: string;
	lastSeen: number;
};

const map = new Map<string, ChannelEntry>();

const ttlMs = (): number => {
	const raw = process.env.CHAT_CHANNEL_MAP_TTL_MS;
	if (!raw) return DEFAULT_TTL_MS;
	const val = Number(raw);
	return Number.isFinite(val) && val > 0 ? val : DEFAULT_TTL_MS;
};

const maxSize = (): number => {
	const raw = process.env.CHAT_CHANNEL_MAP_MAX_SIZE;
	if (!raw) return DEFAULT_MAX_SIZE;
	const val = Number(raw);
	return Number.isFinite(val) && val > 0 ? val : DEFAULT_MAX_SIZE;
};

const cleanup = (): void => {
	const now = Date.now();
	const ttl = ttlMs();
	for (const [key, entry] of map) {
		if (now - entry.lastSeen > ttl) {
			map.delete(key);
		}
	}

	// Soft size cap: drop oldest entries if over max size
	const limit = maxSize();
	if (map.size <= limit) return;

	const entries = Array.from(map.entries());
	entries.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
	const toRemove = entries.length - limit;
	for (let i = 0; i < toRemove; i += 1) {
		map.delete(entries[i][0]);
	}
};

export const setChannelForChat = (chatId: string | number, channel: string): void => {
	const key = String(chatId);
	map.set(key, { channel, lastSeen: Date.now() });
	cleanup();
};

export const getChannelForChat = (chatId: string | number): string | null => {
	const key = String(chatId);
	const entry = map.get(key);
	if (!entry) return null;
	if (Date.now() - entry.lastSeen > ttlMs()) {
		map.delete(key);
		return null;
	}
	return entry.channel;
};
