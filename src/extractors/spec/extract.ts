import type { LlmClient, LlmRequest } from "../../llm/client.js";
import { sha256, shortHash } from "../../llm/hash.js";
import { JsonFileCache, NoopCache } from "../../cache.js";
import { CLAIM_TYPES, type Claim, type ClaimType } from "../../types/index.js";
import type { SpecChunk } from "./markdown.js";
import { EXTRACT_PURPOSE, PROMPT_VERSION, RESPONSE_SCHEMA, SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";

export interface ExtractOptions {
  llm: LlmClient;
  /** Model name, used only as part of the cache key. The LlmClient decides what actually runs. */
  model: string;
  cache?: JsonFileCache;
  /** Called after each section is processed, for progress output. */
  onSection?: (info: { chunk: SpecChunk; claims: number; cached: boolean; inputTokens: number; outputTokens: number }) => void;
}

export interface ExtractResult {
  claims: Claim[];
  usage: { inputTokens: number; outputTokens: number; llmCalls: number; cachedSections: number };
}

/** Raw shape the model returns for one claim, before validation. */
interface RawClaim {
  text: string;
  claim_type: string;
  confidence: number;
  mentions: string[];
  line_start: number;
  line_end: number;
}

interface RawResponse {
  claims: RawClaim[];
}

/** Build the LLM request for one chunk. Exposed so tests can check for recordings. */
export function buildRequest(chunk: SpecChunk): LlmRequest {
  return {
    purpose: EXTRACT_PURPOSE,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(chunk),
    responseSchema: RESPONSE_SCHEMA,
  };
}

/**
 * Cache key for one section. Prompt version, model, heading path and body text.
 * The file path is deliberately excluded so a renamed spec still hits.
 */
export function claimCacheKey(model: string, chunk: SpecChunk): string {
  return sha256(PROMPT_VERSION, model, chunk.headingPath.join(" "), chunk.body);
}

export async function extractClaims(chunks: SpecChunk[], opts: ExtractOptions): Promise<ExtractResult> {
  const cache = opts.cache ?? new NoopCache();
  const claims: Claim[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, llmCalls: 0, cachedSections: 0 };

  for (const chunk of chunks) {
    if (chunk.body.trim() === "") continue;

    const key = claimCacheKey(opts.model, chunk);
    let raw = cache.get<RawClaim[]>(key);
    let cached = true;
    let inputTokens = 0;
    let outputTokens = 0;

    if (!raw) {
      cached = false;
      const res = await opts.llm.complete(buildRequest(chunk));
      usage.llmCalls++;
      inputTokens = res.inputTokens;
      outputTokens = res.outputTokens;
      usage.inputTokens += inputTokens;
      usage.outputTokens += outputTokens;
      raw = parseResponse(res.text).claims;
      cache.set(key, raw);
    } else {
      usage.cachedSections++;
    }

    const built = raw.map((r) => toClaim(r, chunk)).filter((c): c is Claim => c !== null);
    claims.push(...built);
    opts.onSection?.({ chunk, claims: built.length, cached, inputTokens, outputTokens });
  }

  claims.sort((a, b) => a.source.lineStart - b.source.lineStart || (a.id < b.id ? -1 : 1));
  return { claims, usage };
}

export function parseResponse(text: string): RawResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Claim extraction returned invalid JSON: ${(e as Error).message}\n${text.slice(0, 500)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as RawResponse).claims)) {
    throw new Error(`Claim extraction returned unexpected shape: ${text.slice(0, 500)}`);
  }
  return parsed as RawResponse;
}

function isClaimType(s: string): s is ClaimType {
  return (CLAIM_TYPES as readonly string[]).includes(s);
}

/** Validate a raw claim and attach source location. Returns null for claims that fail validation. */
export function toClaim(raw: RawClaim, chunk: SpecChunk): Claim | null {
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (text === "" || !isClaimType(raw.claim_type)) return null;

  const confidence = clamp(Number.isFinite(raw.confidence) ? raw.confidence : 0.5, 0, 1);

  // Line numbers are model-reported. Clamp them to the chunk so a hallucinated line can't point elsewhere.
  const lineStart = clamp(Math.trunc(raw.line_start) || chunk.lineStart, chunk.lineStart, chunk.lineEnd);
  const lineEnd = clamp(Math.trunc(raw.line_end) || lineStart, lineStart, chunk.lineEnd);

  const mentions = Array.isArray(raw.mentions)
    ? [...new Set(raw.mentions.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim()))]
    : [];

  return {
    id: shortHash(text, raw.claim_type, chunk.headingPath.join(">")),
    text,
    claimType: raw.claim_type,
    confidence,
    source: { file: chunk.file, headingPath: chunk.headingPath, lineStart, lineEnd },
    mentions,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
