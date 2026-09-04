import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { extractFactsFromSchemaFile } from "../src/extractors/code/index.js";
import { isCheckable, type ClaimType } from "../src/types/index.js";

const FIXTURES_DIR = "fixtures";
const schemaJson = JSON.parse(readFileSync(join(FIXTURES_DIR, "expected.schema.json"), "utf8"));

interface ExpectedClaim {
  text: string;
  claimType: ClaimType;
  headingPath: string[];
  expected: "confirmed" | "drifted" | "unmatched" | "not_checkable";
  factIds?: string[];
  differenceHint?: string;
}

interface Expected {
  spec: string;
  schema: string;
  claims: ExpectedClaim[];
  undocumentedIncludes?: string[];
}

const fixtureDirs = readdirSync(FIXTURES_DIR)
  .map((name) => join(FIXTURES_DIR, name))
  .filter((p) => statSync(p).isDirectory());

// strictRequired rejects `required` inside if/then blocks unless the property is
// redeclared there, which is exactly how the conditional rules are written.
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
const validate = ajv.compile(schemaJson);

describe("fixtures", () => {
  it("has at least two fixtures", () => {
    expect(fixtureDirs.length).toBeGreaterThanOrEqual(2);
  });

  for (const dir of fixtureDirs) {
    describe(dir, () => {
      const expectedPath = join(dir, "expected.json");
      const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as Expected;

      it("expected.json validates against the schema", () => {
        const ok = validate(expected);
        if (!ok) console.error(ajv.errorsText(validate.errors, { separator: "\n" }));
        expect(ok).toBe(true);
      });

      it("references spec and schema files that exist", () => {
        expect(existsSync(resolve(dir, expected.spec))).toBe(true);
        expect(existsSync(resolve(dir, expected.schema))).toBe(true);
      });

      it("every heading path exists in the spec", () => {
        const spec = readFileSync(resolve(dir, expected.spec), "utf8");
        const headings = new Set(
          spec
            .split("\n")
            .filter((l) => /^#{1,6}\s/.test(l))
            .map((l) => l.replace(/^#{1,6}\s+/, "").trim()),
        );
        for (const c of expected.claims) {
          for (const h of c.headingPath) {
            expect(headings, `heading "${h}" for claim "${c.text}"`).toContain(h);
          }
        }
      });

      it("every referenced fact id exists in the extracted schema facts", () => {
        const facts = extractFactsFromSchemaFile(resolve(dir, expected.schema));
        const ids = new Set(facts.map((f) => f.id));
        for (const c of expected.claims) {
          for (const id of c.factIds ?? []) {
            expect(ids, `fact "${id}" for claim "${c.text}"`).toContain(id);
          }
        }
        for (const id of expected.undocumentedIncludes ?? []) {
          expect(ids, `undocumented fact "${id}"`).toContain(id);
        }
      });

      it("not_checkable claims have non-checkable claim types, and vice versa", () => {
        for (const c of expected.claims) {
          if (c.expected === "not_checkable") {
            expect(isCheckable(c.claimType), c.text).toBe(false);
          } else {
            expect(isCheckable(c.claimType), c.text).toBe(true);
          }
        }
      });

      it("claim texts are unique", () => {
        const texts = expected.claims.map((c) => c.text);
        expect(new Set(texts).size).toBe(texts.length);
      });
    });
  }

  it("orders-api covers every checkable claim type with at least one drifted and one confirmed", () => {
    const expected = JSON.parse(readFileSync("fixtures/orders-api/expected.json", "utf8")) as Expected;
    const checkable: ClaimType[] = [
      "type_exists",
      "field_exists",
      "field_type",
      "field_nullability",
      "field_args",
      "enum_values",
      "deprecation",
    ];
    for (const t of checkable) {
      const ofType = expected.claims.filter((c) => c.claimType === t);
      expect(ofType.length, `claim type ${t}`).toBeGreaterThan(0);
    }
    const drifted = expected.claims.filter((c) => c.expected === "drifted");
    expect(drifted.length).toBeGreaterThanOrEqual(2);
    expect(expected.claims.some((c) => c.expected === "unmatched")).toBe(true);
    expect(expected.claims.some((c) => c.expected === "not_checkable")).toBe(true);
  });

  it("orders-api-clean has no drifted or unmatched claims", () => {
    const expected = JSON.parse(readFileSync("fixtures/orders-api-clean/expected.json", "utf8")) as Expected;
    for (const c of expected.claims) {
      expect(c.expected, c.text).toBe("confirmed");
    }
  });
});
