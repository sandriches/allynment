import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { LlmClient, LlmRequest, LlmResponse } from "./client.js";
import { sha256 } from "./hash.js";

interface Recording {
  purpose: string;
  requestHash: string;
  response: LlmResponse;
}

/**
 * Replays recorded LLM responses from a directory. Throws on a miss so a test
 * can never silently hit the network. Wrap a real client with `record` to capture.
 */
export class MockLlmClient implements LlmClient {
  constructor(private readonly dir: string) {}

  static keyFor(req: LlmRequest): string {
    return sha256(req.purpose, req.system, req.user, JSON.stringify(req.responseSchema ?? null));
  }

  private pathFor(req: LlmRequest): string {
    return join(this.dir, req.purpose, `${MockLlmClient.keyFor(req)}.json`);
  }

  /** True if a recording exists for this exact request. */
  has(req: LlmRequest): boolean {
    return existsSync(this.pathFor(req));
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const p = this.pathFor(req);
    if (!existsSync(p)) {
      throw new Error(
        `MockLlmClient: no recording for purpose="${req.purpose}" at ${p}. ` +
          `Run with a recording client to capture it.`,
      );
    }
    const rec = JSON.parse(readFileSync(p, "utf8")) as Recording;
    return rec.response;
  }

  /** Returns a client that calls `inner` and writes each response into this mock's directory. */
  record(inner: LlmClient): LlmClient {
    return {
      complete: async (req) => {
        const response = await inner.complete(req);
        const p = this.pathFor(req);
        mkdirSync(dirname(p), { recursive: true });
        const rec: Recording = { purpose: req.purpose, requestHash: MockLlmClient.keyFor(req), response };
        writeFileSync(p, JSON.stringify(rec, null, 2) + "\n");
        return response;
      },
    };
  }
}

/** In-memory client for unit tests that need a canned answer. */
export class StaticLlmClient implements LlmClient {
  constructor(private readonly responder: (req: LlmRequest) => string) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    return { text: this.responder(req), inputTokens: 0, outputTokens: 0, model: "static" };
  }
}
