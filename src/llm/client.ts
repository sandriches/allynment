/**
 * Thin LLM adapter. Everything that talks to a model goes through this interface
 * so the provider can be swapped and tests can run against recorded responses.
 */

export interface LlmRequest {
  /** Logical name of the prompt, e.g. "extract-claims". Part of the cache key. */
  purpose: string;
  system: string;
  user: string;
  /** JSON Schema the response must conform to. */
  responseSchema?: object;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}
