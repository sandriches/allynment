import type {
  ArgumentFact,
  Claim,
  ClaimType,
  CodeFact,
  CodeFactKind,
  EnumValueFact,
  FieldFact,
} from "../types/index.js";
import { TrigramSimilarity, type Similarity } from "./similarity.js";

/**
 * Retrieval: narrow the full fact list to a handful of candidates for one claim.
 *
 * Two passes, both deterministic:
 *  1. Lexical: exact matches between claim terms (mentions, identifier-like tokens, words) and
 *     fact tokens (own name, camelCase parts, singular form, parent/enum/field names).
 *  2. Fuzzy: character-trigram similarity for identifier terms with no exact hit.
 *
 * Every candidate carries the reasons it scored, so a retrieval miss can be debugged from the log.
 */

export interface Candidate {
  fact: CodeFact;
  score: number;
  reasons: string[];
}

export interface RetrievalOptions {
  /** Maximum candidates returned. */
  limit?: number;
  similarity?: Similarity;
  /** Minimum trigram similarity to count as a fuzzy hit. */
  fuzzyThreshold?: number;
}

interface FactTokens {
  /** The fact's own name, lowercased, plus its singular form. */
  primary: Set<string>;
  /** camelCase parts of the fact's own name. Weaker evidence than the full name. */
  parts: Set<string>;
  /** Full names of things the fact belongs to: parent type, enum type, field name, named type. */
  secondary: Set<string>;
  /** camelCase parts of the secondary names. Weakest evidence. */
  secondaryParts: Set<string>;
  idLower: string;
}

export interface FactIndex {
  facts: CodeFact[];
  byId: Map<string, CodeFact>;
  fieldsByParent: Map<string, FieldFact[]>;
  argsByField: Map<string, ArgumentFact[]>;
  valuesByEnum: Map<string, EnumValueFact[]>;
  tokens: Map<string, FactTokens>;
}

export function buildFactIndex(facts: CodeFact[]): FactIndex {
  const index: FactIndex = {
    facts,
    byId: new Map(),
    fieldsByParent: new Map(),
    argsByField: new Map(),
    valuesByEnum: new Map(),
    tokens: new Map(),
  };
  for (const f of facts) {
    index.byId.set(f.id, f);
    index.tokens.set(f.id, tokensFor(f));
    switch (f.kind) {
      case "field":
        push(index.fieldsByParent, f.parentType, f);
        break;
      case "argument":
        push(index.argsByField, `${f.parentType}.${f.fieldName}`, f);
        break;
      case "enum_value":
        push(index.valuesByEnum, f.enumType, f);
        break;
      case "type":
        break;
    }
  }
  return index;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k) ?? [];
  arr.push(v);
  m.set(k, arr);
}

/** Split camelCase / PascalCase / snake_case into lowercase parts. */
export function splitIdentifier(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

export function singular(w: string): string | null {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && (w.endsWith("ses") || w.endsWith("xes") || w.endsWith("ches") || w.endsWith("shes"))) return w.slice(0, -2);
  if (w.endsWith("ss") || w.endsWith("us") || w.endsWith("is")) return null;
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return null;
}

/** Add a name (and its singular) to `full`, and its camelCase parts (and their singulars) to `parts`. */
function addName(full: Set<string>, parts: Set<string>, name: string): void {
  const lower = name.toLowerCase();
  full.add(lower);
  const s = singular(lower);
  if (s) full.add(s);
  const split = splitIdentifier(name);
  if (split.length > 1) {
    for (const part of split) {
      parts.add(part);
      const ps = singular(part);
      if (ps) parts.add(ps);
    }
  }
}

function tokensFor(f: CodeFact): FactTokens {
  const primary = new Set<string>();
  const parts = new Set<string>();
  const secondary = new Set<string>();
  const secondaryParts = new Set<string>();
  addName(primary, parts, f.name);
  switch (f.kind) {
    case "field":
      addName(secondary, secondaryParts, f.parentType);
      addName(secondary, secondaryParts, f.namedType);
      break;
    case "argument":
      addName(secondary, secondaryParts, f.parentType);
      addName(secondary, secondaryParts, f.fieldName);
      addName(secondary, secondaryParts, f.namedType);
      break;
    case "enum_value":
      addName(secondary, secondaryParts, f.enumType);
      break;
    case "type":
      break;
  }
  return { primary, parts, secondary, secondaryParts, idLower: f.id.toLowerCase() };
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "be", "has", "have", "of", "on", "in", "to", "and", "or", "for", "with", "by", "at",
  "it", "its", "this", "that", "there", "which", "as", "can", "will", "was", "were", "not", "no", "also", "when",
  "type", "field", "fields", "value", "values", "query", "mutation", "includes", "include", "accepts", "accept",
  "argument", "arguments", "required", "optional", "nullable", "null", "deprecated", "exists", "exposes", "via",
  "returns", "return", "each", "every", "all", "any", "may", "must", "should", "always", "never", "once", "set",
]);

interface ClaimTerms {
  /** Dotted or exact identifiers from mentions, lowercased, e.g. "order.status". */
  ids: Set<string>;
  /** Identifier-like tokens (from mentions and capitalised / camelCase words), lowercased. */
  identifiers: Set<string>;
  /** Remaining content words, lowercased, plus singular forms. */
  words: Set<string>;
}

