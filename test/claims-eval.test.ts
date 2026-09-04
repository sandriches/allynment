/**
 * Eval: does the spec extractor find every labelled claim in each fixture with the right type?
 *
 * Runs against recorded LLM responses under <fixture>/recordings. If a fixture has no
 * recordings for the current prompt, its tests are skipped with a pointer to the record command.
 * Recordings are keyed on the full request, so changing the prompt requires re-recording.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockLlmClient } from "../src/llm/mock.js";
import { DEFAULT_MODEL } from "../src/llm/anthropic.js";
import { buildRequest, chunkMarkdown, extractClaims } from "../src/extractors/spec/index.js";
import { matchClaims, renderMatchTable, type ExpectedClaim } from "./eval/match.js";

interface Expected {
  spec: string;
  claims: ExpectedClaim[];
}

const FIXTURES = "fixtures";
const fixtureDirs = readdirSync(FIXTURES)
  .map((n) => join(FIXTURES, n))
  .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "expected.json")));

for (const dir of fixtureDirs) {
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;
  const specPath = resolve(dir, expected.spec);
  const chunks = chunkMarkdown(readFileSync(specPath, "utf8"), specPath);
  const recordingsDir = join(dir, "recordings");
  const mock = new MockLlmClient(recordingsDir);
  const hasRecordings = chunks.filter((c) => c.body.trim() !== "").every((c) => mock.has(buildRequest(c)));

  describe.skipIf(!hasRecordings)(`claim extraction eval: ${dir}`, () => {
    it("finds every expected claim with the correct claim type", async () => {
      const { claims } = await extractClaims(chunks, { llm: mock, model: DEFAULT_MODEL });
      const results = matchClaims(expected.claims, claims);
      const table = renderMatchTable(results, claims);
      console.log(`\n${dir}\n${table}\n`);

      const found = results.filter((r) => r.status === "found").length;
      const wrongType = results.filter((r) => r.status === "wrong_type");
      const missing = results.filter((r) => r.status === "missing");

      expect(missing.map((r) => r.expected.text), "missing claims").toEqual([]);
      expect(wrongType.map((r) => `${r.expected.text} => ${r.matched?.claimType}`), "wrong claim type").toEqual([]);
      expect(found).toBe(expected.claims.length);
    });

    it("attaches a source location inside the spec to every claim", async () => {
      const { claims } = await extractClaims(chunks, { llm: mock, model: DEFAULT_MODEL });
      const lineCount = readFileSync(specPath, "utf8").split("\n").length;
      for (const c of claims) {
        expect(c.source.file).toBe(specPath);
        expect(c.source.lineStart).toBeGreaterThanOrEqual(1);
        expect(c.source.lineEnd).toBeLessThanOrEqual(lineCount);
        expect(c.source.headingPath.length).toBeGreaterThan(0);
      }
    });
  });

  if (!hasRecordings) {
    describe(`claim extraction eval: ${dir}`, () => {
      it.skip(`no recordings for the current prompt; run: npx tsx src/cli/index.ts record-fixtures --only ${dir.split("/").pop()}`, () => {});
    });
  }
}
