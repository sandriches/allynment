/**
 * Retrieval recall: for every labelled claim with expected fact IDs, do all of those IDs appear
 * in the candidate list? The comparator cannot recover from a retrieval miss, so this must be
 * at or near 100 percent before the comparator is worth tuning.
 *
 * Runs on claims derived from expected.json (always), and on real extracted claims when recordings exist.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildFactIndex, retrieve } from "../src/comparator/index.js";
import { extractFactsFromSchemaFile } from "../src/extractors/code/index.js";
import { buildRequest, chunkMarkdown, extractClaims } from "../src/extractors/spec/index.js";
import { DEFAULT_MODEL } from "../src/llm/anthropic.js";
import { MockLlmClient } from "../src/llm/mock.js";
import type { Claim } from "../src/types/index.js";
import { matchClaims, type ExpectedClaim } from "./eval/match.js";

interface Expected {
  spec: string;
  schema: string;
  claims: ExpectedClaim[];
}

const FIXTURES = "fixtures";
const fixtureDirs = readdirSync(FIXTURES)
  .map((n) => join(FIXTURES, n))
  .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "expected.json")));

/** Identifier-looking tokens from the expected text, standing in for the extractor's mentions. */
function pseudoMentions(text: string): string[] {
  return [...new Set(text.split(/[^A-Za-z0-9_.]+/).filter((t) => /[A-Z_.]/.test(t) && t.length > 1))];
}

function pseudoClaim(e: ExpectedClaim): Claim {
  return {
    id: e.text,
    text: e.text,
    claimType: e.claimType,
    confidence: 1,
    mentions: pseudoMentions(e.text),
    source: { file: "spec.md", headingPath: e.headingPath, lineStart: 1, lineEnd: 1 },
  };
}

function checkRecall(pairs: { claim: Claim; expected: ExpectedClaim }[], index: ReturnType<typeof buildFactIndex>): string[] {
  const misses: string[] = [];
  for (const { claim, expected } of pairs) {
    if (!expected.factIds?.length) continue;
    const got = new Set(retrieve(claim, index).map((c) => c.fact.id));
    for (const id of expected.factIds) {
      if (!got.has(id)) misses.push(`"${claim.text}" missed ${id} (got: ${[...got].join(", ")})`);
    }
  }
  return misses;
}

for (const dir of fixtureDirs) {
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;
  const facts = extractFactsFromSchemaFile(resolve(dir, expected.schema));
  const index = buildFactIndex(facts);

  describe(`retrieval recall: ${dir}`, () => {
    it("finds every expected fact for claims derived from expected.json", () => {
      const pairs = expected.claims.map((e) => ({ claim: pseudoClaim(e), expected: e }));
      expect(checkRecall(pairs, index)).toEqual([]);
    });

    const specPath = resolve(dir, expected.spec);
    const chunks = chunkMarkdown(readFileSync(specPath, "utf8"), specPath);
    const mock = new MockLlmClient(join(dir, "recordings"));
    const hasRecordings = chunks.filter((c) => c.body.trim() !== "").every((c) => mock.has(buildRequest(c)));

    it.skipIf(!hasRecordings)("finds every expected fact for real extracted claims", async () => {
      const { claims } = await extractClaims(chunks, { llm: mock, model: DEFAULT_MODEL });
      const matched = matchClaims(expected.claims, claims).filter((r) => r.matched);
      const pairs = matched.map((r) => ({ claim: r.matched!, expected: r.expected }));
      expect(checkRecall(pairs, index)).toEqual([]);
    });
  });
}