export function claimTerms(claim: Claim): ClaimTerms {
  const ids = new Set<string>();
  const identifiers = new Set<string>();
  const words = new Set<string>();

  for (const m of claim.mentions) {
    const trimmed = m.trim().replace(/\(\)$/, "");
    if (!trimmed) continue;
    ids.add(trimmed.toLowerCase());
    for (const part of trimmed.split(/[.()]/)) {
      if (!part) continue;
      identifiers.add(part.toLowerCase());
      for (const p of splitIdentifier(part)) words.add(p);
    }
  }

  for (const tok of claim.text.split(/[^A-Za-z0-9_.]+/)) {
    if (!tok) continue;
    const parts = tok.split(".").filter(Boolean);
    if (parts.length > 1) ids.add(tok.toLowerCase().replace(/\.$/, ""));
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (STOPWORDS.has(lower)) continue;
      const looksLikeIdentifier = /[A-Z_]/.test(part) || parts.length > 1;
      if (looksLikeIdentifier) identifiers.add(lower);
      words.add(lower);
      const s = singular(lower);
      if (s) words.add(s);
      for (const p of splitIdentifier(part)) {
        words.add(p);
        const ps = singular(p);
        if (ps) words.add(ps);
      }
    }
  }

  // Sentence-initial capitalised stopwords are not identifiers.
  for (const w of [...identifiers]) if (STOPWORDS.has(w)) identifiers.delete(w);

  return { ids, identifiers, words };
}

const KIND_BOOST: Record<ClaimType, Partial<Record<CodeFactKind | "enum_type", number>>> = {
  type_exists: { type: 0.5 },
  field_exists: { field: 0.3, type: 0.2 },
  field_type: { field: 0.3 },
  field_nullability: { field: 0.3 },
  field_args: { argument: 0.3, field: 0.3 },
  enum_values: { enum_value: 0.3, enum_type: 0.4 },
  deprecation: { field: 0.3, enum_value: 0.3 },
  behaviour: {},
  limit_or_policy: {},
};

export function scoreFact(claim: Claim, terms: ClaimTerms, fact: CodeFact, tokens: FactTokens, sim: Similarity, fuzzyThreshold: number): Candidate {
  let score = 0;
  const reasons: string[] = [];
  const mentionSet = new Set(claim.mentions.map((m) => m.toLowerCase()));

  // Full-id bonus only for qualified identifiers ("Order.status", "orders(first)"). A bare type
  // name is a name match like any other, otherwise a parent type always outranks its own fields.
  for (const id of terms.ids) {
    if (id === tokens.idLower && /[.(]/.test(id)) {
      score += 3;
      reasons.push(`id match "${id}"`);
    }
  }

  const hit = new Set<string>();
  for (const t of terms.identifiers) {
    if (tokens.primary.has(t)) {
      const w = mentionSet.has(t) ? 1.25 : 1.0;
      score += w;
      hit.add(t);
      reasons.push(`name "${t}"`);
    } else if (tokens.parts.has(t)) {
      score += 0.5;
      hit.add(t);
      reasons.push(`name part "${t}"`);
    } else if (tokens.secondary.has(t)) {
      score += 0.4;
      hit.add(t);
      reasons.push(`context "${t}"`);
    } else if (tokens.secondaryParts.has(t)) {
      score += 0.15;
      hit.add(t);
      reasons.push(`context part "${t}"`);
    } else {
      let best = 0;
      let bestTok = "";
      for (const p of tokens.primary) {
        const s = sim.score(t, p);
        if (s > best) {
          best = s;
          bestTok = p;
        }
      }
      if (best >= fuzzyThreshold) {
        score += 0.7 * best;
        hit.add(t);
        reasons.push(`fuzzy "${t}"~"${bestTok}" ${best.toFixed(2)}`);
      }
    }
  }

  for (const w of terms.words) {
    if (hit.has(w)) continue;
    if (tokens.primary.has(w)) {
      score += 0.5;
      reasons.push(`word "${w}"`);
    } else if (tokens.parts.has(w)) {
      score += 0.25;
      reasons.push(`word part "${w}"`);
    } else if (tokens.secondary.has(w)) {
      score += 0.2;
      reasons.push(`context word "${w}"`);
    } else if (tokens.secondaryParts.has(w)) {
      score += 0.1;
      reasons.push(`context word part "${w}"`);
    }
  }

  if (score > 0) {
    const boosts = KIND_BOOST[claim.claimType];
    const kindKey: CodeFactKind | "enum_type" = fact.kind === "type" && fact.typeKind === "ENUM" ? "enum_type" : fact.kind;
    const boost = boosts[kindKey] ?? (kindKey === "enum_type" ? boosts.type : undefined) ?? 0;
    if (boost > 0) {
      score += boost;
      reasons.push(`kind ${fact.kind}`);
    }
  }

  return { fact, score, reasons };
}

export function retrieve(claim: Claim, index: FactIndex, opts: RetrievalOptions = {}): Candidate[] {
  const limit = opts.limit ?? 8;
  const sim = opts.similarity ?? new TrigramSimilarity();
  const fuzzyThreshold = opts.fuzzyThreshold ?? 0.5;
  const terms = claimTerms(claim);

  const scored: Candidate[] = [];
  for (const fact of index.facts) {
    const c = scoreFact(claim, terms, fact, index.tokens.get(fact.id)!, sim, fuzzyThreshold);
    if (c.score > 0) scored.push(c);
  }
  scored.sort((a, b) => b.score - a.score || (a.fact.id < b.fact.id ? -1 : 1));
  return scored.slice(0, limit);
}
