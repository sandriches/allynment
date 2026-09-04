import { JsonFileCache, NoopCache } from "../cache.js";
import type { LlmClient, LlmRequest } from "../llm/client.js";
import { sha256 } from "../llm/hash.js";
import { isCheckable, type Claim, type CodeFact, type Verdict } from "../types/index.js";
import { COMPARE_PROMPT_VERSION, COMPARE_PURPOSE, COMPARE_RESPONSE_SCHEMA, COMPARE_SYSTEM_PROMPT, buildCompareUserPrompt } from "./prompt.js";
import { buildFactIndex, retrieve, type Candidate, type FactIndex, type RetrievalOptions } from "./retrieval.js";

export interface CompareOptions {
  llm: LlmClient;
  /** Model name, used only as part of the cache key. */
  model: string;
  cache?: JsonFileCache;
  retrieval?: RetrievalOptions;
  /** Called after each claim, for progress and candidate logging. */
  onClaim?: (trace: ClaimTrace) => void;
}

/** Everything that happened for one claim. Kept for verbose logs and debugging retrieval misses. */
export interface ClaimTrace {
  claim: Claim;
  candidates: Candidate[];
  verdict: Verdict;
  /** "llm" when the model was called, "cache" when a verdict was replayed, "rule" when no model was needed. */
  decidedBy: "llm" | "cache" | "rule";
  inputTokens: number;
  outputTokens: number;
}

export interface CompareResult {
  verdicts: Verdict[];
  traces: ClaimTrace[];
  usage: { inputTokens: number; outputTokens: number; llmCalls: number; cachedVerdicts: number; ruleVerdicts: number };
}

interface RawVerdict {
  classification: "confirmed" | "drifted" | "unmatched";
  matched_fact_ids: string[];
  difference: string;
  confidence: number;
  rationale: string;
}

export function buildCompareRequest(claim: Claim, candidates: Candidate[], index: FactIndex): LlmRequest {
  return {
    purpose: COMPARE_PURPOSE,
    system: COMPARE_SYSTEM_PROMPT,
    user: buildCompareUserPrompt(claim, candidates, index),
    responseSchema: COMPARE_RESPONSE_SCHEMA,
  };
}

/** Cache key: prompt version, model, the claim's text and type, and the exact candidate facts shown. */
export function verdictCacheKey(model: string, claim: Claim, candidates: Candidate[]): string {
  const factHashes = candidates.map((c) => sha256(JSON.stringify(c.fact)));
  return sha256(COMPARE_PROMPT_VERSION, model, claim.claimType, claim.text, ...factHashes);
}

export async function compareClaims(claims: Claim[], facts: CodeFact[], opts: CompareOptions): Promise<CompareResult> {
  const cache = opts.cache ?? new NoopCache();
  const index = buildFactIndex(facts);
  const verdicts: Verdict[] = [];
  const traces: ClaimTrace[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, llmCalls: 0, cachedVerdicts: 0, ruleVerdicts: 0 };

  for (const claim of claims) {
    let trace: ClaimTrace;

    if (!isCheckable(claim.claimType)) {
      usage.ruleVerdicts++;
      trace = {
        claim,
        candidates: [],
        verdict: ruleVerdict(claim, "not_checkable", 1),
        decidedBy: "rule",
        inputTokens: 0,
        outputTokens: 0,
      };
    } else {
      const candidates = retrieve(claim, index, opts.retrieval);
      if (candidates.length === 0) {
        usage.ruleVerdicts++;
        trace = {
          claim,
          candidates,
          verdict: ruleVerdict(claim, "unmatched", 0.9),
          decidedBy: "rule",
          inputTokens: 0,
          outputTokens: 0,
        };
      } else {
        const key = verdictCacheKey(opts.model, claim, candidates);
        let raw = cache.get<RawVerdict>(key);
        let decidedBy: ClaimTrace["decidedBy"] = "cache";
        let inputTokens = 0;
        let outputTokens = 0;
        if (raw) {
          usage.cachedVerdicts++;
        } else {
          decidedBy = "llm";
          const res = await opts.llm.complete(buildCompareRequest(claim, candidates, index));
          usage.llmCalls++;
          inputTokens = res.inputTokens;
          outputTokens = res.outputTokens;
          usage.inputTokens += inputTokens;
          usage.outputTokens += outputTokens;
          raw = parseVerdict(res.text);
          cache.set(key, raw);
        }
        trace = { claim, candidates, verdict: toVerdict(claim, raw, candidates), decidedBy, inputTokens, outputTokens };
      }
    }

    verdicts.push(trace.verdict);
    traces.push(trace);
    opts.onClaim?.(trace);
  }

  return { verdicts, traces, usage };
}

function ruleVerdict(claim: Claim, classification: Verdict["classification"], confidence: number): Verdict {
  return { claimId: claim.id, classification, matchedFactIds: [], confidence, suppressed: false };
}

export function parseVerdict(text: string): RawVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Comparison returned invalid JSON: ${(e as Error).message}\n${text.slice(0, 500)}`);
  }
  const v = parsed as Partial<RawVerdict>;
  if (!v || typeof v !== "object" || !["confirmed", "drifted", "unmatched"].includes(v.classification as string)) {
    throw new Error(`Comparison returned unexpected shape: ${text.slice(0, 500)}`);
  }
  return {
    classification: v.classification as RawVerdict["classification"],
    matched_fact_ids: Array.isArray(v.matched_fact_ids) ? v.matched_fact_ids.filter((x): x is string => typeof x === "string") : [],
    difference: typeof v.difference === "string" ? v.difference.trim() : "",
    confidence: typeof v.confidence === "number" && Number.isFinite(v.confidence) ? v.confidence : 0.5,
    rationale: typeof v.rationale === "string" ? v.rationale.trim() : "",
  };
}

/**
 * Turn a raw model verdict into a Verdict, enforcing the invariants the prompt asks for:
 * cited fact IDs must be candidates, drifted needs a difference, unmatched cites nothing.
 */
export function toVerdict(claim: Claim, raw: RawVerdict, candidates: Candidate[]): Verdict {
  const allowed = new Set(candidates.map((c) => c.fact.id));
  let matched = [...new Set(raw.matched_fact_ids.filter((id) => allowed.has(id)))].sort();
  let confidence = Math.min(1, Math.max(0, raw.confidence));
  let classification = raw.classification;
  let difference = raw.difference;

  if (classification === "unmatched") {
    matched = [];
  } else if (matched.length === 0) {
    // The model confirmed or drifted without citing any candidate. Downgrade confidence rather than trust it blindly.
    confidence = Math.min(confidence, 0.4);
  }

  if (classification === "drifted" && difference === "") {
    difference = "(model did not state the difference)";
    confidence = Math.min(confidence, 0.4);
  }
  if (classification !== "drifted") difference = "";

  const verdict: Verdict = { claimId: claim.id, classification, matchedFactIds: matched, confidence, suppressed: false };
  if (difference) verdict.difference = difference;
  if (raw.rationale) verdict.rationale = raw.rationale;
  return verdict;
}
