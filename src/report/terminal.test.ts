import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractGraphqlFacts } from "../extractors/code/graphql.js";
import type { Claim, ClaimType, Report, Verdict } from "../types/index.js";
import { renderJson } from "./json.js";
import { renderReport } from "./terminal.js";

const facts = extractGraphqlFacts(readFileSync("fixtures/orders-api/schema.graphql", "utf8"), "fixtures/orders-api/schema.graphql");

let line = 10;
function claim(id: string, text: string, claimType: ClaimType, heading = "Orders"): Claim {
  line += 2;
  return { id, text, claimType, confidence: 0.9, mentions: [], source: { file: "fixtures/orders-api/spec.md", headingPath: ["Orders API", heading], lineStart: line, lineEnd: line } };
}
function verdict(claimId: string, classification: Verdict["classification"], matched: string[] = [], extra: Partial<Verdict> = {}): Verdict {
  return { claimId, classification, matchedFactIds: matched, confidence: 0.85, suppressed: false, ...extra };
}

/** A report shaped like what the orders-api fixture should produce. */
const report: Report = {
  generatedAt: "2026-09-05T00:00:00.000Z",
  provenance: { tool: "spec-drift", version: "0.1.0", model: "claude-opus-5", extractPromptVersion: "1", comparePromptVersion: "1" },
  spec: "fixtures/orders-api/spec.md",
  sources: ["fixtures/orders-api/schema.graphql"],
  ignoreFile: ".specdriftignore",
  claims: [
    claim("c1", "Order.placedAt is a String", "field_type"),
    claim("c2", "Order exposes a trackingNumber field", "field_exists"),
    claim("c3", "A Refund type records money returned to the customer", "type_exists", "Refunds"),
    claim("c4", "Users can cancel an order at any point until it has shipped", "behaviour", "Behaviour"),
    claim("c5", "Order has a status field", "field_exists"),
    claim("c6", "OrderStatus includes REFUNDED", "enum_values", "Order status"),
  ],
  facts,
  verdicts: [
    verdict("c1", "drifted", ["Order.placedAt"], { difference: "placedAt is DateTime!, not String.", rationale: "The field type is the custom scalar DateTime." }),
    verdict("c2", "drifted", ["Order"], { difference: "Order has no trackingNumber field; its fields are id, status, total, placedAt, items, note, shippingAddress, customer." }),
    verdict("c3", "unmatched", [], { rationale: "No Refund type among the candidates." }),
    verdict("c4", "not_checkable"),
    verdict("c5", "confirmed", ["Order.status"]),
    verdict("c6", "drifted", ["OrderStatus"], { difference: "OrderStatus has no REFUNDED value.", suppressed: true, suppressionReason: "refunds ship in Q4" }),
  ],
  undocumented: [
    { factId: "Mutation.cancelOrder", suppressed: false },
    { factId: "Mutation.placeOrder", suppressed: false },
    { factId: "Order.customer", suppressed: false },
    { factId: "OrderConnection.totalCount", suppressed: true, suppressionReason: "internal" },
    { factId: "PageInfo", suppressed: false },
    { factId: "PageInfo.endCursor", suppressed: false },
  ],
  summary: { confirmed: 1, drifted: 3, unmatched: 1, not_checkable: 1, undocumented: 6, suppressed: 2 },
};

describe("renderReport", () => {
  const text = renderReport(report);

  it("matches the snapshot", () => {
    expect(text).toMatchSnapshot();
  });

  it("orders sections drifted, unmatched, undocumented, not checkable, confirmed, suppressed", () => {
    const idx = (s: string) => text.indexOf(s);
    expect(idx("DRIFTED (2)")).toBeGreaterThan(-1);
    expect(idx("DRIFTED (2)")).toBeLessThan(idx("UNMATCHED (1)"));
    expect(idx("UNMATCHED (1)")).toBeLessThan(idx("UNDOCUMENTED (5)"));
    expect(idx("UNDOCUMENTED (5)")).toBeLessThan(idx("NOT CHECKABLE (1)"));
    expect(idx("NOT CHECKABLE (1)")).toBeLessThan(idx("CONFIRMED (1)"));
    expect(idx("CONFIRMED (1)")).toBeLessThan(idx("SUPPRESSED (2)"));
  });

  it("shows what differs and where, for every drifted claim", () => {
    expect(text).toContain("Order.placedAt is a String");
    expect(text).toContain("schema: placedAt is DateTime!, not String.");
    expect(text).toContain("fixtures/orders-api/spec.md:12  (Orders API > Orders)");
    expect(text).toMatch(/facts: {2}Order\.placedAt @ fixtures\/orders-api\/schema\.graphql:\d+/);
  });

  it("excludes suppressed items from the main sections and lists them at the end with reasons", () => {
    const driftedSection = text.slice(text.indexOf("DRIFTED (2)"), text.indexOf("UNMATCHED (1)"));
    expect(driftedSection).not.toContain("REFUNDED");
    expect(text).toContain("~ drifted: OrderStatus includes REFUNDED  # refunds ship in Q4");
    expect(text).toContain("~ undocumented: OrderConnection.totalCount  # internal");
  });

  it("groups undocumented facts by parent", () => {
    expect(text).toContain("• Mutation: cancelOrder, placeOrder");
    expect(text).toContain("• Order: customer");
    expect(text).toContain("• PageInfo: endCursor");
  });

  it("hides rationale by default and shows it on request", () => {
    expect(text).not.toContain("custom scalar DateTime");
    expect(renderReport(report, { showRationale: true })).toContain("why:    The field type is the custom scalar DateTime.");
  });

  it("can collapse confirmed and undocumented to counts", () => {
    const compact = renderReport(report, { showConfirmed: false, showUndocumented: false });
    expect(compact).toContain("CONFIRMED (1)");
    expect(compact).not.toContain("✓ Order has a status field");
    expect(compact).not.toContain("• Mutation:");
  });

  it("emits no ANSI codes unless colour is on", () => {
    expect(text).not.toMatch(/\[/);
    expect(renderReport(report, { color: true })).toMatch(/\[31m/);
  });

  it("says so plainly when there is no drift", () => {
    const clean = { ...report, verdicts: report.verdicts.filter((v) => v.classification === "confirmed"), undocumented: [] };
    const t = renderReport(clean);
    expect(t).toContain("DRIFTED (0)");
    expect(t).toContain("The schema matches every claim it could be checked against.");
  });
});

describe("renderJson", () => {
  it("sorts keys, drops undefined, and round-trips", () => {
    const json = renderJson(report);
    const parsed = JSON.parse(json) as Report;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(Object.keys(parsed.verdicts[0]!)).toEqual([...Object.keys(parsed.verdicts[0]!)].sort());
    expect(parsed.summary.drifted).toBe(3);
    expect(json.endsWith("\n")).toBe(true);
  });

  it("is byte-identical for structurally equal reports built in different key orders", () => {
    const reordered = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as unknown as Report;
    expect(Object.keys(shuffled)[0]).not.toBe(Object.keys(report)[0]);
    expect(renderJson(shuffled)).toBe(renderJson(report));
  });
});
