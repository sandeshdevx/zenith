/**
 * LLM adapter boundary (TRD §9: wrap each vendor behind an adapter interface).
 * Business logic depends on LlmAdapter only — swapping Mistral for Qwen/Gemma,
 * or Ollama for another open-source runtime, must never touch product code.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatStreamOptions {
  signal?: AbortSignal;
  /** Called for each generated token/fragment as it arrives. */
  onToken?: (fragment: string) => void;
}

export interface LlmAdapter {
  readonly name: string;
  /** Streams a completion; resolves with the full response text. */
  chatStream(messages: ChatMessage[], options?: ChatStreamOptions): Promise<string>;
  healthCheck(): Promise<boolean>;
}

export interface OllamaAdapterConfig {
  baseUrl: string;
  model: string;
  /** Cap on generated tokens — buddy replies should be short and warm. */
  numPredict?: number;
  timeoutMs?: number;
  /** GPU layers; set 0 to force CPU inference (e.g. broken CUDA drivers). */
  numGpu?: number;
}

/** Ollama runtime (free, open source) — serves Mistral/Llama/Qwen/Gemma etc. */
export class OllamaLlmAdapter implements LlmAdapter {
  readonly name: string;

  constructor(private readonly config: OllamaAdapterConfig) {
    this.name = `ollama:${config.model}`;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async chatStream(messages: ChatMessage[], options: ChatStreamOptions = {}): Promise<string> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 120_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;

    const res = await fetch(`${this.config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: true,
        options: {
          num_predict: this.config.numPredict ?? 200,
          ...(this.config.numGpu !== undefined ? { num_gpu: this.config.numGpu } : {}),
        },
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama chat failed: HTTP ${res.status}`);
    }

    // Ollama streams newline-delimited JSON objects.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let full = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
          error?: string;
        };
        if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
        const fragment = chunk.message?.content ?? "";
        if (fragment) {
          full += fragment;
          options.onToken?.(fragment);
        }
      }
    }
    return full;
  }
}
