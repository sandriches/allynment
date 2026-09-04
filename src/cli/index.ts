#!/usr/bin/env node
import { Command, Option } from "commander";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractFactsFromSchemaFile } from "../extractors/code/index.js";
import { ClaimCache, NoopClaimCache, extractClaimsFromSpecFile } from "../extractors/spec/index.js";
import { createLlmClient, type LlmFactoryOptions } from "../llm/index.js";
import { renderClaims } from "../report/claims.js";
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
    process.stdout.write((opts.json ? JSON.stringify(facts, null, 2) : renderFacts(facts)) + "\n");
  });

interface LlmCliOptions {
  llm: "anthropic" | "mock";
  model?: string;
  effort?: LlmFactoryOptions["effort"];
  recordings?: string;
  record?: boolean;
  cache: boolean;
  cacheDir: string;
  verbose?: boolean;
}

function addLlmOptions(cmd: Command): Command {
  return cmd
    .addOption(new Option("--llm <provider>", "LLM provider").choices(["anthropic", "mock"]).default("anthropic"))
    .option("--model <id>", "Pinned model ID (default: claude-opus-5)")
    .addOption(new Option("--effort <level>", "Model effort").choices(["low", "medium", "high", "xhigh", "max"]))
    .option("--recordings <dir>", "Directory of recorded LLM responses (replayed with --llm mock, written with --record)")
    .option("--record", "Record every LLM response into --recordings")
    .option("--no-cache", "Bypass the claim extraction cache")
    .option("--cache-dir <dir>", "Claim cache directory", ".spec-drift/cache")
    .option("--verbose", "Print per-section progress and token usage to stderr");
}

function buildLlm(opts: LlmCliOptions) {
  const factory: LlmFactoryOptions = { provider: opts.llm };
  if (opts.model) factory.model = opts.model;
  if (opts.effort) factory.effort = opts.effort;
  if (opts.recordings) factory.recordingsDir = opts.recordings;
  if (opts.record) factory.record = true;
  return createLlmClient(factory);
}

addLlmOptions(
  program
    .command("claims")
    .description("Extract claims from a Markdown spec (LLM-assisted).")
    .requiredOption("--spec <path>", "Path to a Markdown spec")
    .option("--json", "Emit JSON instead of a human-readable listing"),
).action(async (opts: LlmCliOptions & { spec: string; json?: boolean }) => {
  const { client, model } = buildLlm(opts);
  const cache = opts.cache ? new ClaimCache(join(opts.cacheDir, "claims")) : new NoopClaimCache();
  const result = await extractClaimsFromSpecFile(opts.spec, {
    llm: client,
    model,
    cache,
    ...(opts.verbose
      ? {
          onSection: (s) => {
            const heading = s.chunk.headingPath.join(" > ") || "(preamble)";
            const src = s.cached ? "cache" : `${s.inputTokens} in / ${s.outputTokens} out`;
            process.stderr.write(`  ${heading}: ${s.claims} claims (${src})\n`);
          },
        }
      : {}),
  });
  if (opts.verbose) {
    const u = result.usage;
    process.stderr.write(`${u.llmCalls} LLM calls, ${u.cachedSections} cached sections, ${u.inputTokens} input tokens, ${u.outputTokens} output tokens\n`);
  }
  process.stdout.write((opts.json ? JSON.stringify(result.claims, null, 2) : renderClaims(result.claims)) + "\n");
});

addLlmOptions(
  program
    .command("record-fixtures")
    .description("Run claim extraction over every fixture spec and record the LLM responses under <fixture>/recordings.")
    .option("--fixtures <dir>", "Fixtures directory", "fixtures")
    .option("--only <name>", "Only record the named fixture"),
).action(async (opts: LlmCliOptions & { fixtures: string; only?: string }) => {
  const dirs = readdirSync(opts.fixtures)
    .map((n) => join(opts.fixtures, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "expected.json")))
    .filter((p) => !opts.only || p.endsWith(opts.only));

  for (const dir of dirs) {
    const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as { spec: string };
    const specPath = resolve(dir, expected.spec);
    const recordingsDir = join(dir, "recordings");
    const { client, model } = buildLlm({ ...opts, llm: "anthropic", record: true, recordings: recordingsDir });
    process.stderr.write(`Recording ${dir} (${model})\n`);
    const result = await extractClaimsFromSpecFile(specPath, {
      llm: client,
      model,
      cache: new NoopClaimCache(),
      onSection: (s) => {
        const heading = s.chunk.headingPath.join(" > ") || "(preamble)";
        process.stderr.write(`  ${heading}: ${s.claims} claims (${s.inputTokens} in / ${s.outputTokens} out)\n`);
      },
    });
    process.stderr.write(`  ${result.claims.length} claims, ${result.usage.inputTokens} input tokens, ${result.usage.outputTokens} output tokens\n`);
  }
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
