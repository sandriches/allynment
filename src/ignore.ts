import { readFileSync } from "node:fs";
import type { Report } from "./types/index.js";

/**
 * Ignore file (`.specdriftignore`): accepted differences that should not be re-reported every run.
 *
 * One rule per line. Blank lines and lines starting with # are skipped. A trailing `# text` on a
 * rule line is recorded as the reason. Optional `until=YYYY-MM-DD` expires the rule.
 *
 *   claim:3f9c1a2b7d4e5f60                 # exact claim id from the JSON report
 *   text:*trackingNumber*   until=2026-12-31   # carrier integration ships in Q4
 *   fact:OrderConnection.totalCount        # internal field, not part of the public spec
 *
 * `claim:` matches a claim id. `text:` matches claim text, case-insensitive, with * as a wildcard.
 * `fact:` matches an undocumented fact id, also with * as a wildcard.
 * Patterns cannot contain spaces; use * in their place ("text:*cancel*order*").
 * Suppressed items stay in the JSON output with `suppressed: true`; nothing is silently dropped.
 */

export type IgnoreKind = "claim" | "text" | "fact";

export interface IgnoreRule {
  kind: IgnoreKind;
  pattern: string;
  reason?: string;
  /** ISO date (YYYY-MM-DD). The rule stops applying on this date. */
  until?: string;
  line: number;
}

export interface IgnoreFile {
  path: string;
  rules: IgnoreRule[];
  /** Lines that could not be parsed, with the reason. */
  errors: { line: number; text: string; error: string }[];
}

export function parseIgnore(content: string, path = ".specdriftignore"): IgnoreFile {
  const rules: IgnoreRule[] = [];
  const errors: IgnoreFile["errors"] = [];

  content.split("\n").forEach((rawLine, i) => {
    const lineNo = i + 1;
    const hash = rawLine.indexOf("#");
    const body = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim();
    const reason = hash === -1 ? "" : rawLine.slice(hash + 1).trim();
    if (body === "") return;

    const [head, ...rest] = body.split(/\s+/);
    const colon = head!.indexOf(":");
    if (colon === -1) {
      errors.push({ line: lineNo, text: rawLine, error: "expected claim:, text: or fact: prefix" });
      return;
    }
    const kind = head!.slice(0, colon);
    const pattern = head!.slice(colon + 1);
    if (kind !== "claim" && kind !== "text" && kind !== "fact") {
      errors.push({ line: lineNo, text: rawLine, error: `unknown rule kind "${kind}"` });
      return;
    }
    if (pattern === "") {
      errors.push({ line: lineNo, text: rawLine, error: "empty pattern" });
      return;
    }

    const rule: IgnoreRule = { kind, pattern, line: lineNo };
    if (reason) rule.reason = reason;
    for (const opt of rest) {
      const [k, v] = opt.split("=", 2);
      if (k === "until" && v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        rule.until = v;
      } else {
        errors.push({ line: lineNo, text: rawLine, error: `unknown option "${opt}" (expected until=YYYY-MM-DD)` });
        return;
      }
    }
    rules.push(rule);
  });

  return { path, rules, errors };
}

export function loadIgnore(path: string): IgnoreFile {
  return parseIgnore(readFileSync(path, "utf8"), path);
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function ruleMatchesText(rule: IgnoreRule, text: string): boolean {
  return globToRegex(rule.pattern).test(text);
}

function isActive(rule: IgnoreRule, today: string): boolean {
  return rule.until === undefined || rule.until > today;
}

export interface ApplyIgnoreResult {
  report: Report;
  /** Rules that suppressed nothing. Usually stale and worth deleting. */
  unusedRules: IgnoreRule[];
  /** Rules whose `until` date has passed. */
  expiredRules: IgnoreRule[];
}

/**
 * Mark verdicts and undocumented facts that match an active rule as suppressed.
 * Returns a new report; the input is not mutated.
 */
export function applyIgnore(report: Report, ignore: IgnoreFile, today: string = new Date().toISOString().slice(0, 10)): ApplyIgnoreResult {
  const active = ignore.rules.filter((r) => isActive(r, today));
  const expiredRules = ignore.rules.filter((r) => !isActive(r, today));
  const used = new Set<IgnoreRule>();
  const claimsById = new Map(report.claims.map((c) => [c.id, c]));

  const verdicts = report.verdicts.map((v) => {
    if (v.classification === "confirmed" || v.classification === "not_checkable") return v;
    const claim = claimsById.get(v.claimId);
    const rule = active.find(
      (r) => (r.kind === "claim" && r.pattern === v.claimId) || (r.kind === "text" && claim !== undefined && ruleMatchesText(r, claim.text)),
    );
    if (!rule) return v;
    used.add(rule);
    const out = { ...v, suppressed: true };
    if (rule.reason) out.suppressionReason = rule.reason;
    return out;
  });

  const undocumented = report.undocumented.map((u) => {
    const rule = active.find((r) => r.kind === "fact" && ruleMatchesText(r, u.factId));
    if (!rule) return u;
    used.add(rule);
    const out = { ...u, suppressed: true };
    if (rule.reason) out.suppressionReason = rule.reason;
    return out;
  });

  const summary = { ...report.summary, suppressed: verdicts.filter((v) => v.suppressed).length + undocumented.filter((u) => u.suppressed).length };

  return {
    report: { ...report, ignoreFile: ignore.path, verdicts, undocumented, summary },
    unusedRules: active.filter((r) => !used.has(r)),
    expiredRules,
  };
}
