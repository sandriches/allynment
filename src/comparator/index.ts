export { buildFactIndex, retrieve, claimTerms, splitIdentifier, type Candidate, type FactIndex, type RetrievalOptions } from "./retrieval.js";
export { TrigramSimilarity, type Similarity } from "./similarity.js";
export { renderFactCard } from "./context.js";
export { compareClaims, buildCompareRequest, verdictCacheKey, toVerdict, parseVerdict, type CompareOptions, type CompareResult, type ClaimTrace } from "./compare.js";
export { findUndocumented } from "./undocumented.js";
export { COMPARE_PROMPT_VERSION } from "./prompt.js";
