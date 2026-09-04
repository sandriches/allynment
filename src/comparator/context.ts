import type { ArgumentFact, CodeFact, EnumValueFact, FieldFact, TypeFact } from "../types/index.js";
import type { FactIndex } from "./retrieval.js";

/**
 * Render a candidate fact as a self-contained "card" for the comparison prompt.
 * Each card includes enough surrounding context to judge a claim about a missing member:
 * a type lists its fields, a field lists its siblings and arguments, an enum value lists the
 * whole enum, an argument lists the field's full signature.
 */
export function renderFactCard(fact: CodeFact, index: FactIndex): string {
  switch (fact.kind) {
    case "type":
      return renderType(fact, index);
    case "field":
      return renderField(fact, index);
    case "argument":
      return renderArgument(fact, index);
    case "enum_value":
      return renderEnumValue(fact, index);
  }
}

function fieldSignature(f: FieldFact, index: FactIndex): string {
  const args = index.argsByField.get(`${f.parentType}.${f.name}`) ?? [];
  const argStr = args.length > 0 ? `(${args.map(argSignature).join(", ")})` : "";
  const dep = f.deprecated ? ` @deprecated${f.deprecationReason ? `(reason: "${f.deprecationReason}")` : ""}` : "";
  return `${f.name}${argStr}: ${f.type}${dep}`;
}

function argSignature(a: ArgumentFact): string {
  return `${a.name}: ${a.type}${a.hasDefault ? ` = ${a.defaultValue}` : ""}`;
}

function renderType(t: TypeFact, index: FactIndex): string {
  const lines: string[] = [];
  const head = t.typeKind === "ENUM" ? "enum" : t.typeKind === "INPUT_OBJECT" ? "input" : t.typeKind.toLowerCase();
  lines.push(`[${t.id}] ${head} ${t.name}${t.members?.length ? ` (${t.typeKind === "UNION" ? "members" : "implements"}: ${t.members.join(", ")})` : ""}`);
  if (t.description) lines.push(`  description: ${t.description}`);
  if (t.typeKind === "ENUM") {
    const values = index.valuesByEnum.get(t.name) ?? [];
    lines.push(`  values: ${values.map((v) => v.name + (v.deprecated ? " (deprecated)" : "")).join(", ") || "(none)"}`);
  } else if (t.typeKind === "OBJECT" || t.typeKind === "INTERFACE" || t.typeKind === "INPUT_OBJECT") {
    const fields = index.fieldsByParent.get(t.name) ?? [];
    lines.push(`  fields (${fields.length}):`);
    for (const f of fields) lines.push(`    ${fieldSignature(f, index)}`);
  }
  return lines.join("\n");
}

function renderField(f: FieldFact, index: FactIndex): string {
  const lines: string[] = [];
  lines.push(`[${f.id}] field ${f.parentType}.${fieldSignature(f, index)}`);
  lines.push(`  nullable: ${f.nullable}; list: ${f.isList}; named type: ${f.namedType}; deprecated: ${f.deprecated}`);
  if (f.description) lines.push(`  description: ${f.description}`);
  const siblings = (index.fieldsByParent.get(f.parentType) ?? []).filter((s) => s.id !== f.id).map((s) => s.name);
  if (siblings.length > 0) lines.push(`  other fields on ${f.parentType}: ${siblings.join(", ")}`);
  return lines.join("\n");
}

function renderArgument(a: ArgumentFact, index: FactIndex): string {
  const lines: string[] = [];
  lines.push(`[${a.id}] argument ${a.name} on ${a.parentType}.${a.fieldName}: ${a.type}${a.hasDefault ? ` = ${a.defaultValue}` : ""}`);
  lines.push(`  nullable: ${a.nullable}; named type: ${a.namedType}`);
  if (a.description) lines.push(`  description: ${a.description}`);
  const field = index.byId.get(`${a.parentType}.${a.fieldName}`);
  if (field && field.kind === "field") lines.push(`  full signature: ${a.parentType}.${fieldSignature(field, index)}`);
  return lines.join("\n");
}

function renderEnumValue(v: EnumValueFact, index: FactIndex): string {
  const lines: string[] = [];
  lines.push(`[${v.id}] enum value ${v.name} of ${v.enumType}${v.deprecated ? ` @deprecated${v.deprecationReason ? `(reason: "${v.deprecationReason}")` : ""}` : ""}`);
  if (v.description) lines.push(`  description: ${v.description}`);
  const all = index.valuesByEnum.get(v.enumType) ?? [];
  lines.push(`  all values of ${v.enumType}: ${all.map((x) => x.name).join(", ")}`);
  return lines.join("\n");
}
