# spec-drift

Diffs a living spec against a GraphQL schema and reports where the two have quietly parted ways.

Product docs and API specs rot. A field gets renamed, an argument is dropped, an enum value never ships, and nobody updates the document that promised it. `spec-drift` reads the spec, turns its prose into discrete claims, checks each one against the schema, and tells you which claims are still true, which have drifted, and which describe things the schema does not have at all.

```
$ spec-drift check --spec PRODUCT.md --schema schema.graphql

6 drifted  ·  3 unmatched  ·  35 undocumented  ·  10 not checkable  ·  15 confirmed

DRIFTED (6)
  ✗ `Order.shippingAddress` is required and cannot be null.
      PRODUCT.md:17  (Orders API > Orders)
      schema: Order.shippingAddress is nullable (Address), not non-null (Address!).
      facts:  Order.shippingAddress @ schema.graphql:30
  ...
```

## Why you can trust the report

The tool has two halves, and only one of them uses a language model.

**Code facts are deterministic.** The schema is parsed with `graphql-js` into a flat list of facts: every type, field, argument, enum value, its nullability, its arguments, its deprecation status, and the line it came from. No model is involved. Run it twice and you get the same bytes. This half is ground truth.

**Spec claims and matching are best effort.** Turning prose into checkable statements is a language problem, so a model does it. A second model call compares each claim against the handful of schema facts most likely to be relevant. Both calls use structured outputs, so the response is always schema-valid JSON, and both are cached on the content they saw, so an unchanged spec section never hits the model twice.

The report is honest about which half produced each result. A **drifted** verdict always cites the schema fact it disagrees with and states the difference in one sentence. If the model classified something wrongly, the citation is right there to check. And the tool refuses to guess about things a schema cannot answer: a claim like "users get an email when the order ships" is reported as **not checkable**, not as missing.

## Quick start

No API key is needed for the worked example. The fixtures ship with recorded model responses.

```
git clone <this repo> && cd spec-drift
npm install
npm test          # 125 tests, including evals against the recorded responses
npm run example   # the drift report below; exits 1 because there is drift
```

To run it on your own spec and schema you need Anthropic credentials in the environment (`ANTHROPIC_API_KEY`, or a profile from `ant auth login`):

```
npx tsx src/cli/index.ts check --spec docs/PRODUCT.md --schema schema.graphql
```

Or build it and use the binary:

```
npm run build
node dist/cli/index.js check --spec docs/PRODUCT.md --schema schema.graphql
```

The first run on a spec makes one model call per heading section plus one per checkable claim. Subsequent runs only re-check sections whose text changed. Pass `--verbose` to see per-section token counts and the candidate list behind every verdict.

## Reading the report

Every claim lands in exactly one bucket, listed in the order you should read them.

| Bucket | Meaning | What to do |
|---|---|---|
| **drifted** | The schema has the thing the claim is about, but it differs. Wrong type, wrong nullability, a field or argument or enum value missing from a parent that exists, a deprecation the schema does not mark. | Fix the spec or fix the schema. The `schema:` line says exactly what the code does instead. |
| **unmatched** | Nothing in the schema is about this. Usually a type that does not exist. | Either it was never built, or it was removed and the spec was not updated. |
| **undocumented** | Schema types and fields no claim mentions. The reverse question: what does the code have that the spec never describes? | Skim for things that should be documented. This list is deliberately complete and therefore noisy. |
| **not checkable** | Behavioural, workflow, policy and limit claims. A GraphQL schema cannot confirm or refute them. | Nothing here is wrong. These need a different source of truth, such as tests or feature flags. |
| **confirmed** | The schema supports the claim as stated. | Nothing. |
| **suppressed** | Listed in the ignore file. Still present in the JSON output. | Review occasionally. The CLI warns when a rule has expired or matches nothing. |

**Drifted versus unmatched for missing things.** If a claim mentions a field, argument or enum value that does not exist but its parent does, that is drifted, and the verdict cites the parent and lists what it actually has. If the type itself does not exist, that is unmatched. A missing field on an existing type is a much more actionable finding than "not found", which is why the two are kept apart.

**Why not checkable is a first-class result.** In a typical product spec most sentences are behavioural. If the tool only had a schema to compare against and reported all of those as unmatched, the unmatched count would be meaningless and nobody would read the report. Tagging each claim with the kind of evidence it needs, and saying plainly when that evidence is not loaded, is what keeps the other buckets trustworthy.

## Worked example

`fixtures/orders-api` is a small orders API. The spec was written to contain one genuine drift of every kind the tool can detect, plus behavioural claims and a type that was never built. The schema is the ground truth. `fixtures/orders-api/expected.json` labels every claim with the classification a careful engineer would give it, and the test suite checks the tool against those labels.

Run it with `npm run example`. This is the actual output from the recorded model responses, trimmed to the interesting sections:

