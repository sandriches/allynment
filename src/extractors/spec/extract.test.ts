import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticLlmClient } from "../../llm/mock.js";
import { JsonFileCache } from "../../cache.js";
import { extractClaims, parseResponse, toClaim } from "./extract.js";
import type { SpecChunk } from "./markdown.js";

const chunk: SpecChunk = {
  file: "spec.md",
  headingPath: ["API", "Orders"],
  lineStart: 10,
  lineEnd: 14,
  bodyLineStart: 12,
  body: "Order has a status field.\nOrders can be cancelled until shipped.",
};

const goodResponse = JSON.stringify({
  claims: [
    { text: "Order has a status field", claim_type: "field_exists", confidence: 0.95, mentions: ["Order", "status"], line_start: 11, line_end: 11 },
    { text: "Orders can be cancelled until shipped", claim_type: "behaviour", confidence: 0.8, mentions: ["Order"], line_start: 12, line_end: 12 },
  ],
});

describe("toClaim", () => {
  it("builds a claim with a stable id and source location", () => {
    const raw = { text: "Order has a status field", claim_type: "field_exists", confidence: 0.9, mentions: ["Order", "status", "status"], line_start: 11, line_end: 11 };
    const a = toClaim(raw, chunk)!;
    const b = toClaim(raw, chunk)!;
    expect(a.id).toBe(b.id);
    expect(a.id).toHaveLength(16);
    expect(a.source).toEqual({ file: "spec.md", headingPath: ["API", "Orders"], lineStart: 11, lineEnd: 11 });
    expect(a.mentions).toEqual(["Order", "status"]);
  });

  it("changes id when text, type or heading changes", () => {
    const base = { text: "x", claim_type: "field_exists", confidence: 1, mentions: [], line_start: 10, line_end: 10 };
    const a = toClaim(base, chunk)!.id;
    expect(toClaim({ ...base, text: "y" }, chunk)!.id).not.toBe(a);
    expect(toClaim({ ...base, claim_type: "type_exists" }, chunk)!.id).not.toBe(a);
    expect(toClaim(base, { ...chunk, headingPath: ["Other"] })!.id).not.toBe(a);
  });

  it("rejects unknown claim types and empty text", () => {
    expect(toClaim({ text: "x", claim_type: "made_up", confidence: 1, mentions: [], line_start: 10, line_end: 10 }, chunk)).toBeNull();
    expect(toClaim({ text: "   ", claim_type: "field_exists", confidence: 1, mentions: [], line_start: 10, line_end: 10 }, chunk)).toBeNull();
  });

  it("clamps confidence and line numbers into range", () => {
    const c = toClaim({ text: "x", claim_type: "field_exists", confidence: 7, mentions: [], line_start: 2, line_end: 999 }, chunk)!;
    expect(c.confidence).toBe(1);
    expect(c.source.lineStart).toBe(10);
    expect(c.source.lineEnd).toBe(14);
  });
});

describe("parseResponse", () => {
  it("rejects invalid JSON and wrong shapes", () => {
    expect(() => parseResponse("not json")).toThrow(/invalid JSON/);
    expect(() => parseResponse('{"nope":[]}')).toThrow(/unexpected shape/);
  });
});

describe("extractClaims", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spec-drift-cache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts claims from each non-empty chunk", async () => {
    const llm = new StaticLlmClient(() => goodResponse);
    const result = await extractClaims([chunk, { ...chunk, headingPath: ["Empty"], body: "" }], { llm, model: "m" });
    expect(result.claims).toHaveLength(2);
    expect(result.claims.map((c) => c.claimType)).toEqual(["field_exists", "behaviour"]);
    expect(result.usage.llmCalls).toBe(1);
  });

  it("uses the cache on a second run and skips the LLM", async () => {
    let calls = 0;
    const llm = new StaticLlmClient(() => {
      calls++;
      return goodResponse;
    });
    const cache = new JsonFileCache(dir);
    const first = await extractClaims([chunk], { llm, model: "m", cache });
    const second = await extractClaims([chunk], { llm, model: "m", cache });
    expect(calls).toBe(1);
    expect(second.usage.cachedSections).toBe(1);
    expect(JSON.stringify(second.claims)).toBe(JSON.stringify(first.claims));
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("misses the cache when the section text changes", async () => {
    let calls = 0;
    const llm = new StaticLlmClient(() => {
      calls++;
      return goodResponse;
    });
    const cache = new JsonFileCache(dir);
    await extractClaims([chunk], { llm, model: "m", cache });
    await extractClaims([{ ...chunk, body: chunk.body + "\nMore." }], { llm, model: "m", cache });
    expect(calls).toBe(2);
  });

  it("misses the cache when the model changes", async () => {
    let calls = 0;
    const llm = new StaticLlmClient(() => {
      calls++;
      return goodResponse;
    });
    const cache = new JsonFileCache(dir);
    await extractClaims([chunk], { llm, model: "a", cache });
    await extractClaims([chunk], { llm, model: "b", cache });
    expect(calls).toBe(2);
  });

  it("drops invalid claims rather than failing the run", async () => {
    const llm = new StaticLlmClient(() =>
      JSON.stringify({
        claims: [
          { text: "ok", claim_type: "type_exists", confidence: 1, mentions: [], line_start: 11, line_end: 11 },
          { text: "bad", claim_type: "nonsense", confidence: 1, mentions: [], line_start: 11, line_end: 11 },
        ],
      }),
    );
    const result = await extractClaims([chunk], { llm, model: "m" });
    expect(result.claims.map((c) => c.text)).toEqual(["ok"]);
  });

  it("reports per-section progress", async () => {
    const seen: string[] = [];
    await extractClaims([chunk], {
      llm: new StaticLlmClient(() => goodResponse),
      model: "m",
      onSection: (s) => seen.push(`${s.chunk.headingPath.join(">")}:${s.claims}:${s.cached}`),
    });
    expect(seen).toEqual(["API>Orders:2:false"]);
  });
});
