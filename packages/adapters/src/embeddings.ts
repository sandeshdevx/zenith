/**
 * Embedding adapter — powers the Implicit Clinical Screening Mapper (patent
 * module 103) and the semantic half of the NLP Sentiment Engine (102).
 * Default engine: nomic-embed-text via Ollama — small, fast on CPU, free.
 */

export interface EmbeddingAdapter {
  readonly name: string;
  /** Returns one vector per input text. */
  embed(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<boolean>;
}

export interface OllamaEmbeddingConfig {
  baseUrl: string;
  model?: string;
  timeoutMs?: number;
}

export class OllamaEmbeddingAdapter implements EmbeddingAdapter {
  readonly name: string;
  private readonly model: string;

  constructor(private readonly config: OllamaEmbeddingConfig) {
    this.model = config.model ?? "nomic-embed-text";
    this.name = `ollama-embed:${this.model}`;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return false;
      const tags = (await res.json()) as { models?: { name: string }[] };
      return !!tags.models?.some((m) => m.name.startsWith(this.model));
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.config.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embed failed: HTTP ${res.status}`);
    const body = (await res.json()) as { embeddings: number[][] };
    return body.embeddings;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
