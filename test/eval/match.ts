import type { Claim, ClaimType } from "../../src/types/index.js";

export interface ExpectedClaim {
  text: string;
  claimType: ClaimType;
  headingPath: string[];
  expected: "confirmed" | "drifted" | "unmatched" | "not_checkable";
  factIds?: string[];
  differenceHint?: string;
}

export type MatchStatus = "found" | "wrong_type" | "missing";

export interface MatchResult {
  expected: ExpectedClaim;
  status: MatchStatus;
  matched?: Claim;
  score: number;
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "be", "has", "have", "of", "on", "in", "to", "and", "or", "for", "with", "by", "at",
  "it", "its", "this", "that", "there", "which", "as", "can", "will", "was", "were", "type", "field", "value", "values",
  "query", "mutation", "includes", "include", "accepts", "accept", "argument", "arguments",
]);

/** Lowercased content words, with dotted identifiers split so "Order.status" also yields "order" and "status". */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.split(/[^A-Za-z0-9_.]+/)) {
    if (!tok) continue;
    for (const part of tok.split(".")) {
      const w = part.toLowerCase();
      if (w && !STOPWORDS.has(w)) out.add(w);
    }
  }
  return out;
}

/** Identifier-looking tokens: contain a capital letter, an underscore, or a dot. Lowercased for comparison. */
export function identifiers(text: string, factIds: string[] = []): Set<string> {
  const out = new Set<string>();
  for (const tok of text.split(/[^A-Za-z0-9_.]+/)) {
    if (!/[A-Z_.]/.test(tok)) continue;
    for (const part of tok.split(".")) {
      const w = part.toLowerCase();
      if (w && !STOPWORDS.has(w)) out.add(w);
    }
  }
  for (const id of factIds) for (const part of id.split(/[.()]/)) if (part) out.add(part.toLowerCase());
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Score how well an extracted claim matches an expected one, ignoring claim type. */
export function score(expected: ExpectedClaim, claim: Claim): number {
  if (!samePath(expected.headingPath, claim.source.headingPath)) return 0;
  const ew = words(expected.text);
  const cw = new Set([...words(claim.text), ...claim.mentions.flatMap((m) => [...words(m)])]);
  const overlap = jaccard(ew, cw);

  const ids = identifiers(expected.text, expected.factIds);
  let idHits = 0;
  for (const id of ids) if (cw.has(id)) idHits++;
  const idScore = ids.size === 0 ? overlap : idHits / ids.size;

  return 0.5 * overlap + 0.5 * idScore;
}

/**
 * Match each expected claim to the best extracted claim in the same section.
 * Each extracted claim can satisfy at most one expected claim.
 */
export function matchClaims(expected: ExpectedClaim[], extracted: Claim[], threshold = 0.45): MatchResult[] {
  const used = new Set<string>();
  const results: MatchResult[] = [];

  // Greedy: process expected claims in order of their best available score, highest first.
  const pending = expected.map((e) => ({ e, best: null as { claim: Claim; s: number } | null }));
  const remaining = [...pending];
  while (remaining.length > 0) {
    for (const p of remaining) {
      p.best = null;
      for (const c of extracted) {
        if (used.has(c.id)) continue;
        const s = score(p.e, c);
        if (s > (p.best?.s ?? -1)) p.best = { claim: c, s };
      }
    }
    remaining.sort((a, b) => (b.best?.s ?? 0) - (a.best?.s ?? 0));
    const top = remaining.shift()!;
    if (top.best && top.best.s >= threshold) {
      used.add(top.best.claim.id);
      results.push({
        expected: top.e,
        status: top.best.claim.claimType === top.e.claimType ? "found" : "wrong_type",
        matched: top.best.claim,
        score: top.best.s,
      });
    } else {
      results.push({ expected: top.e, status: "missing", score: top.best?.s ?? 0 });
    }
  }

  return results;
}

export function renderMatchTable(results: MatchResult[], extracted: Claim[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const tag = r.status === "found" ? "OK  " : r.status === "wrong_type" ? "TYPE" : "MISS";
    lines.push(`${tag} [${r.expected.claimType}] ${r.expected.text}`);
    if (r.matched) lines.push(`       -> [${r.matched.claimType}] ${r.matched.text}  (score ${r.score.toFixed(2)})`);
  }
  const matchedIds = new Set(results.map((r) => r.matched?.id).filter(Boolean));
  const extra = extracted.filter((c) => !matchedIds.has(c.id));
  if (extra.length > 0) {
    lines.push("");
    lines.push(`Extracted but not expected (${extra.length}):`);
    for (const c of extra) lines.push(`     [${c.claimType}] ${c.text}  (${c.source.headingPath.join(" > ")})`);
  }
  return lines.join("\n");
}
