/**
 * End-to-end pipeline run with a canned LLM. Proves the plumbing without recordings:
 * chunking, extraction, retrieval, comparison, reverse pass, ignore file, and JSON rendering,
 * and that two runs on identical inputs give byte-identical JSON.
 */
import { describe, expect, it } from "vitest";
import { StaticLlmClient } from "../src/llm/mock.js";
import type { LlmRequest } from "../src/llm/client.js";
import { runPipeline } from "../src/pipeline.js";
import { renderJson, renderReport } from "../src/report/index.js";
import { applyIgnore, parseIgnore } from "../src/ignore.js";

/**
 * Extraction: one claim per section, derived from the heading so it is deterministic and
 * lands on a real schema type. Comparison: confirmed when a candidate id equals a mentioned
 * identifier, otherwise drifted with a stated difference.
 */
function cannedLlm(): StaticLlmClient {
  return new StaticLlmClient((req: LlmRequest) => {
    if (req.purpose === "extract-claims") {
      const section = /Section: (.*)/.exec(req.user)?.[1] ?? "";
      const lineMatch = /^\s*(\d+) \|/m.exec(req.user);
      const line = lineMatch ? Number(lineMatch[1]) : 1;
      const leaf = section.split(" > ").pop() ?? "";
      const claims = [];
      if (/Users/.test(leaf)) claims.push({ text: "There is a User type", claim_type: "type_exists", confidence: 0.9, mentions: ["User"], line_start: line, line_end: line });
      if (/^Orders$/.test(leaf)) claims.push({ text: "Order.placedAt is a String", claim_type: "field_type", confidence: 0.9, mentions: ["Order.placedAt", "String"], line_start: line, line_end: line });
      if (/Behaviour/.test(leaf)) claims.push({ text: "Users can cancel an order until it has shipped", claim_type: "behaviour", confidence: 0.8, mentions: ["Order"], line_start: line, line_end: line });
      if (/Refunds/.test(leaf)) claims.push({ text: "There is a Refund type", claim_type: "type_exists", confidence: 0.9, mentions: ["Refund"], line_start: line, line_end: line });
      return JSON.stringify({ claims });
    }
    if (req.purpose === "compare-claim") {
      const ids = [...req.user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]!);
      const mentioned = /Identifiers mentioned: (.*)/.exec(req.user)?.[1]?.split(", ") ?? [];
      const hit = ids.find((id) => mentioned.includes(id));
      if (/Order\.placedAt/.test(req.user) && /Claim type: field_type/.test(req.user)) {
        return JSON.stringify({ classification: "drifted", matched_fact_ids: ["Order.placedAt"], difference: "placedAt is DateTime!, not String.", confidence: 0.95, rationale: "type differs" });
      }
      if (hit) return JSON.stringify({ classification: "confirmed", matched_fact_ids: [hit], difference: "", confidence: 0.9, rationale: "present" });
      return JSON.stringify({ classification: "unmatched", matched_fact_ids: [], difference: "", confidence: 0.8, rationale: "nothing relevant" });
    }
    throw new Error(`unexpected purpose ${req.purpose}`);
  });
}

const specPath = "fixtures/orders-api/spec.md";
const schemaPath = "fixtures/orders-api/schema.graphql";

describe("pipeline end to end (canned LLM)", () => {
  it("produces a report with every classification and byte-identical JSON across runs", async () => {
    const run = () => runPipeline({ specPath, schemaPath, llm: cannedLlm(), model: "canned", now: () => "fixed" });
    const a = await run();
    const b = await run();

    expect(a.report.summary).toEqual({ confirmed: 1, drifted: 1, unmatched: 1, not_checkable: 1, undocumented: expect.any(Number), suppressed: 0 });
    expect(a.report.claims.map((c) => c.claimType)).toEqual(["type_exists", "field_type", "type_exists", "behaviour"]);
    expect(a.report.verdicts.map((v) => v.classification)).toEqual(["confirmed", "drifted", "unmatched", "not_checkable"]);
    expect(a.report.verdicts[1]!.difference).toBe("placedAt is DateTime!, not String.");
    expect(a.report.undocumented.map((u) => u.factId)).toContain("Order.status");
    expect(a.report.undocumented.map((u) => u.factId)).not.toContain("User");
    expect(a.report.provenance).toMatchObject({ tool: "spec-drift", model: "canned" });

    expect(renderJson(b.report)).toBe(renderJson(a.report));
  });

  it("claims carry real source locations from the spec", async () => {
    const { report } = await runPipeline({ specPath, schemaPath, llm: cannedLlm(), model: "canned", now: () => "fixed" });
    for (const c of report.claims) {
      expect(c.source.file).toBe(specPath);
      expect(c.source.lineStart).toBeGreaterThan(1);
      expect(c.source.headingPath[0]).toBe("Orders API");
    }
  });

  it("renders a terminal report that names the drift and applies an ignore file", async () => {
    const { report } = await runPipeline({ specPath, schemaPath, llm: cannedLlm(), model: "canned", now: () => "fixed" });
    const text = renderReport(report);
    expect(text).toContain("DRIFTED (1)");
    expect(text).toContain("Order.placedAt is a String");
    expect(text).toContain("schema: placedAt is DateTime!, not String.");
    expect(text).toContain("UNMATCHED (1)");
    expect(text).toContain("There is a Refund type");

    const ignored = applyIgnore(report, parseIgnore("text:*Refund*  # refunds not in scope for v1"), "2026-09-05").report;
    const text2 = renderReport(ignored);
    expect(text2).toContain("UNMATCHED (0)");
    expect(text2).toContain("~ unmatched: There is a Refund type  # refunds not in scope for v1");
    expect(ignored.summary.suppressed).toBe(1);
  });
});
