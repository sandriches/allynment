import type { CodeFact } from "../types/index.js";

/** Human-readable listing of code facts, grouped by parent type. */
export function renderFacts(facts: CodeFact[]): string {
  const lines: string[] = [];
  const byType = new Map<string, CodeFact[]>();

  for (const f of facts) {
    const key = f.kind === "type" ? f.name : f.kind === "enum_value" ? f.enumType : f.parentType;
    const bucket = byType.get(key) ?? [];
    bucket.push(f);
    byType.set(key, bucket);
  }

  for (const [typeName, group] of byType) {
    const typeFact = group.find((f) => f.kind === "type");
    const header = typeFact && typeFact.kind === "type" ? `${typeFact.typeKind} ${typeName}` : typeName;
    lines.push(header);
    for (const f of group) {
      if (f.kind === "type") continue;
      lines.push(`  ${describe(f)}`);
    }
    lines.push("");
  }

  lines.push(`${facts.length} facts`);
  return lines.join("\n");
}

function describe(f: CodeFact): string {
  switch (f.kind) {
    case "field": {
      const flags: string[] = [];
      if (f.deprecated) flags.push("deprecated");
      if (f.argumentNames.length > 0) flags.push(`args: ${f.argumentNames.join(", ")}`);
      return `${f.name}: ${f.type}${flags.length ? `  [${flags.join("; ")}]` : ""}`;
    }
    case "argument":
      return `${f.fieldName}(${f.name}: ${f.type}${f.hasDefault ? ` = ${f.defaultValue}` : ""})`;
    case "enum_value":
      return `${f.name}${f.deprecated ? "  [deprecated]" : ""}`;
    case "type":
      return f.name;
  }
}
