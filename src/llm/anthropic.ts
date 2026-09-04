import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest, LlmResponse } from "./client.js";

export const DEFAULT_MODEL = "claude-opus-5";

export interface AnthropicClientOptions {
  /** Pinned model ID. Never use a floating alias here; determinism depends on it. */
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}

/**
 * Real adapter over the Anthropic SDK. Credentials come from the environment
 * (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
 *
 * Uses structured outputs so the response is guaranteed to match the request's JSON schema,
 * and server-side refusal fallbacks so a policy decline is retried on another model rather
 * than failing the run.
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  readonly model: string;
  private readonly effort: NonNullable<AnthropicClientOptions["effort"]>;
  private readonly maxTokens: number;

  constructor(opts: AnthropicClientOptions = {}) {
    this.client = new Anthropic();
    this.model = opts.model ?? DEFAULT_MODEL;
    this.effort = opts.effort ?? "medium";
    this.maxTokens = opts.maxTokens ?? 16000;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.user }],
      output_config: {
        effort: this.effort,
        ...(req.responseSchema
          ? { format: { type: "json_schema" as const, schema: req.responseSchema as Record<string, unknown> } }
          : {}),
      },
    });

    if (response.stop_reason === "refusal") {
      const detail = response.stop_details && "explanation" in response.stop_details ? response.stop_details.explanation : "";
      throw new Error(`Model refused request for purpose="${req.purpose}"${detail ? `: ${detail}` : ""}`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(`Model hit max_tokens (${this.maxTokens}) for purpose="${req.purpose}"; output is truncated`);
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
      model: response.model,
    };
  }
}
