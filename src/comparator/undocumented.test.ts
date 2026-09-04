import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractGraphqlFacts } from "../extractors/code/graphql.js";
import type { Verdict } from "../types/index.js";
import { findUndocumented } from "./undocumented.js";

const facts = extractGraphqlFacts(readFileSync("fixtures/orders-api/schema.graphql", "utf8"), "schema.graphql");

function verdict(classification: Verdict["classification"], ids: string[]): Verdict {
  return { claimId: ids.join("+"), classification, matchedFactIds: ids, confidence: 1, suppressed: false };
}

describe("findUndocumented", () => {
  it("lists everything except root types, arguments and input fields when nothing is cited", () => {
    const ids = findUndocumented(facts, []).map((u) => u.factId);
    expect(ids).toContain("Order");
    expect(ids).toContain("Order.status");
    expect(ids).toContain("Mutation.cancelOrder");
    expect(ids).toContain("OrderStatus.PENDING");
    expect(ids).not.toContain("Query");
    expect(ids).not.toContain("Mutation");
    expect(ids).not.toContain("Query.orders(first)");
    expect(ids).not.toContain("PlaceOrderInput.items");
    expect(ids).toContain("PlaceOrderInput");
  });

  it("treats directly cited facts as documented", () => {
    const ids = findUndocumented(facts, [verdict("confirmed", ["Order.status"]), verdict("drifted", ["Order.placedAt"])]).map((u) => u.factId);
    expect(ids).not.toContain("Order.status");
    expect(ids).not.toContain("Order.placedAt");
    expect(ids).toContain("Order.total");
  });

  it("treats a type as documented when any member is cited", () => {
    const ids = findUndocumented(facts, [verdict("confirmed", ["Order.status"])]).map((u) => u.factId);
    expect(ids).not.toContain("Order");
  });

  it("treats a field as documented when one of its arguments is cited", () => {
    const ids = findUndocumented(facts, [verdict("confirmed", ["Query.orders(first)"])]).map((u) => u.factId);
    expect(ids).not.toContain("Query.orders");
  });

  it("ignores unmatched and not_checkable verdicts", () => {
    const ids = findUndocumented(facts, [verdict("unmatched", ["Order.status"]), verdict("not_checkable", ["Order.total"])]).map((u) => u.factId);
    expect(ids).toContain("Order.status");
    expect(ids).toContain("Order.total");
  });

  it("is sorted and stable", () => {
    const a = findUndocumented(facts, []).map((u) => u.factId);
    expect(a).toEqual([...a].sort());
  });
});
