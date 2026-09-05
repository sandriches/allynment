import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonFileCache, NoopCache } from "./cache.js";
import { compareClaims, findUndocumented, type ClaimTrace } from "./comparator/index.js";
import { extractGraphqlFacts } from "./extractors/code/index.js";
import { chunkMarkdown, extractClaims, PROMPT_VERSION, type SpecChunk } from "./extractors/spec/index.js";
import { COMPARE_PROMPT_VERSION } from "./comparator/index.js";
import type { LlmClient } from "./llm/client.js";
import type { Report, Verdict } from "./types/index.js";

export const TOOL_NAME = "spec-drift";
export const TOOL_VERSION = "0.1.0";

export interface PipelineOptions {
  specPath: string;
  schemaPath: string;
  llm: LlmClient;
  model: string;
  /** Root cache directory. Omit to disable caching. */
  cacheDir?: string;
  retrievalLimit?: number;
  /** Fixed timestamp for the report, for reproducible output in tests. */
  now?: () => string;
  onSection?: (info: { chunk: SpecChunk; claims: number; cached: boolean; inputTokens: number; outputTokens: number }) => void;
  onClaim?: (trace: ClaimTrace) => void;
}

export interface PipelineResult {
  report: Report;
  traces: ClaimTrace[];
  usage: {
    extract: { inputTokens: number; outputTokens: number; llmCalls: number; cachedSections: number };
    compare: { inputTokens: number; outputTokens: number; llmCalls: number; cachedVerdicts: number; ruleVerdicts: number };
  };
}

/** Run extract, compare, and the reverse pass, producing a Report. Report rendering is a separate concern. */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const claimCache = opts.cacheDir ? new JsonFileCache(join(opts.cacheDir, "claims")) : new NoopCache();
  const verdictCache = opts.cacheDir ? new JsonFileCache(join(opts.cacheDir, "verdicts")) : new NoopCache();

  const facts = extractGraphqlFacts(readFileSync(opts.schemaPath, "utf8"), opts.schemaPath);
  const chunks = chunkMarkdown(readFileSync(opts.specPath, "utf8"), opts.specPath);

  const extracted = await extractClaims(chunks, {
    llm: opts.llm,
    model: opts.model,
    cache: claimCache,
    ...(opts.onSection ? { onSection: opts.onSection } : {}),
  });

  const compared = await compareClaims(extracted.claims, facts, {
    llm: opts.llm,
    model: opts.model,
    cache: verdictCache,
    ...(opts.retrievalLimit ? { retrieval: { limit: opts.retrievalLimit } } : {}),
    ...(opts.onClaim ? { onClaim: opts.onClaim } : {}),
  });

  const undocumented = findUndocumented(facts, compared.verdicts);

  const report: Report = {
    generatedAt: (opts.now ?? (() => new Date().toISOString()))(),
    provenance: {
      tool: TOOL_NAME,
      version: TOOL_VERSION,
      model: opts.model,
      extractPromptVersion: PROMPT_VERSION,
      comparePromptVersion: COMPARE_PROMPT_VERSION,
    },
    spec: opts.specPath,
    sources: [opts.schemaPath],
    claims: extracted.claims,
    facts,
    verdicts: compared.verdicts,
    undocumented,
    summary: summarise(compared.verdicts, undocumented.length),
  };

  return { report, traces: compared.traces, usage: { extract: extracted.usage, compare: compared.usage } };
}

export function summarise(verdicts: Verdict[], undocumentedCount: number): Report["summary"] {
  const s: Report["summary"] = { confirmed: 0, drifted: 0, unmatched: 0, not_checkable: 0, undocumented: undocumentedCount, suppressed: 0 };
  for (const v of verdicts) {
    s[v.classification]++;
    if (v.suppressed) s.suppressed++;
  }
  return s;
}
