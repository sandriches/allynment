import { describe, expect, it } from "vitest";
import { applyIgnore, parseIgnore, ruleMatchesText } from "./ignore.js";
import type { Claim, Report } from "./types/index.js";

describe("parseIgnore", () => {
  it("parses rules, reasons, and until dates; skips blanks and comments", () => {
    const f = parseIgnore(
      [
        "# header comment",
        "",
        "claim:abc123                      # known, tracked in JIRA-42",
        "text:*trackingNumber*  until=2026-12-31   # carrier integration ships Q4",
        "fact:OrderConnection.totalCount",
        "   ",
      ].join("\n"),
    );
    expect(f.errors).toEqual([]);
    expect(f.rules).toEqual([
      { kind: "claim", pattern: "abc123", reason: "known, tracked in JIRA-42", line: 3 },
      { kind: "text", pattern: "*trackingNumber*", until: "2026-12-31", reason: "carrier integration ships Q4", line: 4 },
      { kind: "fact", pattern: "OrderConnection.totalCount", line: 5 },
    ]);
  });

  it("reports unparseable lines without dropping good ones", () => {
    const f = parseIgnore(["nonsense", "bogus:x", "claim:", "text:foo until=soon", "text:has a space", "fact:Ok"].join("\n"));
    expect(f.rules.map((r) => r.pattern)).toEqual(["Ok"]);
    expect(f.errors.map((e) => e.line)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("ruleMatchesText", () => {
  it("matches case-insensitively with * wildcards and escapes regex characters", () => {
    const rule = { kind: "text" as const, pattern: "*order.status*", line: 1 };
    expect(ruleMatchesText(rule, "Order.status is required")).toBe(true);
    expect(ruleMatchesText(rule, "OrderXstatus is required")).toBe(false);
    expect(ruleMatchesText({ kind: "text", pattern: "exact", line: 1 }, "Exact")).toBe(true);
    expect(ruleMatchesText({ kind: "text", pattern: "exact", line: 1 }, "exactly")).toBe(false);
  });
});

function claim(id: string, text: string): Claim {
  return { id, text, claimType: "field_exists", confidence: 1, mentions: [], source: { file: "s.md", headingPath: ["A"], lineStart: 1, lineEnd: 1 } };
}

const report: Report = {
  generatedAt: "t",
  provenance: { tool: "spec-drift", version: "0", model: "m", extractPromptVersion: "1", comparePromptVersion: "1" },
  spec: "s.md",
  sources: ["g.graphql"],
  claims: [claim("c1", "Order exposes a trackingNumber field"), claim("c2", "A Refund type exists"), claim("c3", "Order has a status field")],
  facts: [],
  verdicts: [
    { claimId: "c1", classification: "drifted", matchedFactIds: ["Order"], difference: "no such field", confidence: 0.9, suppressed: false },
    { claimId: "c2", classification: "unmatched", matchedFactIds: [], confidence: 0.9, suppressed: false },
    { claimId: "c3", classification: "confirmed", matchedFactIds: ["Order.status"], confidence: 0.9, suppressed: false },
  ],
  undocumented: [
    { factId: "OrderConnection.totalCount", suppressed: false },
    { factId: "Query.me", suppressed: false },
  ],
  summary: { confirmed: 1, drifted: 1, unmatched: 1, not_checkable: 0, undocumented: 2, suppressed: 0 },
};

describe("applyIgnore", () => {
  it("suppresses matching verdicts and facts, keeps them in the report, and counts them", () => {
    const ignore = parseIgnore(["text:*trackingNumber*  # not built yet", "claim:c2", "fact:OrderConnection.*"].join("\n"), ".specdriftignore");
    const { report: out, unusedRules, expiredRules } = applyIgnore(report, ignore, "2026-09-05");
    expect(out.verdicts.map((v) => [v.claimId, v.suppressed, v.suppressionReason])).toEqual([
      ["c1", true, "not built yet"],
      ["c2", true, undefined],
      ["c3", false, undefined],
    ]);
    expect(out.undocumented.map((u) => [u.factId, u.suppressed])).toEqual([
      ["OrderConnection.totalCount", true],
      ["Query.me", false],
    ]);
    expect(out.summary.suppressed).toBe(3);
    expect(out.summary.drifted).toBe(1);
    expect(out.ignoreFile).toBe(".specdriftignore");
    expect(unusedRules).toEqual([]);
    expect(expiredRules).toEqual([]);
    expect(report.verdicts[0]!.suppressed).toBe(false);
  });

  it("never suppresses confirmed or not_checkable verdicts", () => {
    const ignore = parseIgnore("text:*");
    const { report: out } = applyIgnore(report, ignore, "2026-09-05");
    expect(out.verdicts.find((v) => v.claimId === "c3")!.suppressed).toBe(false);
  });

  it("ignores expired rules and reports them, and reports rules that matched nothing", () => {
    const ignore = parseIgnore(["claim:c1 until=2026-01-01", "text:*nothing-matches-this*"].join("\n"));
    const { report: out, unusedRules, expiredRules } = applyIgnore(report, ignore, "2026-09-05");
    expect(out.verdicts[0]!.suppressed).toBe(false);
    expect(expiredRules.map((r) => r.line)).toEqual([1]);
    expect(unusedRules.map((r) => r.line)).toEqual([2]);
  });

  it("applies a rule that has not yet expired", () => {
    const ignore = parseIgnore("claim:c1 until=2026-12-31");
    const { report: out } = applyIgnore(report, ignore, "2026-09-05");
    expect(out.verdicts[0]!.suppressed).toBe(true);
  });
});