```
spec-drift report
  spec:    fixtures/orders-api/spec.md
  schema:  fixtures/orders-api/schema.graphql
  model:   claude-opus-5  (prompts extract v2, compare v1)

6 drifted  ·  3 unmatched  ·  35 undocumented  ·  10 not checkable  ·  15 confirmed

DRIFTED (6)
  ✗ `Order.placedAt` is a `String` in ISO-8601 format.
      fixtures/orders-api/spec.md:15  (Orders API > Orders)
      schema: Order.placedAt is DateTime! (non-null DateTime), not String.
      facts:  Order.placedAt @ fixtures/orders-api/schema.graphql:27
      confidence 0.97

  ✗ `Order.shippingAddress` is required and cannot be null.
      fixtures/orders-api/spec.md:17  (Orders API > Orders)
      schema: Order.shippingAddress is nullable (Address), not non-null (Address!).
      facts:  Order.shippingAddress @ fixtures/orders-api/schema.graphql:30
      confidence 0.97

  ✗ `Order` has a `trackingNumber` field.
      fixtures/orders-api/spec.md:19  (Orders API > Orders)
      schema: Order has no trackingNumber field; its fields are customer, id, items, note, placedAt, shippingAddress, status, total.
      facts:  Order @ fixtures/orders-api/schema.graphql:20
      confidence 0.95

  ✗ The `note` field on `Order` is deprecated.
      fixtures/orders-api/spec.md:21  (Orders API > Orders)
      schema: Order.note exists as a nullable String but is not deprecated in the schema.
      facts:  Order.note @ fixtures/orders-api/schema.graphql:29
      confidence 0.95

  ✗ The OrderStatus enum includes REFUNDED.
      fixtures/orders-api/spec.md:29  (Orders API > Orders > Order status)
      schema: OrderStatus contains CANCELLED, DELIVERED, PAID, PENDING, SHIPPED; REFUNDED is not present.
      facts:  OrderStatus @ fixtures/orders-api/schema.graphql:57
      confidence 0.97

  ✗ The `orders` query can be filtered by `customerId`.
      fixtures/orders-api/spec.md:39  (Orders API > Querying orders)
      schema: Query.orders only accepts after, first and status arguments; there is no customerId argument.
      facts:  Query.orders @ fixtures/orders-api/schema.graphql:103
      confidence 0.95

UNMATCHED (3)
  Claims about things the schema does not have at all. Either unimplemented, or the spec is out of date.

  ? A Refund type exists.
      fixtures/orders-api/spec.md:33  (Orders API > Orders > Refunds)

  ? Refund has a reason field.
      fixtures/orders-api/spec.md:33  (Orders API > Orders > Refunds)

  ? Refund has an amount field.
      fixtures/orders-api/spec.md:33  (Orders API > Orders > Refunds)

NOT CHECKABLE (10)
  Behavioural and policy claims. A GraphQL schema cannot confirm or refute these; they need a different source.

  – User.email is unique.  [limit_or_policy]
  – An order may contain at most 50 line items.  [limit_or_policy]
  – Users can cancel an order at any point until it has shipped.  [behaviour]
  – Customers receive a confirmation email when an order is shipped.  [behaviour]
  ...
```

Every one of the six drifts was planted in the spec, and every one was caught with a difference sentence you could paste into a ticket. Note the three Refund claims: the spec sentence "A `Refund` type records money returned to the customer, including the amount and the reason" became a type-exists claim and two field claims. Because `Refund` does not exist in the schema, all three are unmatched rather than drifted. That is the rule above in action.

The companion fixture `fixtures/orders-api-clean` has a spec that matches the schema exactly. `npm run example:clean` reports zero drifted and zero unmatched, and exits 0. Any drift reported there would be a false positive.

On the recorded run, the evaluation harness scores precision and recall of 1.00 for every bucket on both fixtures.

## Accepting a known difference

Sometimes the spec is intentionally ahead of the code. Put accepted differences in `.specdriftignore` so they stop appearing every run:

```
# one rule per line; trailing comment is the reason and appears in the report
text:*REFUNDED*         until=2026-12-31   # refunds ship in Q4
claim:4b34e1501e8b98c1                     # claim id from the JSON report
fact:OrderConnection.totalCount            # internal field, not part of the public spec
```

`claim:` matches a claim id, `text:` matches claim text with `*` wildcards, `fact:` matches an undocumented fact id. Only drifted, unmatched and undocumented items can be suppressed. Suppressed items stay in the JSON output flagged `suppressed: true` and are listed at the end of the terminal report. When a rule expires or matches nothing, the CLI says so, so the file cannot silently rot.

## Determinism

An LLM-backed linter that gives different answers on different days is worse than no linter. The tool controls what it can:

