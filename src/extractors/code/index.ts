import { readFileSync } from "node:fs";
import type { CodeFact } from "../../types/index.js";
import { extractGraphqlFacts } from "./graphql.js";

export { extractGraphqlFacts } from "./graphql.js";

/** Load a GraphQL SDL file from disk and extract facts. `file` in each fact is the path as given. */
export function extractFactsFromSchemaFile(path: string): CodeFact[] {
  const sdl = readFileSync(path, "utf8");
  return extractGraphqlFacts(sdl, path);
}
