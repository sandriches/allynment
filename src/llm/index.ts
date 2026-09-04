import { AnthropicLlmClient, DEFAULT_MODEL, type AnthropicClientOptions } from "./anthropic.js";
import type { LlmClient } from "./client.js";
import { MockLlmClient } from "./mock.js";

export type { LlmClient, LlmRequest, LlmResponse } from "./client.js";
export { AnthropicLlmClient, DEFAULT_MODEL } from "./anthropic.js";
export { MockLlmClient, StaticLlmClient } from "./mock.js";

export interface LlmFactoryOptions {
  /** "anthropic" calls the API. "mock" replays recordings and never touches the network. */
  provider: "anthropic" | "mock";
  /** Directory of recordings. Required for mock; with anthropic + record, responses are written here. */
  recordingsDir?: string;
  /** With provider anthropic, also write every response into recordingsDir. */
  record?: boolean;
  model?: string;
  effort?: AnthropicClientOptions["effort"];
}

export function createLlmClient(opts: LlmFactoryOptions): { client: LlmClient; model: string } {
  const model = opts.model ?? DEFAULT_MODEL;

  if (opts.provider === "mock") {
    if (!opts.recordingsDir) throw new Error("mock provider requires a recordings directory");
    return { client: new MockLlmClient(opts.recordingsDir), model };
  }

  const anthropicOpts: AnthropicClientOptions = { model };
  if (opts.effort) anthropicOpts.effort = opts.effort;
  const real = new AnthropicLlmClient(anthropicOpts);
  if (opts.record) {
    if (!opts.recordingsDir) throw new Error("--record requires a recordings directory");
    return { client: new MockLlmClient(opts.recordingsDir).record(real), model };
  }
  return { client: real, model };
}
