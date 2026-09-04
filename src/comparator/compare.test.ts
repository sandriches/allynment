import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { JsonFileCache } from "../cache.js";
import { extractGraphqlFacts } from "../extractors/code/graphql.js";
import { StaticLlmClient } from "../llm/mock.js";
import type { LlmRequest } from "../llm/client.js";
import type { Claim, ClaimType } from "../types/index.js";
import { compareClaims, parseVerdict, toVerdict, verdictCacheKey } from "./compare.js";
import { buildFactIndex, retrieve } from "./retrieval.js";

const facts = extractGraphqlFacts(readFileSync("fixtures/orders-api/schema.graphql", "utf8"), "schema.graphql");
const index = buildFactIndex(facts);

function claim(text: string, claimType: ClaimType, mentions: string[] = []): Claim {
  return { id: `id:${text}`, text, claimType, confidence: 1, mentions, source: { file: "s", headingPath: ["A"], lineStart: 1, lineEnd: 1 } };
}

const ok = (over: Partial<Record<string, unknown>> = {}) =>
  JSON.stringify({ classification: "confirmed", matched_fact_ids: ["Order.status"], difference: "", confidence: 0.9, rationale: "present", ...over });

describe("toVerdict", () => {
  const c = claim("Order has a status field", "field_exists", ["Order", "status"]);
  const candidates = retrieve(c, index);

  it("keeps only cited ids that were candidates, sorted", () => {
    const v = toVerdict(c, parseVerdict(ok({ matched_fact_ids: ["Order.status", "Nope.thing", "Order"] })), candidates);
    expect(v.matchedFactIds).toEqual(["Order", "Order.status"]);
    expect(v.classification).toBe("confirmed");
    expect(v.difference).toBeUndefined();
    expect(v.rationale).toBe("present");
  });

  it("downgrades confidence when confirmed cites nothing valid", () => {
    const v = toVerdict(c, parseVerdict(ok({ matched_fact_ids: ["Nope"] })), candidates);
    expect(v.matchedFactIds).toEqual([]);
    expect(v.confidence).toBeLessThanOrEqual(0.4);
  });

  it("requires a difference for drifted and flags its absence", () => {
    const v = toVerdict(c, parseVerdict(ok({ classification: "drifted", difference: "" })), candidates);
    expect(v.classification).toBe("drifted");
    expect(v.difference).toMatch(/did not state/);
    expect(v.confidence).toBeLessThanOrEqual(0.4);
  });

  it("clears matched ids and difference for unmatched", () => {
    const v = toVerdict(c, parseVerdict(ok({ classification: "unmatched", difference: "x" })), candidates);
    expect(v.matchedFactIds).toEqual([]);
    expect(v.difference).toBeUndefined();
  });

  it("clamps confidence", () => {
    expect(toVerdict(c, parseVerdict(ok({ confidence: 4 })), candidates).confidence).toBe(1);
  });
});

describe("parseVerdict", () => {
  it("rejects bad input", () => {
    expect(() => parseVerdict("nope")).toThrow(/invalid JSON/);
    expect(() => parseVerdict('{"classification":"maybe"}')).toThrow(/unexpected shape/);
  });
});

describe("compareClaims", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spec-drift-verdicts-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("classifies non-checkable claims by rule without calling the model", async () => {
    let calls = 0;
    const llm = new StaticLlmClient(() => {
      calls++;
      return ok();
    });
    const res = await compareClaims([claim("Users get an email", "behaviour"), claim("Max 50 items", "limit_or_policy")], facts, { llm, model: "m" });
    expect(calls).toBe(0);
    expect(res.verdicts.map((v) => v.classification)).toEqual(["not_checkable", "not_checkable"]);
    expect(res.usage.ruleVerdicts).toBe(2);
    expect(res.traces.every((t) => t.decidedBy === "rule")).toBe(true);
  });

  it("classifies claims with no candidates as unmatched by rule", async () => {
    let calls = 0;
    const llm = new StaticLlmClient(() => {
      calls++;
      return ok();
    });
    const res = await compareClaims([claim("Widgets sparkle", "type_exists", ["Widget"])], facts, { llm, model: "m" });
    expect(calls).toBe(0);
    expect(res.verdicts[0]!.classification).toBe("unmatched");
    expect(res.traces[0]!.candidates).toEqual([]);
  });

  it("calls the model with candidate cards for checkable claims", async () => {
    const seen: LlmRequest[] = [];
    const llm = new StaticLlmClient((req) => {
      seen.push(req);
      return ok();
    });
    const res = await compareClaims([claim("Order has a status field", "field_exists", ["Order", "status"])], facts, { llm, model: "m" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.purpose).toBe("compare-claim");
    expect(seen[0]!.user).toContain("Claim: Order has a status field");
    expect(seen[0]!.user).toContain("[Order.status]");
    expect(seen[0]!.user).toContain("other fields on Order");
    expect(res.verdicts[0]).toMatchObject({ classification: "confirmed", matchedFactIds: ["Order.status"] });
    expect(res.traces[0]!.decidedBy).toBe("llm");
  });

  it("replays verdicts from the cache", async () => {
    let calls = 0;
    const llm = new StaticLlmClient(() => {
      calls++;
      return ok();
    });
    const cache = new JsonFileCache(dir);
    const c = [claim("Order has a status field", "field_exists", ["Order", "status"])];
    const a = await compareClaims(c, facts, { llm, model: "m", cache });
    const b = await compareClaims(c, facts, { llm, model: "m", cache });
    expect(calls).toBe(1);
    expect(b.usage.cachedVerdicts).toBe(1);
    expect(JSON.stringify(b.verdicts)).toBe(JSON.stringify(a.verdicts));
  });

  it("changes the cache key when a candidate fact changes", () => {
    const c = claim("Order has a status field", "field_exists", ["Order", "status"]);
    const cands = retrieve(c, index);
    const k1 = verdictCacheKey("m", c, cands);
    const altered = cands.map((x, i) => (i === 0 ? { ...x, fact: { ...x.fact, description: "changed" } } : x));
    expect(verdictCacheKey("m", c, altered)).not.toBe(k1);
    expect(verdictCacheKey("other-model", c, cands)).not.toBe(k1);
  });

  it("reports a trace for every claim in order", async () => {
    const llm = new StaticLlmClient(() => ok());
    const seen: string[] = [];
    await compareClaims(
      [claim("Users get an email", "behaviour"), claim("Order has a status field", "field_exists", ["Order", "status"])],
      facts,
      { llm, model: "m", onClaim: (t) => seen.push(`${t.claim.claimType}:${t.decidedBy}:${t.verdict.classification}`) },
    );
    expect(seen).toEqual(["behaviour:rule:not_checkable", "field_exists:llm:confirmed"]);
  });
});
