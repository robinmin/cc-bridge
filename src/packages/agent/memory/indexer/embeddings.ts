/**
 * Embedding Provider Interface
 *
 * Abstract interface for vector embeddings with multiple provider support.
 */

import type { EmbeddingProvider, EmbeddingResult, EmbeddingStatus } from "./types";

/**
 * Embedding provider configuration
 */
export interface EmbeddingProviderConfig {
	provider: EmbeddingProvider;
	apiKey?: string;
	model?: string;
}

/**
 * Embedding provider interface
 */
export interface EmbeddingProviderInterface {
	/**
	 * Get provider status
	 */
	status(): Promise<EmbeddingStatus>;

	/**
	 * Generate embeddings for text
	 */
	embed(text: string): Promise<EmbeddingResult>;

	/**
	 * Generate embeddings for multiple texts (batch)
	 */
	embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
}

/**
 * OpenAI embeddings provider
 */
export class OpenAIEmbeddingProvider implements EmbeddingProviderInterface {
	private apiKey: string;
	private model: string;
	private baseUrl = "https://api.openai.com/v1";

	constructor(config: { apiKey?: string; model?: string }) {
		this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
		this.model = config.model ?? "text-embedding-3-small";
	}

	async status(): Promise<EmbeddingStatus> {
		if (!this.apiKey) {
			return { available: false, error: "No API key configured" };
		}

		return {
			available: true,
			provider: "openai",
			model: this.model,
		};
	}

	async embed(text: string): Promise<EmbeddingResult> {
		const results = await this.embedBatch([text]);
		return results[0];
	}

	async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
		if (!this.apiKey) {
			throw new Error("OpenAI API key not configured");
		}

		const response = await fetch(`${this.baseUrl}/embeddings`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.model,
				input: texts,
			}),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`OpenAI embedding error: ${error}`);
		}

		const data = (await response.json()) as {
			data: Array<{ embedding: number[] }>;
		};

		return data.data.map((item) => ({
			embedding: item.embedding,
			provider: "openai" as EmbeddingProvider,
			model: this.model,
		}));
	}
}

/**
 * Fallback provider that returns zero vectors
 * Used when no embedding provider is available
 */
export class NullEmbeddingProvider implements EmbeddingProviderInterface {
	private dimensions = 1536;

	async status(): Promise<EmbeddingStatus> {
		return { available: false, error: "No provider configured" };
	}

	async embed(_text: string): Promise<EmbeddingResult> {
		return {
			embedding: new Array(this.dimensions).fill(0),
			provider: "openai",
			model: "null",
		};
	}

	async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
		return Promise.all(texts.map((t) => this.embed(t)));
	}
}

/**
 * Create embedding provider based on config
 */
export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProviderInterface {
	switch (config.provider) {
		case "openai":
			return new OpenAIEmbeddingProvider(config);
		default:
			return new NullEmbeddingProvider();
	}
}
