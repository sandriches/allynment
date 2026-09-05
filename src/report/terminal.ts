import type { Claim, CodeFact, Report, UndocumentedFact, Verdict } from "../types/index.js";

export interface TerminalReportOptions {
  /** ANSI colour. Default off; the CLI turns it on for a TTY. */
  color?: boolean;
  /** Show confirmed claims individually rather than as a count. Default true. */
  showConfirmed?: boolean;
  /** Show every undocumented fact. Default true. */
  showUndocumented?: boolean;
  /** Show the model's rationale under each verdict. Default false. */
  showRationale?: boolean;
}

type Paint = (s: string) => string;

function palette(color: boolean): Record<"red" | "yellow" | "green" | "cyan" | "dim" | "bold" | "magenta", Paint> {
  const wrap = (code: number): Paint => (color ? (s) => `[${code}m${s}[0m` : (s) => s);
  return { red: wrap(31), yellow: wrap(33), green: wrap(32), cyan: wrap(36), dim: wrap(2), bold: wrap(1), magenta: wrap(35) };
}

/**
 * Human-readable drift report. Ordered by what needs attention first:
 * drifted, unmatched, undocumented, not checkable, confirmed, then suppressed items.
 * A reader should be able to act on the drifted section without opening the code.
 */
export function renderReport(report: Report, opts: TerminalReportOptions = {}): string {
  const p = palette(opts.color ?? false);
  const showConfirmed = opts.showConfirmed ?? true;
  const showUndocumented = opts.showUndocumented ?? true;
  const showRationale = opts.showRationale ?? false;

  const claims = new Map(report.claims.map((c) => [c.id, c]));
  const facts = new Map(report.facts.map((f) => [f.id, f]));
  const out: string[] = [];

  const by = (cls: Verdict["classification"], suppressed: boolean) =>
    report.verdicts.filter((v) => v.classification === cls && v.suppressed === suppressed);
  const drifted = by("drifted", false);
  const unmatched = by("unmatched", false);
  const notCheckable = by("not_checkable", false);
  const confirmed = by("confirmed", false);
  const undocumented = report.undocumented.filter((u) => !u.suppressed);
  const suppressedVerdicts = report.verdicts.filter((v) => v.suppressed);
  const suppressedFacts = report.undocumented.filter((u) => u.suppressed);

  out.push(p.bold("spec-drift report"));
  out.push(`  spec:    ${report.spec}`);
  out.push(`  schema:  ${report.sources.join(", ")}`);
  out.push(`  model:   ${report.provenance.model}  (prompts extract v${report.provenance.extractPromptVersion}, compare v${report.provenance.comparePromptVersion})`);
  if (report.ignoreFile) out.push(`  ignore:  ${report.ignoreFile}`);
  out.push("");
  out.push(
    [
      p.red(`${drifted.length} drifted`),
      p.yellow(`${unmatched.length} unmatched`),
      p.magenta(`${undocumented.length} undocumented`),
      p.dim(`${notCheckable.length} not checkable`),
      p.green(`${confirmed.length} confirmed`),
      ...(report.summary.suppressed > 0 ? [p.dim(`${report.summary.suppressed} suppressed`)] : []),
    ].join("  ·  "),
  );
  out.push("");

  section(out, p.red(`DRIFTED (${drifted.length})`), drifted.length === 0 ? "The schema matches every claim it could be checked against." : undefined);
  for (const v of drifted) {
    const c = claims.get(v.claimId)!;
    out.push(`  ${p.red("✗")} ${c.text}`);
    out.push(`      ${p.dim(where(c))}`);
    out.push(`      ${p.bold("schema:")} ${v.difference ?? "(no difference stated)"}`);
    if (v.matchedFactIds.length > 0) out.push(`      ${p.dim("facts: ")} ${v.matchedFactIds.map((id) => factRef(id, facts)).join(", ")}`);
    if (showRationale && v.rationale) out.push(`      ${p.dim("why:   ")} ${v.rationale}`);
    out.push(`      ${p.dim(`confidence ${v.confidence.toFixed(2)}`)}`);
    out.push("");
  }

  section(out, p.yellow(`UNMATCHED (${unmatched.length})`), unmatched.length === 0 ? "Every checkable claim found something in the schema to compare against." : "Claims about things the schema does not have at all. Either unimplemented, or the spec is out of date.");
  for (const v of unmatched) {
    const c = claims.get(v.claimId)!;
    out.push(`  ${p.yellow("?")} ${c.text}`);
    out.push(`      ${p.dim(where(c))}`);
    if (showRationale && v.rationale) out.push(`      ${p.dim("why:   ")} ${v.rationale}`);
    out.push("");
  }

  section(out, p.magenta(`UNDOCUMENTED (${undocumented.length})`), undocumented.length === 0 ? "Every schema type and field is mentioned by the spec." : "Schema types and fields no claim refers to. The spec does not describe these.");
  if (showUndocumented && undocumented.length > 0) {
    for (const [parent, ids] of groupUndocumented(undocumented, facts)) {
      out.push(`  ${p.magenta("•")} ${p.bold(parent)}${ids.length > 0 ? `: ${ids.join(", ")}` : ""}`);
    }
    out.push("");
  }

  section(out, p.dim(`NOT CHECKABLE (${notCheckable.length})`), "Behavioural and policy claims. A GraphQL schema cannot confirm or refute these; they need a different source.");
  for (const v of notCheckable) {
    const c = claims.get(v.claimId)!;
    out.push(`  ${p.dim("–")} ${c.text}  ${p.dim(`[${c.claimType}]`)}`);
  }
  if (notCheckable.length > 0) out.push("");

  section(out, p.green(`CONFIRMED (${confirmed.length})`));
  if (showConfirmed) {
    for (const v of confirmed) {
      const c = claims.get(v.claimId)!;
      out.push(`  ${p.green("✓")} ${c.text}  ${p.dim(v.matchedFactIds.join(", "))}`);
    }
    if (confirmed.length > 0) out.push("");
  }

  if (suppressedVerdicts.length + suppressedFacts.length > 0) {
    section(out, p.dim(`SUPPRESSED (${suppressedVerdicts.length + suppressedFacts.length})`), `Listed in ${report.ignoreFile ?? "the ignore file"}. Still present in the JSON output.`);
    for (const v of suppressedVerdicts) {
      const c = claims.get(v.claimId)!;
      out.push(`  ${p.dim("~")} ${v.classification}: ${c.text}${v.suppressionReason ? p.dim(`  # ${v.suppressionReason}`) : ""}`);
    }
    for (const u of suppressedFacts) {
      out.push(`  ${p.dim("~")} undocumented: ${u.factId}${u.suppressionReason ? p.dim(`  # ${u.suppressionReason}`) : ""}`);
    }
    out.push("");
  }

  return out.join("\n").trimEnd() + "\n";
}

function section(out: string[], title: string, note?: string): void {
  out.push(title);
  if (note) out.push(`  ${note}`);
  if (note) out.push("");
}

function where(c: Claim): string {
  const loc = c.source.lineStart === c.source.lineEnd ? `${c.source.lineStart}` : `${c.source.lineStart}-${c.source.lineEnd}`;
  return `${c.source.file}:${loc}  (${c.source.headingPath.join(" > ")})`;
}

function factRef(id: string, facts: Map<string, CodeFact>): string {
  const f = facts.get(id);
  if (!f) return id;
  return f.origin.line !== undefined ? `${id} @ ${f.origin.file}:${f.origin.line}` : id;
}

/** Group undocumented fact ids under their parent type for a compact listing. */
function groupUndocumented(items: UndocumentedFact[], facts: Map<string, CodeFact>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const u of items) {
    const f = facts.get(u.factId);
    let parent: string;
    let member: string | null;
    if (!f || f.kind === "type") {
      parent = u.factId;
      member = null;
    } else if (f.kind === "enum_value") {
      parent = f.enumType;
      member = f.name;
    } else if (f.kind === "argument") {
      parent = `${f.parentType}.${f.fieldName}`;
      member = f.name;
    } else {
      parent = f.parentType;
      member = f.name;
    }
    const arr = groups.get(parent) ?? [];
    if (member) arr.push(member);
    groups.set(parent, arr);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}