- **Pinned model.** `claude-opus-5` by default, never a floating alias. The model name is part of every cache key and is recorded in the report.
- **Structured outputs.** Every model response is constrained to a JSON schema, so parsing never fails and classification is always one of the allowed values. Current Claude models do not accept a temperature parameter; consistency comes from the pinned model, fixed prompts, fixed effort, and caching.
- **Content-hash caches.** Extracted claims are cached by prompt version, model, heading path and section text. Verdicts are cached by prompt version, model, claim, and the exact schema facts shown. Editing one paragraph re-checks only that paragraph. Caches live in `.spec-drift/cache`; pass `--no-cache` to bypass.
- **Stable JSON.** `--json` and `--out` emit sorted keys and deterministic array order. Two runs on identical inputs are byte-identical apart from `generatedAt`, so you can diff reports.
- **Provenance.** Every report records the tool version, model, and both prompt versions, so a diff between two reports can be read knowing whether the tool changed or the inputs did.
- **Post-hoc invariants.** Cited fact IDs must be among the candidates shown to the model. A drifted verdict with no stated difference is flagged and its confidence capped. An unmatched verdict cites nothing.

What it cannot control: the model can still phrase the same claim differently on a re-extraction of changed text, and can occasionally split or merge sentences differently. Claim IDs are hashes of text, type and section, so a re-phrased claim gets a new ID. Use `text:` rules rather than `claim:` rules in the ignore file when the wording might move.

## Known false-positive patterns

Things observed on the fixtures, and how they are handled.

- **One sentence, several claims.** "A `Refund` type records money returned to the customer, including the amount and the reason" produces three claims. That is correct, not noise, but it means one wrong sentence can show up three times. The report groups by section so this reads naturally.
- **Description mistaken for behaviour.** "`Order.status` tracks where the order is in the fulfilment process" is classified as behaviour and lands in not checkable, even though the field exists. The extractor also emits "Order has a status field" as a separate claim, which is confirmed. Descriptive prose about what a field means is not a schema claim, and the tool is right not to pretend otherwise.
- **Uniqueness and other constraints.** "User.email is unique" is a limit-or-policy claim. GraphQL schemas do not express uniqueness. Not checkable is the honest answer.
- **The undocumented list is long.** It is a complete listing of schema members no claim refers to, grouped by parent. On the fixture that is 35 items including scalars and input types. Suppress internals with `fact:` rules, or pass `--hide-undocumented` to see only the count.
- **Retrieval, not the model, is the usual cause of a wrong verdict.** The comparator can only judge against the candidates it is shown. If the right fact is not retrieved, the model will answer unmatched. `--verbose` prints the candidate list and the reasons each candidate scored, which is the first thing to look at when a verdict is surprising. See [docs/matching.md](docs/matching.md).
- **Evaluation harness bugs look like tool bugs.** On the first recorded run, two of four eval failures were the test matcher rejecting correct paraphrases. When an eval fails, check the harness before the prompt.

## Using it in CI

`check` exits 1 when there is unsuppressed drift, so it can gate a pipeline as is. `--fail-on unmatched` also fails on unmatched claims; `--fail-on none` never fails. Write the JSON alongside the terminal report with `--out report.json` and keep it as an artifact.

Model calls cost money and take time. With the cache directory persisted between runs, a PR that touches one section of the spec re-checks only that section.

## Limitations and roadmap

- **GraphQL schema is the only code-fact source.** REST routes, feature flags and config constants are the natural next sources, and each unlocks new claim types and shrinks the not-checkable bucket.
- **Retrieval does not understand synonyms.** "Customer" will not find a `User` type unless the claim also names it. The fuzzy pass is local character-trigram similarity, which handles casing, plurals and near-spellings only. A hosted embedder is a possible later addition; it has been deferred until a real spec shows synonym misses actually happen.
- **Markdown only.** Notion and other live sources would need an importer.
- **No history.** Each run is independent. Trend tracking is on the roadmap.

The full plan, including the reasoning behind each decision, is in [docs/spec-drift-detector-plan.md](docs/spec-drift-detector-plan.md).

## Who this is for

For engineers, it is schema-as-ground-truth tooling: the API doc lies, and this proves it deterministically from the schema. The undocumented list is the part engineers tend to find most credible, because it needs no model judgement at all.

For product owners, it is spec hygiene: the PRD does not match reality, and here is exactly where. The not-checkable bucket doubles as a to-do list of claims that need a different verification path.

## Development

```
npm test                 # unit tests, fixture validation, and evals against recordings
npm run typecheck
npm run example          # drift fixture, from recordings
npm run example:clean    # clean fixture, from recordings
npm run record-fixtures  # re-record model responses (needs credentials; ~50 calls)
```

Layout:

```
src/extractors/code/    GraphQL schema -> facts (deterministic)
src/extractors/spec/    Markdown -> sections -> claims (model, cached)
src/comparator/         retrieval, comparison prompt, verdict invariants, reverse pass
src/report/             terminal and JSON rendering
src/ignore.ts           .specdriftignore parsing and application
src/pipeline.ts         wires the stages into a Report
src/llm/                Anthropic adapter, recording mock, hashing
fixtures/<name>/        spec.md, schema.graphql, expected.json, recordings/
test/eval/              the claim matcher used by the eval tests
```

Recorded responses are keyed on the full request, so any change to a prompt or a fixture spec requires re-recording that fixture. When recordings are missing the eval tests skip and print the command to record them, so a fresh clone stays green.
