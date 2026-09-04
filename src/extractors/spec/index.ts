import { readFileSync } from "node:fs";
import { chunkMarkdown } from "./markdown.js";
import { extractClaims, type ExtractOptions, type ExtractResult } from "./extract.js";

export { chunkMarkdown, type SpecChunk } from "./markdown.js";
export { extractClaims, buildRequest, type ExtractOptions, type ExtractResult } from "./extract.js";
export { ClaimCache, NoopClaimCache } from "./cache.js";
export { PROMPT_VERSION } from "./prompt.js";

/** Read a spec file, chunk it, and extract claims. */
export async function extractClaimsFromSpecFile(path: string, opts: ExtractOptions): Promise<ExtractResult> {
  const markdown = readFileSync(path, "utf8");
  const chunks = chunkMarkdown(markdown, path);
  return extractClaims(chunks, opts);
}
