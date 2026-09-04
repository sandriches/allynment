import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractGraphqlFacts } from "./graphql.js";
import type { ArgumentFact, EnumValueFact, FieldFact, TypeFact } from "../../types/index.js";

const SCHEMA_PATH = "fixtures/orders-api/schema.graphql";
const sdl = readFileSync(SCHEMA_PATH, "utf8");
const facts = extractGraphqlFacts(sdl, SCHEMA_PATH);
const byId = new Map(facts.map((f) => [f.id, f]));

describe("extractGraphqlFacts", () => {
  it("matches the snapshot for the orders-api fixture", () => {
    expect(facts).toMatchSnapshot();
  });

  it("is deterministic across runs", () => {
    const again = extractGraphqlFacts(sdl, SCHEMA_PATH);
    expect(JSON.stringify(again)).toBe(JSON.stringify(facts));
  });

  it("sorts facts by id", () => {
    const ids = facts.map((f) => f.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("excludes introspection and built-in scalar types", () => {
    for (const id of ["String", "Int", "Boolean", "ID", "Float", "__Schema", "__Type"]) {
      expect(byId.has(id)).toBe(false);
    }
  });

  it("includes custom scalars", () => {
    const dt = byId.get("DateTime") as TypeFact;
    expect(dt.kind).toBe("type");
    expect(dt.typeKind).toBe("SCALAR");
  });

  it("records nullability correctly", () => {
    const email = byId.get("User.email") as FieldFact;
    expect(email.nullable).toBe(false);
    expect(email.type).toBe("String!");

    const shipping = byId.get("Order.shippingAddress") as FieldFact;
    expect(shipping.nullable).toBe(true);
    expect(shipping.type).toBe("Address");
    expect(shipping.namedType).toBe("Address");
  });

  it("records list shape and inner named type", () => {
    const items = byId.get("Order.items") as FieldFact;
    expect(items.isList).toBe(true);
    expect(items.nullable).toBe(false);
    expect(items.type).toBe("[LineItem!]!");
    expect(items.namedType).toBe("LineItem");
  });

  it("records deprecation with reason", () => {
    const legacy = byId.get("User.legacyId") as FieldFact;
    expect(legacy.deprecated).toBe(true);
    expect(legacy.deprecationReason).toBe("Use id instead");

    const note = byId.get("Order.note") as FieldFact;
    expect(note.deprecated).toBe(false);
    expect(note.deprecationReason).toBeUndefined();
  });

  it("records arguments as separate facts and on the field", () => {
    const orders = byId.get("Query.orders") as FieldFact;
    expect(orders.argumentNames).toEqual(["first", "after", "status"]);

    const first = byId.get("Query.orders(first)") as ArgumentFact;
    expect(first.kind).toBe("argument");
    expect(first.type).toBe("Int");
    expect(first.hasDefault).toBe(true);
    expect(first.defaultValue).toBe("20");

    const after = byId.get("Query.orders(after)") as ArgumentFact;
    expect(after.hasDefault).toBe(false);
    expect(after.defaultValue).toBeUndefined();

    expect(byId.has("Query.orders(customerId)")).toBe(false);
  });

  it("records enum values", () => {
    const values = facts.filter((f): f is EnumValueFact => f.kind === "enum_value" && f.enumType === "OrderStatus");
    expect(values.map((v) => v.name).sort()).toEqual(["CANCELLED", "DELIVERED", "PAID", "PENDING", "SHIPPED"]);
    expect(byId.has("OrderStatus.REFUNDED")).toBe(false);
  });

  it("records input object fields", () => {
    const input = byId.get("PlaceOrderInput") as TypeFact;
    expect(input.typeKind).toBe("INPUT_OBJECT");
    const items = byId.get("PlaceOrderInput.items") as FieldFact;
    expect(items.type).toBe("[LineItemInput!]!");
  });

  it("captures descriptions and source lines", () => {
    const user = byId.get("User") as TypeFact;
    expect(user.description).toBe("A customer account.");
    expect(user.origin.file).toBe(SCHEMA_PATH);
    expect(user.origin.line).toBeGreaterThan(0);
  });

  it("does not emit a trackingNumber field on Order", () => {
    expect(byId.has("Order.trackingNumber")).toBe(false);
  });

  it("rejects invalid SDL", () => {
    expect(() => extractGraphqlFacts("type Broken {", "bad.graphql")).toThrow();
  });
});
