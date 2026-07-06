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

export interface OpenAICompatConfig {
  /** e.g. https://api.groq.com/openai/v1, Gemini's OpenAI mode, or a local vLLM/llama.cpp server */
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Any OpenAI-compatible chat endpoint: Groq, Gemini's OpenAI mode, OpenRouter,
 * Mistral La Plateforme — or local vLLM/llama.cpp servers. Lets operators
 * trade the fully-local default for hosted speed with one config change.
 * NOTE: a hosted provider sees conversation text (no identity attached);
 * crisis detection stays local regardless of this choice.
 */
export class OpenAICompatLlmAdapter implements LlmAdapter {
  readonly name: string;

  constructor(private readonly config: OpenAICompatConfig) {
    this.name = `openai-compat:${config.model}`;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async chatStream(messages: ChatMessage[], options: ChatStreamOptions = {}): Promise<string> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    const res = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: true,
        max_tokens: this.config.maxTokens ?? 300,
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`chat completions failed: HTTP ${res.status}`);
    }

    // Server-sent events: lines of "data: {json}" ending with "data: [DONE]".
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
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return full;
        const chunk = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const fragment = chunk.choices?.[0]?.delta?.content ?? "";
        if (fragment) {
          full += fragment;
          options.onToken?.(fragment);
        }
      }
    }
    return full;
  }
}
