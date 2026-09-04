/**
 * End-to-end eval: run the full pipeline on each fixture against recorded LLM responses and score
 * the verdicts against expected.json. Reports precision and recall per classification.
 *
 * Bars:
 *  - orders-api-clean: no drifted or unmatched verdicts at all (any is a false positive).
 *  - orders-api: every expected drifted claim is classified drifted, every expected classification matches.
 *
 * Skipped when a fixture has no recordings for the current prompts.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockLlmClient } from "../src/llm/mock.js";
import { DEFAULT_MODEL } from "../src/llm/anthropic.js";
import { buildRequest, chunkMarkdown } from "../src/extractors/spec/index.js";
import { runPipeline } from "../src/pipeline.js";
import type { Classification } from "../src/types/index.js";
import { matchClaims, type ExpectedClaim } from "./eval/match.js";

interface Expected {
  spec: string;
  schema: string;
  claims: ExpectedClaim[];
  undocumentedIncludes?: string[];
}

const CLASSES: Classification[] = ["confirmed", "drifted", "unmatched", "not_checkable"];

const FIXTURES = "fixtures";
const fixtureDirs = readdirSync(FIXTURES)
  .map((n) => join(FIXTURES, n))
  .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "expected.json")));

function prf(rows: { expected: Classification; actual: Classification }[]): string {
  const lines = ["class           precision  recall   n"];
  for (const c of CLASSES) {
    const tp = rows.filter((r) => r.expected === c && r.actual === c).length;
    const fp = rows.filter((r) => r.expected !== c && r.actual === c).length;
    const fn = rows.filter((r) => r.expected === c && r.actual !== c).length;
    const p = tp + fp === 0 ? 1 : tp / (tp + fp);
    const rc = tp + fn === 0 ? 1 : tp / (tp + fn);
    lines.push(`${c.padEnd(16)}${p.toFixed(2).padStart(8)}${rc.toFixed(2).padStart(9)}${String(tp + fn).padStart(4)}`);
  }
  return lines.join("\n");
}

for (const dir of fixtureDirs) {
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;
  const specPath = resolve(dir, expected.spec);
  const schemaPath = resolve(dir, expected.schema);
  const recordingsDir = join(dir, "recordings");
  const mock = new MockLlmClient(recordingsDir);

  // Extraction recordings are checkable up front. Comparison recordings depend on extraction output,
  // so a missing one surfaces as a thrown MockLlmClient error inside the test with a clear message.
  const chunks = chunkMarkdown(readFileSync(specPath, "utf8"), specPath);
  const hasExtractRecordings = chunks.filter((c) => c.body.trim() !== "").every((c) => mock.has(buildRequest(c)));

  describe.skipIf(!hasExtractRecordings)(`pipeline eval: ${dir}`, () => {
    it("classifies every labelled claim as expected", async () => {
      const { report, traces } = await runPipeline({ specPath, schemaPath, llm: mock, model: DEFAULT_MODEL, now: () => "fixed" });
      const verdictByClaim = new Map(report.verdicts.map((v) => [v.claimId, v]));
      const matches = matchClaims(expected.claims, report.claims);

      const rows: { expected: Classification; actual: Classification }[] = [];
      const problems: string[] = [];
      for (const m of matches) {
        if (!m.matched) {
          problems.push(`MISSING claim: ${m.expected.text}`);
          continue;
        }
        const v = verdictByClaim.get(m.matched.id)!;
        rows.push({ expected: m.expected.expected, actual: v.classification });
        if (v.classification !== m.expected.expected) {
          const trace = traces.find((t) => t.claim.id === m.matched!.id)!;
          problems.push(
            `WRONG ${m.expected.expected} -> ${v.classification}: "${m.matched.text}"` +
              (v.difference ? `\n      difference: ${v.difference}` : "") +
              (v.rationale ? `\n      rationale: ${v.rationale}` : "") +
              `\n      candidates: ${trace.candidates.map((c) => c.fact.id).join(", ")}`,
          );
        } else if (m.expected.factIds?.length && !m.expected.factIds.some((id) => v.matchedFactIds.includes(id))) {
          problems.push(`CITATION "${m.matched.text}": expected one of ${m.expected.factIds.join(", ")}, got ${v.matchedFactIds.join(", ") || "(none)"}`);
        }
      }

      const undocumented = new Set(report.undocumented.map((u) => u.factId));
      for (const id of expected.undocumentedIncludes ?? []) {
        if (!undocumented.has(id)) problems.push(`UNDOCUMENTED missing: ${id}`);
      }

      console.log(`\n${dir}\n${prf(rows)}\nsummary: ${JSON.stringify(report.summary)}\n${problems.join("\n")}\n`);

      if (dir.endsWith("-clean")) {
        expect(report.summary.drifted, "false positive drift on clean fixture").toBe(0);
        expect(report.summary.unmatched, "false positive unmatched on clean fixture").toBe(0);
      }
      expect(problems).toEqual([]);
    });

    it("produces the same report on a second run", async () => {
      const a = await runPipeline({ specPath, schemaPath, llm: mock, model: DEFAULT_MODEL, now: () => "fixed" });
      const b = await runPipeline({ specPath, schemaPath, llm: mock, model: DEFAULT_MODEL, now: () => "fixed" });
      expect(JSON.stringify(b.report)).toBe(JSON.stringify(a.report));
    });
  });

  if (!hasExtractRecordings) {
    describe(`pipeline eval: ${dir}`, () => {
      it.skip(`no recordings; run: npx tsx src/cli/index.ts record-fixtures --only ${dir.split("/").pop()}`, () => {});
    });
  }
}
