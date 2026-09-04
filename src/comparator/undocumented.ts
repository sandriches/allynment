import type { CodeFact, UndocumentedFact, Verdict } from "../types/index.js";

const ROOT_TYPES = new Set(["Query", "Mutation", "Subscription"]);

/**
 * Reverse pass: which schema facts does no confirmed or drifted claim refer to?
 *
 * A fact counts as documented if a confirmed or drifted verdict cites it directly, or if it is a
 * type and any of its fields or values is cited (a type whose members are discussed is documented).
 * Root operation types are skipped because their fields are what matters, not the type itself.
 * Arguments are skipped because they are documented implicitly with their field. Input object
 * fields are skipped for the same reason as arguments.
 */
export function findUndocumented(facts: CodeFact[], verdicts: Verdict[]): UndocumentedFact[] {
  const cited = new Set<string>();
  for (const v of verdicts) {
    if (v.classification === "confirmed" || v.classification === "drifted") {
      for (const id of v.matchedFactIds) cited.add(id);
    }
  }

  const inputTypes = new Set(facts.filter((f) => f.kind === "type" && f.typeKind === "INPUT_OBJECT").map((f) => f.name));

  const parentsWithCitedMembers = new Set<string>();
  for (const f of facts) {
    if (!cited.has(f.id)) continue;
    if (f.kind === "field") parentsWithCitedMembers.add(f.parentType);
    if (f.kind === "enum_value") parentsWithCitedMembers.add(f.enumType);
    if (f.kind === "argument") {
      parentsWithCitedMembers.add(f.parentType);
      parentsWithCitedMembers.add(`${f.parentType}.${f.fieldName}`);
    }
  }

  const out: UndocumentedFact[] = [];
  for (const f of facts) {
    if (cited.has(f.id)) continue;
    if (f.kind === "argument") continue;
    if (f.kind === "type" && ROOT_TYPES.has(f.name)) continue;
    if (f.kind === "type" && parentsWithCitedMembers.has(f.name)) continue;
    if (f.kind === "field" && (inputTypes.has(f.parentType) || parentsWithCitedMembers.has(f.id))) continue;
    out.push({ factId: f.id });
  }
  out.sort((a, b) => (a.factId < b.factId ? -1 : 1));
  return out;
}
