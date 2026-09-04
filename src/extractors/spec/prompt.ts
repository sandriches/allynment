import { CLAIM_TYPES } from "../../types/index.js";
import type { SpecChunk } from "./markdown.js";
import { numberedBody } from "./markdown.js";

/** Bump when the prompt or response schema changes so cached extractions are invalidated. */
export const PROMPT_VERSION = "1";

export const EXTRACT_PURPOSE = "extract-claims";

export const SYSTEM_PROMPT = `You extract discrete, checkable claims from a product or API specification so they can be compared against a GraphQL schema.

A claim is a single assertion about what the API or product does. Split compound sentences into separate claims when they assert different things, but keep an enumeration together as one claim (for example "OrderStatus includes PENDING, PAID and SHIPPED" is one claim, not three).

Classify each claim with exactly one claim_type:

- type_exists: a named type, entity or object exists (for example "there is an Order type", "every customer has a User account").
- field_exists: a named field, query, mutation or property exists on a type (for example "Order has a status field", "clients cancel with the cancelOrder mutation").
- field_type: a field has a particular type (for example "Order.total is a Money value", "placedAt is a String").
- field_nullability: a field is required, optional, nullable or non-null.
- field_args: a field, query or mutation accepts or is filtered by particular arguments.
- enum_values: an enum contains particular values.
- deprecation: a field or value is deprecated or will be removed.
- behaviour: what the system does at runtime, a workflow, a side effect, an email, a permission. Cannot be verified from a schema.
- limit_or_policy: a numeric limit, quota, pricing tier or business rule. Cannot be verified from a schema.

Rules:
- Rewrite each claim as a short, self-contained sentence. Resolve pronouns and use the exact identifiers from the text (type names, field names, enum values) with their original casing. Prefer the form Type.field when both are known.
- Only extract claims that make an assertion. Skip introductions, motivation, and statements about the document itself.
- Do not infer claims that the text does not make. If a sentence says a field is optional, do not also emit a claim that the field exists unless the text separately asserts it.
- mentions must list every schema-like identifier the claim refers to: type names, field names, argument names, enum values. Use original casing.
- line_start and line_end are the absolute line numbers shown in the left margin of the input for the sentence(s) the claim came from.
- confidence is your confidence, from 0 to 1, that this is a real claim classified correctly.
- If a section contains no claims, return an empty list.`;

export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "claim_type", "confidence", "mentions", "line_start", "line_end"],
        properties: {
          text: { type: "string" },
          claim_type: { type: "string", enum: [...CLAIM_TYPES] },
          confidence: { type: "number" },
          mentions: { type: "array", items: { type: "string" } },
          line_start: { type: "integer" },
          line_end: { type: "integer" },
        },
      },
    },
  },
} as const;

export function buildUserPrompt(chunk: SpecChunk): string {
  const heading = chunk.headingPath.length > 0 ? chunk.headingPath.join(" > ") : "(preamble, no heading)";
  return `Document: ${chunk.file}\nSection: ${heading}\n\n${numberedBody(chunk)}`;
}
