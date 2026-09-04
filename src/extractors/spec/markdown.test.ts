import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { chunkMarkdown, numberedBody } from "./markdown.js";

const doc = [
  "# Title", // 1
  "", // 2
  "Intro paragraph.", // 3
  "", // 4
  "## Section A", // 5
  "", // 6
  "A line one.", // 7
  "A line two.", // 8
  "", // 9
  "### Sub A1", // 10
  "", // 11
  "Sub content.", // 12
  "", // 13
  "## Section B", // 14
  "", // 15
  "## Section C", // 16
  "", // 17
  "C content.", // 18
  "", // 19
].join("\n");

describe("chunkMarkdown", () => {
  const chunks = chunkMarkdown(doc, "doc.md");

  it("produces one chunk per heading", () => {
    expect(chunks.map((c) => c.headingPath)).toEqual([
      ["Title"],
      ["Title", "Section A"],
      ["Title", "Section A", "Sub A1"],
      ["Title", "Section B"],
      ["Title", "Section C"],
    ]);
  });

  it("records tight line ranges", () => {
    expect(chunks[0]).toMatchObject({ lineStart: 1, lineEnd: 3, bodyLineStart: 3, body: "Intro paragraph." });
    expect(chunks[1]).toMatchObject({ lineStart: 5, lineEnd: 8, bodyLineStart: 7, body: "A line one.\nA line two." });
    expect(chunks[2]).toMatchObject({ lineStart: 10, lineEnd: 12, bodyLineStart: 12, body: "Sub content." });
    expect(chunks[4]).toMatchObject({ lineStart: 16, lineEnd: 18, bodyLineStart: 18, body: "C content." });
  });

  it("keeps heading-only sections with an empty body", () => {
    expect(chunks[3]).toMatchObject({ headingPath: ["Title", "Section B"], body: "", bodyLineStart: 15 });
  });

  it("pops the heading stack when depth decreases", () => {
    expect(chunks[3]!.headingPath).toEqual(["Title", "Section B"]);
  });

  it("handles a preamble before the first heading", () => {
    const c = chunkMarkdown("Preamble text.\n\n# H\n\nBody.", "p.md");
    expect(c[0]).toMatchObject({ headingPath: [], lineStart: 1, lineEnd: 1, body: "Preamble text." });
    expect(c[1]).toMatchObject({ headingPath: ["H"], body: "Body." });
  });

  it("returns no chunks for an empty document", () => {
    expect(chunkMarkdown("", "e.md")).toEqual([]);
  });

  it("numbers body lines with absolute line numbers", () => {
    const numbered = numberedBody(chunks[1]!);
    expect(numbered.split("\n")[0]).toMatch(/^\s*7 \| A line one\.$/);
    expect(numbered.split("\n")[1]).toMatch(/^\s*8 \| A line two\.$/);
  });

  it("chunks the orders-api fixture into its five sections", () => {
    const md = readFileSync("fixtures/orders-api/spec.md", "utf8");
    const fixture = chunkMarkdown(md, "fixtures/orders-api/spec.md");
    expect(fixture.map((c) => c.headingPath.join(" > "))).toEqual([
      "Orders API",
      "Orders API > Users",
      "Orders API > Orders",
      "Orders API > Orders > Order status",
      "Orders API > Orders > Refunds",
      "Orders API > Querying orders",
      "Orders API > Behaviour",
    ]);
    for (const c of fixture) expect(c.body.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(chunkMarkdown(doc, "doc.md"))).toBe(JSON.stringify(chunks));
  });
});
