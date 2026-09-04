import { isCheckable, type Claim } from "../types/index.js";

/** Human-readable listing of extracted claims, grouped by heading path. */
export function renderClaims(claims: Claim[]): string {
  const lines: string[] = [];
  const groups = new Map<string, Claim[]>();
  for (const c of claims) {
    const key = c.source.headingPath.join(" > ") || "(preamble)";
    const g = groups.get(key) ?? [];
    g.push(c);
    groups.set(key, g);
  }

  for (const [heading, group] of groups) {
    lines.push(heading);
    for (const c of group) {
      const loc = c.source.lineStart === c.source.lineEnd ? `L${c.source.lineStart}` : `L${c.source.lineStart}-${c.source.lineEnd}`;
      const check = isCheckable(c.claimType) ? "" : "  (not checkable)";
      lines.push(`  [${c.claimType}] ${c.text}  (${loc}, conf ${c.confidence.toFixed(2)})${check}`);
    }
    lines.push("");
  }

  const checkable = claims.filter((c) => isCheckable(c.claimType)).length;
  lines.push(`${claims.length} claims, ${checkable} checkable against a GraphQL schema, ${claims.length - checkable} not checkable`);
  return lines.join("\n");
}
