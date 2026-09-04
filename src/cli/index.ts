#!/usr/bin/env node
import { Command } from "commander";
import { extractFactsFromSchemaFile } from "../extractors/code/index.js";
import { renderFacts } from "../report/facts.js";

const program = new Command();

program
  .name("spec-drift")
  .description("Diffs a living spec against a codebase and reports where they have drifted apart.")
  .version("0.1.0");

program
  .command("facts")
  .description("Extract code facts from a GraphQL schema (deterministic, no LLM).")
  .requiredOption("--schema <path>", "Path to a GraphQL SDL file")
  .option("--json", "Emit JSON instead of a human-readable listing")
  .action((opts: { schema: string; json?: boolean }) => {
    const facts = extractFactsFromSchemaFile(opts.schema);
    if (opts.json) {
      process.stdout.write(JSON.stringify(facts, null, 2) + "\n");
    } else {
      process.stdout.write(renderFacts(facts) + "\n");
    }
  });

program
  .command("claims")
  .description("Extract claims from a spec document (LLM-assisted). Not implemented yet.")
  .requiredOption("--spec <path>", "Path to a Markdown spec")
  .action(() => {
    process.stderr.write("spec-drift claims: not implemented yet (build step 3)\n");
    process.exitCode = 2;
  });

program
  .command("check")
  .description("Run the full pipeline and report drift. Not implemented yet.")
  .requiredOption("--spec <path>", "Path to a Markdown spec")
  .requiredOption("--schema <path>", "Path to a GraphQL SDL file")
  .action(() => {
    process.stderr.write("spec-drift check: not implemented yet (build step 6)\n");
    process.exitCode = 2;
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`spec-drift: ${msg}\n`);
  process.exitCode = 1;
});
