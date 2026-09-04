/**
 * Shared contracts for the whole pipeline. Every other module imports from here.
 * Keep this file free of runtime dependencies.
 */

/** Claim types the spec extractor is allowed to emit. See the plan's claim taxonomy. */
export const CLAIM_TYPES = [
  "type_exists",
  "field_exists",
  "field_type",
  "field_nullability",
  "field_args",
  "enum_values",
  "deprecation",
  "behaviour",
  "limit_or_policy",
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];

/** Claim types that can be verified against a GraphQL schema. */
export const GRAPHQL_CHECKABLE_CLAIM_TYPES: ReadonlySet<ClaimType> = new Set<ClaimType>([
  "type_exists",
  "field_exists",
  "field_type",
  "field_nullability",
  "field_args",
  "enum_values",
  "deprecation",
]);

export function isCheckable(type: ClaimType): boolean {
  return GRAPHQL_CHECKABLE_CLAIM_TYPES.has(type);
}

/** Where in the spec a claim came from. */
export interface SourceLocation {
  file: string;
  /** Heading path from the document root, e.g. ["Orders", "Pagination"]. */
  headingPath: string[];
  lineStart: number;
  lineEnd: number;
}

/** A discrete, checkable statement extracted from the spec. */
export interface Claim {
  /** Stable hash of (text, claimType, headingPath). */
  id: string;
  text: string;
  claimType: ClaimType;
  /** Extractor confidence in [0, 1]. */
  confidence: number;
  source: SourceLocation;
  /** Schema-ish identifiers noticed in the text, e.g. ["Order", "status"]. Used as retrieval hints. */
  mentions: string[];
}

export const CODE_FACT_KINDS = ["type", "field", "argument", "enum_value"] as const;

export type CodeFactKind = (typeof CODE_FACT_KINDS)[number];

/** Base shape shared by all code facts. `id` is stable and human-readable, e.g. "Order.status". */
interface CodeFactBase {
  id: string;
  kind: CodeFactKind;
  /** Source of the fact, for traceability. */
  origin: { file: string; line?: number };
  description?: string;
}

export type GraphQLTypeKind = "OBJECT" | "INTERFACE" | "UNION" | "ENUM" | "INPUT_OBJECT" | "SCALAR";

export interface TypeFact extends CodeFactBase {
  kind: "type";
  name: string;
  typeKind: GraphQLTypeKind;
  /** For OBJECT/INTERFACE: implemented interfaces. For UNION: member types. */
  members?: string[];
}

export interface FieldFact extends CodeFactBase {
  kind: "field";
  parentType: string;
  name: string;
  /** Rendered type string as written in SDL, e.g. "[Order!]!". */
  type: string;
  /** Innermost named type, e.g. "Order". */
  namedType: string;
  nullable: boolean;
  isList: boolean;
  argumentNames: string[];
  deprecated: boolean;
  deprecationReason?: string;
}

export interface ArgumentFact extends CodeFactBase {
  kind: "argument";
  parentType: string;
  fieldName: string;
  name: string;
  type: string;
  namedType: string;
  nullable: boolean;
  hasDefault: boolean;
  defaultValue?: string;
}

export interface EnumValueFact extends CodeFactBase {
  kind: "enum_value";
  enumType: string;
  name: string;
  deprecated: boolean;
  deprecationReason?: string;
}

export type CodeFact = TypeFact | FieldFact | ArgumentFact | EnumValueFact;

export const CLASSIFICATIONS = ["confirmed", "drifted", "unmatched", "not_checkable"] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

/** The comparator's verdict on one claim. */
export interface Verdict {
  claimId: string;
  classification: Classification;
  /** Fact IDs the verdict was based on. Empty for unmatched / not_checkable. */
  matchedFactIds: string[];
  /** Required when classification is "drifted": what the code does differently. */
  difference?: string;
  /** Comparator confidence in [0, 1]. */
  confidence: number;
  /** True if the claim was listed in .specdriftignore. */
  suppressed: boolean;
  /** Short model explanation, for logs. Not shown in the default report. */
  rationale?: string;
}

/** A code fact with no confirmed or drifted claim referring to it. */
export interface UndocumentedFact {
  factId: string;
}

export interface Report {
  generatedAt: string;
  spec: string;
  sources: string[];
  claims: Claim[];
  facts: CodeFact[];
  verdicts: Verdict[];
  undocumented: UndocumentedFact[];
  summary: Record<Classification | "undocumented" | "suppressed", number>;
}
