import { OllamaClient } from './ollama-client.js';
import { EmbeddingCache } from './embedding-cache.js';
import { trackEmbeddingGeneration } from './metrics.js';

export interface EmbeddingProvider {
  name: string;
  model: string;
  dimensions: number;
  generateEmbedding(text: string): Promise<number[]>;
  isAvailable(): Promise<boolean>;
  /**
   * REM-249: Get model fingerprint for embedding consistency tracking.
   */
  getModelFingerprint(): string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  name: string = 'ollama';
  model: string;
  dimensions: number;
  private client: OllamaClient;

  constructor(model: string = 'nomic-embed-text', dimensions: number = 768, host?: string) {
    this.model = model;
    this.dimensions = dimensions;
    // Use singleton OllamaClient instead of creating new instance
    this.client = OllamaClient.getInstance();
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // Delegate to OllamaClient singleton
    return this.client.generateEmbedding(text);
  }

  async isAvailable(): Promise<boolean> {
    // Delegate to OllamaClient singleton
    return this.client.isAvailable();
  }

  getHost(): string {
    return this.client.getHost();
  }

  /**
   * REM-249: Get model fingerprint for embedding consistency tracking.
   */
  getModelFingerprint(): string {
    return this.client.getModelFingerprint();
  }

  static createDefault(host?: string): OllamaEmbeddingProvider {
    return new OllamaEmbeddingProvider('nomic-embed-text', 768, host);
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  name: string = 'openai-compatible';
  model: string;
  dimensions: number;
  private baseUrl: string;
  private embeddingCache: EmbeddingCache;

  constructor(baseUrl: string, model: string, dimensions: number = 768) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.dimensions = dimensions;
    this.embeddingCache = EmbeddingCache.getInstance();
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const cached = await this.embeddingCache.get(text);
    if (cached) {
      return cached;
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: text
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Embedding request failed (${response.status}): ${body.slice(0, 300)}`);
      }

      const json = await response.json() as {
        data?: Array<{ embedding?: number[] }>;
      };
      const embedding = json.data?.[0]?.embedding;

      if (!embedding || embedding.length !== this.dimensions) {
        throw new Error(`Invalid embedding dimensions: expected ${this.dimensions}, got ${embedding?.length}`);
      }

      const durationSeconds = (Date.now() - startTime) / 1000;
      trackEmbeddingGeneration(this.name, this.model, durationSeconds);

      this.embeddingCache.set(text, embedding).catch(err =>
        console.warn('Failed to cache embedding:', err.message)
      );

      return embedding;
    } finally {
      clearTimeout(timeout);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`);
      return response.ok;
    } catch {
      return false;
    }
  }

  getModelFingerprint(): string {
    return `${this.name}:${this.model}:dims-${this.dimensions}`;
  }
}

/**
 * Azure OpenAI embedding provider.
 *
 * Azure is not drop-in OpenAI-compatible for embeddings: it uses deployment-based
 * URLs (`/openai/deployments/<deployment>/embeddings?api-version=<ver>`), an
 * `api-key` header instead of `Authorization: Bearer`, and accepts a native
 * `dimensions` parameter so a text-embedding-3-* deployment can return 768-dim
 * vectors that match the pgvector schema. Selected with EMBEDDING_PROVIDER=azure.
 */
export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  name: string = 'azure';
  model: string;
  dimensions: number;
  private endpoint: string;
  private apiKey: string;
  private apiVersion: string;
  private deployment: string;
  private embeddingCache: EmbeddingCache;

  constructor(endpoint: string, deployment: string, apiKey: string, apiVersion: string, dimensions: number = 768) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.deployment = deployment;
    this.apiKey = apiKey;
    this.apiVersion = apiVersion;
    this.dimensions = dimensions;
    this.model = deployment;
    this.embeddingCache = EmbeddingCache.getInstance();
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const cached = await this.embeddingCache.get(text);
    if (cached) {
      return cached;
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const url = `${this.endpoint}/openai/deployments/${encodeURIComponent(this.deployment)}/embeddings?api-version=${encodeURIComponent(this.apiVersion)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey
        },
        body: JSON.stringify({
          input: text,
          dimensions: this.dimensions
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Azure embedding request failed (${response.status}): ${body.slice(0, 300)}`);
      }

      const json = await response.json() as {
        data?: Array<{ embedding?: number[] }>;
      };
      const embedding = json.data?.[0]?.embedding;

      if (!embedding || embedding.length !== this.dimensions) {
        throw new Error(`Invalid embedding dimensions: expected ${this.dimensions}, got ${embedding?.length}`);
      }

      const durationSeconds = (Date.now() - startTime) / 1000;
      trackEmbeddingGeneration(this.name, this.model, durationSeconds);

      this.embeddingCache.set(text, embedding).catch(err =>
        console.warn('Failed to cache embedding:', err.message)
      );

      return embedding;
    } finally {
      clearTimeout(timeout);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.generateEmbedding('health');
      return true;
    } catch (error) {
      console.warn('[AzureOpenAIEmbeddingProvider] Availability check failed:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  getModelFingerprint(): string {
    return `${this.name}:${this.model}:dims-${this.dimensions}`;
  }
}
