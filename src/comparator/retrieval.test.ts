import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractGraphqlFacts } from "../extractors/code/graphql.js";
import type { Claim, ClaimType } from "../types/index.js";
import { buildFactIndex, claimTerms, retrieve, splitIdentifier } from "./retrieval.js";

const facts = extractGraphqlFacts(readFileSync("fixtures/orders-api/schema.graphql", "utf8"), "schema.graphql");
const index = buildFactIndex(facts);

function claim(text: string, claimType: ClaimType, mentions: string[] = []): Claim {
  return { id: text, text, claimType, confidence: 1, mentions, source: { file: "s", headingPath: ["A"], lineStart: 1, lineEnd: 1 } };
}

const ids = (cs: ReturnType<typeof retrieve>) => cs.map((c) => c.fact.id);

describe("splitIdentifier", () => {
  it("splits camelCase, PascalCase and snake_case", () => {
    expect(splitIdentifier("shippingAddress")).toEqual(["shipping", "address"]);
    expect(splitIdentifier("OrderStatus")).toEqual(["order", "status"]);
    expect(splitIdentifier("legacy_id")).toEqual(["legacy", "id"]);
    expect(splitIdentifier("HTTPServer")).toEqual(["http", "server"]);
  });
});

describe("claimTerms", () => {
  it("collects dotted ids, identifiers and words", () => {
    const t = claimTerms(claim("Order.placedAt is a String", "field_type", ["Order.placedAt", "String"]));
    expect(t.ids.has("order.placedat")).toBe(true);
    expect(t.identifiers.has("placedat")).toBe(true);
    expect(t.identifiers.has("string")).toBe(true);
    expect(t.words.has("placed")).toBe(true);
  });

  it("does not treat sentence-initial stopwords as identifiers", () => {
    const t = claimTerms(claim("The orders query accepts first and after", "field_args"));
    expect(t.identifiers.has("the")).toBe(false);
    expect(t.words.has("orders")).toBe(true);
    expect(t.words.has("order")).toBe(true);
  });
});

describe("retrieve", () => {
  it("puts an exact dotted id first", () => {
    const cs = retrieve(claim("User.email is required", "field_nullability", ["User.email"]), index);
    expect(ids(cs)[0]).toBe("User.email");
    expect(cs[0]!.reasons.join(" ")).toMatch(/id match/);
  });

  it("finds the parent type for a missing field so the comparator can report drift", () => {
    const cs = retrieve(claim("Order exposes a trackingNumber field", "field_exists", ["Order", "trackingNumber"]), index);
    expect(ids(cs)).toContain("Order");
    expect(ids(cs)).not.toContain("Order.trackingNumber");
  });

  it("finds the enum type for a missing enum value", () => {
    const cs = retrieve(claim("OrderStatus includes REFUNDED", "enum_values", ["OrderStatus", "REFUNDED"]), index);
    expect(ids(cs)[0]).toBe("OrderStatus");
  });

  it("finds every listed enum value", () => {
    const cs = retrieve(
      claim("OrderStatus includes PENDING, PAID, SHIPPED, DELIVERED and CANCELLED", "enum_values", ["OrderStatus", "PENDING", "PAID", "SHIPPED", "DELIVERED", "CANCELLED"]),
      index,
    );
    for (const v of ["PENDING", "PAID", "SHIPPED", "DELIVERED", "CANCELLED"]) expect(ids(cs)).toContain(`OrderStatus.${v}`);
  });

  it("finds arguments for a field_args claim", () => {
    const cs = retrieve(claim("The orders query accepts first and after arguments for cursor-based pagination", "field_args", ["orders", "first", "after"]), index);
    expect(ids(cs)).toContain("Query.orders(first)");
    expect(ids(cs)).toContain("Query.orders(after)");
  });

  it("finds the field for a missing argument", () => {
    const cs = retrieve(claim("The orders query can be filtered by customerId", "field_args", ["orders", "customerId"]), index);
    expect(ids(cs)).toContain("Query.orders");
  });

  it("prefers the type for a type_exists claim over a same-named field", () => {
    const cs = retrieve(claim("Every customer has a User account", "type_exists", ["User"]), index);
    expect(ids(cs)[0]).toBe("User");
  });

  it("uses fuzzy matching for plurals and casing without mentions", () => {
    const cs = retrieve(claim("Orders have statuses", "field_exists"), index);
    expect(ids(cs)).toContain("Order.status");
  });

  it("returns nothing when no term matches", () => {
    expect(retrieve(claim("Widgets sparkle brightly", "type_exists", ["Widget"]), index)).toEqual([]);
  });

  it("respects the limit and orders deterministically", () => {
    const c = claim("Order has a status field", "field_exists", ["Order", "status"]);
    const a = retrieve(c, index, { limit: 3 });
    const b = retrieve(c, index, { limit: 3 });
    expect(a).toHaveLength(3);
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a)[0]).toBe("Order.status");
  });

  it("records reasons for every candidate", () => {
    for (const c of retrieve(claim("Order.total is a Money value", "field_type", ["Order.total", "Money"]), index)) {
      expect(c.reasons.length).toBeGreaterThan(0);
    }
  });
});
