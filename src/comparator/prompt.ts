import type { Claim } from "../types/index.js";
import type { Candidate, FactIndex } from "./retrieval.js";
import { renderFactCard } from "./context.js";

/** Bump when the prompt or response schema changes so cached verdicts are invalidated. */
export const COMPARE_PROMPT_VERSION = "1";

export const COMPARE_PURPOSE = "compare-claim";

export const COMPARE_SYSTEM_PROMPT = `You compare one claim taken from a product specification against candidate facts extracted deterministically from a GraphQL schema, and decide whether the schema matches the claim.

The schema facts are ground truth. The claim is what the document says. Your job is to say whether the document is still telling the truth.

Classify as exactly one of:
- confirmed: the candidate facts support the claim as stated.
- drifted: the schema has the thing the claim is about, but it differs from what the claim says. This includes: a different type, different nullability, a field or argument or enum value that is missing from a parent that does exist, a deprecation status that differs, a default value that differs.
- unmatched: none of the candidate facts is about the thing the claim refers to. Use this when the type or entity the claim is about does not exist among the candidates at all.

The rule for missing things: if the parent exists but the member does not, that is drifted, and you cite the parent. If the type itself does not exist, that is unmatched.

Rules:
- Only use the candidate facts. Do not assume the schema contains anything not shown. If the claim is about something no candidate covers, answer unmatched even if the claim sounds plausible.
- matched_fact_ids must be IDs copied exactly from the candidate list, in square brackets in the input. For confirmed, list the facts that support the claim. For drifted, list the facts that differ, or the parent when a member is missing. Empty for unmatched.
- difference is required for drifted: one sentence stating concretely what the schema has instead of what the claim says. Name the actual type, value or member. Leave it as an empty string for confirmed and unmatched.
- "required", "always has", "cannot be null", "mandatory" mean non-null in the schema, which is a type ending in an exclamation mark. "optional", "may be null", "nullable" mean the type has no exclamation mark.
- A claim that a query or field "accepts", "takes", "supports" or "can be filtered by" something is about that field's arguments.
- A claim listing several enum values is confirmed only if every listed value is present. If some are missing, it is drifted and the difference names the missing ones.
- A claim that something is deprecated is confirmed only if the fact is marked deprecated. A claim that something is deprecated when it is not marked so is drifted.
- confidence is a number from 0 to 1.
- rationale is one or two short sentences explaining the decision, for a log. Do not restate the claim.`;

export const COMPARE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["classification", "matched_fact_ids", "difference", "confidence", "rationale"],
  properties: {
    classification: { type: "string", enum: ["confirmed", "drifted", "unmatched"] },
    matched_fact_ids: { type: "array", items: { type: "string" } },
    difference: { type: "string" },
    confidence: { type: "number" },
    rationale: { type: "string" },
  },
} as const;

export function buildCompareUserPrompt(claim: Claim, candidates: Candidate[], index: FactIndex): string {
  const lines: string[] = [];
  lines.push(`Claim: ${claim.text}`);
  lines.push(`Claim type: ${claim.claimType}`);
  if (claim.mentions.length > 0) lines.push(`Identifiers mentioned: ${claim.mentions.join(", ")}`);
  lines.push(`Source: ${claim.source.headingPath.join(" > ")}`);
  lines.push("");
  lines.push(`Candidate schema facts (${candidates.length}):`);
  lines.push("");
  for (const c of candidates) {
    lines.push(renderFactCard(c.fact, index));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
