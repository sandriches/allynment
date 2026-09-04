import { describe, expect, it } from "vitest";
import type { Claim } from "../../src/types/index.js";
import { matchClaims, score, words, identifiers, type ExpectedClaim } from "./match.js";

const path = ["Orders API", "Orders"];
function claim(text: string, claimType: Claim["claimType"], mentions: string[] = [], headingPath = path): Claim {
  return {
    id: text,
    text,
    claimType,
    confidence: 1,
    source: { file: "spec.md", headingPath, lineStart: 1, lineEnd: 1 },
    mentions,
  };
}

describe("words / identifiers", () => {
  it("splits dotted identifiers and drops stopwords", () => {
    expect([...words("Order.total is a Money value")]).toEqual(["order", "total", "money"]);
  });
  it("collects identifier-looking tokens and fact id parts", () => {
    expect([...identifiers("The orders query accepts first and after", ["Query.orders(first)"])]).toEqual(["query", "orders", "first"]);
  });
});

describe("matchClaims", () => {
  const expected: ExpectedClaim[] = [
    { text: "Order.placedAt is a String", claimType: "field_type", headingPath: path, expected: "drifted", factIds: ["Order.placedAt"], differenceHint: "" },
    { text: "Order.note is deprecated", claimType: "deprecation", headingPath: path, expected: "drifted", factIds: ["Order.note"], differenceHint: "" },
    { text: "An order may contain at most 50 line items", claimType: "limit_or_policy", headingPath: path, expected: "not_checkable" },
  ];

  it("matches paraphrased claims in the same section", () => {
    const extracted = [
      claim("The placedAt field on Order is a String in ISO-8601 format", "field_type", ["Order", "placedAt", "String"]),
      claim("The note field on Order is deprecated", "deprecation", ["Order", "note"]),
      claim("An order can contain at most 50 line items", "limit_or_policy", ["Order"]),
    ];
    const results = matchClaims(expected, extracted);
    expect(results.map((r) => r.status)).toEqual(["found", "found", "found"]);
  });

  it("flags a wrong claim type", () => {
    const extracted = [claim("Order.note is deprecated", "field_exists", ["Order", "note"])];
    const results = matchClaims([expected[1]!], extracted);
    expect(results[0]!.status).toBe("wrong_type");
  });

  it("reports missing when nothing in the section is close", () => {
    const extracted = [claim("Something else entirely about shipping", "behaviour")];
    const results = matchClaims([expected[0]!], extracted);
    expect(results[0]!.status).toBe("missing");
  });

  it("does not match across sections", () => {
    const extracted = [claim("Order.placedAt is a String", "field_type", ["Order", "placedAt"], ["Other"])];
    expect(score(expected[0]!, extracted[0]!)).toBe(0);
  });

  it("uses each extracted claim at most once", () => {
    const dup: ExpectedClaim[] = [expected[0]!, { ...expected[0]!, text: "Order.placedAt is a String type" }];
    const extracted = [claim("Order.placedAt is a String", "field_type", ["Order", "placedAt", "String"])];
    const statuses = matchClaims(dup, extracted).map((r) => r.status).sort();
    expect(statuses).toEqual(["found", "missing"]);
  });
});
