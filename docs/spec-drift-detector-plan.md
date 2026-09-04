# Spec Drift Detector — Project Plan

Continuously diffs a living spec/PRD against an actual codebase and flags where the implementation has silently diverged from what the spec claims — the "nobody updated the doc" problem, made visible instead of discovered three sprints later.

## Core idea

Two independent extraction pipelines feeding one comparison layer:

- **Spec facts** — parse a Markdown/Notion doc into a list of discrete, checkable claims ("the `Order` type exposes a `status` field", "`User.email` is required", "the `/orders` endpoint supports pagination"). This extraction is where the LLM does the real work: turning prose into structured, comparable statements.
- **Code facts** — statically extract what's actually true of the codebase right now: API routes and their params, GraphQL schema types/fields, feature flag definitions and their current values, maybe config constants. This is deterministic static analysis, not LLM — you want it to be trustworthy ground truth.
- **Comparator** — matches spec facts to relevant code facts (semantic matching, likely LLM-assisted) and classifies each pair as: confirmed, drifted (spec says X, code does Y), unmatched (spec claims something checkable with no corresponding code found), or **not checkable** (the claim is real but cannot be verified from the code-fact sources currently loaded).

The trustworthiness of the whole tool rests on code facts being deterministic and spec facts/matching being clearly labeled as "best effort, review these" — this distinction is worth making explicit in the README, since it's the difference between a useful tool and a noisy one nobody trusts.

### Why "not checkable" is a first-class result

A GraphQL schema tells you what types and fields exist, their nullability, deprecation and enum values. It says nothing about behaviour ("users can reset their password via email", "free tier is capped at 3 projects"). In a typical PRD the majority of claims are behavioural, so if the MVP only has a schema to compare against, most claims would land in "unmatched" for structural reasons, not because anything drifted. That makes the report look noisy on day one and erodes trust before the tool has a chance.

The fix is to have the spec extractor tag each claim with the kind of evidence it would need, and have the comparator report "not checkable with current sources" separately from "checkable but missing". The unmatched count then means something.

### Drifted vs unmatched for missing things

A claim about something that does not exist in the schema is classified by whether its *parent* exists:

- Missing **type** (e.g. "there is a `Refund` type" and there is no `Refund`) is **unmatched**. Nothing in the code anchors the claim.
- Missing **field, argument or enum value** on a type that does exist (e.g. "`Order` has a `trackingNumber` field") is **drifted**, citing the parent. The comparator can say concretely what the parent has instead, which is more useful than a bare "not found".

The fixtures encode this rule and the comparator prompt should state it explicitly.

### Claim taxonomy

The spec extractor must emit a `claim_type` from a fixed set. This drives both the extraction prompt and what the comparator is allowed to do with the claim. MVP set (GraphQL-checkable):

| claim_type | Example claim | Checkable against |
|---|---|---|
| `type_exists` | "There is a `Subscription` type" | schema types |
| `field_exists` | "`Order` has a `status` field" | type fields |
| `field_type` | "`Order.total` is a `Money`" | field return type |
| `field_nullability` | "`User.email` is required" | nullable flag |
| `field_args` | "`orders` accepts `first` and `after`" | field arguments |
| `enum_values` | "`OrderStatus` includes `REFUNDED`" | enum members |
| `deprecation` | "`legacyId` is deprecated" | `@deprecated` directive |
| `behaviour` | "users can reset their password via email" | nothing in MVP → not checkable |
| `limit_or_policy` | "free tier is capped at 3 projects" | nothing in MVP → not checkable |

Anything the LLM cannot fit into the first seven lands in `behaviour` or `limit_or_policy` and is reported as not checkable. New code-fact sources (REST routes, feature flags) unlock new claim types in later versions.

## Architecture

```
/extractors
  /spec        — Markdown/Notion parser → structured claims (LLM-assisted)
  /code        — static analysis: routes, GraphQL schema, feature flags → structured facts
/comparator     — retrieval (lexical + embedding) → LLM compare → classify drift
/report         — output formats: CLI summary, HTML/JSON report, GitHub PR comment
/cli            — entrypoint: point at a spec file + a repo, get a drift report
/fixtures       — labelled spec + schema pairs with expected drift, used as the eval set
/docs           — write-up on the deterministic/LLM split, matching approach, false-positive handling
```

**Stack:** TypeScript / Node. `remark` for Markdown, `graphql-js` for schema parsing, `ts-morph` later for REST extraction. LLM calls behind a single thin adapter so the provider/model can be swapped and mocked in tests.

## Determinism and reproducibility

Two LLM stages means the same inputs can produce different reports, and a flapping report is worse than no report once this runs in CI. Rules from day one:

- Pin the model version explicitly in config; never rely on a floating alias.
- Structured outputs (`output_config.format` with a JSON schema) so responses are always schema-valid JSON. Current Claude models reject the `temperature` parameter, so determinism comes from a pinned model, a fixed prompt, a fixed effort level, and caching, not from sampling settings.
- Cache extracted claims keyed by a content hash of the spec section. Re-run extraction only for sections whose text changed.
- Cache comparator verdicts keyed by (claim hash, candidate code-fact hashes).
- JSON output is sorted and stable so two runs on identical inputs produce a byte-identical report. Diffing reports is a feature, not an accident.

## Retrieval (how the comparator narrows candidates)

"Narrow candidates first, then compare" needs a concrete mechanism so that misses are debuggable rather than mysterious.

1. **Lexical pass** — tokenise the claim text, match against type names, field names, argument names and enum values in the schema. Score by overlap. Cheap and usually enough for API-shaped claims.
2. **Fuzzy pass** — character-trigram cosine similarity between claim identifiers and fact names, behind a small `Similarity` interface. Catches casing, plurals and near-spellings. It does **not** catch synonyms ("customer" vs `User`). Anthropic has no embeddings endpoint, so a hosted embedder (for example Voyage) would mean a second provider and key; defer that until the real-world trial shows synonym misses actually happen.
3. **Union, dedupe, cap** — pass at most N candidates (start with 8) to the LLM comparison step.
4. **Log the candidate list** for every claim in verbose mode, with the reasons each candidate scored. When the matcher misses, the answer to "why" should be in the log, not in someone's head.

Scoring notes learned from the fixtures: a full-name match must outrank a camelCase-part match (otherwise `OrderStatus` beats `Order.status` for a claim about status), and the large exact-id bonus applies only to qualified identifiers like `Order.status`, never to a bare type name (otherwise a parent type always outranks its own fields). Candidate cards sent to the comparator include context: a type lists its fields, a field its siblings and arguments, an enum value the whole enum. That is what lets the comparator report a missing member as drift against the parent.

## Handling accepted differences

Sometimes the spec is intentionally ahead of the code, or a difference is known and accepted. Without a way to say so, every run re-reports the same items and people stop reading. Support a `.specdriftignore` (or a block in the config file) that lists claim IDs or claim-text patterns to suppress, optionally with an expiry date and a reason. Suppressed items still appear in the JSON output with a `suppressed` flag so nothing is silently hidden.

## Cost and token budgeting

Large specs make the extraction step expensive. Chunk by heading, extract per section, and rely on the content-hash cache so only changed sections are re-sent. Report token usage per run in verbose mode. Set a configurable budget and fail loudly rather than silently truncating.

## Evaluation

There is no way to know whether the comparator is any good without a labelled set. Build this before the comparator, not after:

- `/fixtures/<name>/spec.md`, `schema.graphql`, and `expected.json` listing each claim's expected classification and, for drifted items, the expected explanation gist.
- Start with one realistic fixture containing genuine drift of every claim type in the taxonomy. Add a second with no drift to catch false positives.
- A test runs the full pipeline against each fixture and reports precision/recall per classification. Run on every change.
- This fixture set doubles as the worked example in the README, so the effort pays for itself twice.

## MVP scope

Goal: point the tool at one real spec doc and one real (or realistic sample) codebase, and get a genuinely useful drift report — not a demo that only works on a hand-crafted example.

**Fixtures + eval (first)**
- [ ] Write one realistic spec + schema fixture with labelled expected output covering every MVP claim type
- [ ] Write a no-drift fixture for false-positive detection
- [ ] Pipeline test harness that scores precision/recall per classification

**Code extractor**
- [ ] GraphQL schema (SDL or introspection) via `graphql-js`
- [ ] Extract types, fields, argument lists, nullability, enum values, deprecation into structured facts
- [ ] Keep this fully deterministic — no LLM in this half

**Spec extractor**
- [ ] Markdown parser (`remark`) to walk the doc structure and chunk by heading
- [ ] LLM pass to extract discrete claims from each section, tagged with source location (heading/line) for traceability
- [ ] Constrain LLM output to structured JSON: claim text, `claim_type` from the taxonomy, confidence
- [ ] Content-hash cache so unchanged sections are not re-extracted

**Comparator**
- [ ] Lexical + embedding retrieval producing a capped candidate list per claim
- [ ] LLM comparison step over claim + candidates, verdict cached by input hash
- [ ] Classify: confirmed / drifted / unmatched / not checkable
- [ ] For "drifted," require the comparator to state *what* differs, not just flag it — this is what makes the report actionable instead of just anxiety-inducing
- [ ] **Reverse pass:** list schema types and fields with no matching claim (undocumented functionality). This needs no LLM matching beyond what already ran, and is the result engineers will trust first.

**Report + CLI**
- [ ] CLI: `spec-drift check --spec ./PRODUCT.md --schema ./schema.graphql`
- [ ] Human-readable terminal summary grouped by drifted / unmatched / undocumented / not checkable / confirmed, in that order
- [ ] Stable, sorted JSON output for programmatic use later (e.g. CI)
- [ ] `.specdriftignore` support with suppressed items still present in JSON
- [ ] `--verbose` logs candidate lists and token usage

**Docs**
- [ ] README explaining the deterministic-vs-LLM split and why it matters for trust
- [ ] Worked example using the fixture: real drift, the tool catching it, and the not-checkable bucket explained
- [ ] Explicit section on known false-positive patterns and how they are handled
- [ ] Section on determinism guarantees and what can still vary between runs

## Build steps

The MVP checklist above is grouped by component. This section orders the work into steps that each end with something runnable and testable, so progress is visible and the design can be corrected early. Steps 2 and 3 are independent and can be done in either order.

### Step 0 — Scaffold ✅
- TypeScript project, `vitest`, a `spec-drift` bin that prints help.
- Shared types in one module: `Claim`, `CodeFact`, `Verdict`, `Report`. Everything downstream imports from here.
- `LlmClient` interface with two implementations: a real provider adapter and a `MockLlmClient` that replays recorded responses from disk. All tests use the mock.
- **Done when:** `npm test` passes on an empty suite and `spec-drift --help` runs.

### Step 1 — Fixtures and contracts ✅
- Write `/fixtures/orders-api/` with `spec.md`, `schema.graphql`, and `expected.json`. The spec must contain at least one claim of every checkable type and at least two genuinely drifted ones, plus a handful of behavioural claims that should land in not checkable.
- Write `/fixtures/orders-api-clean/` where the spec matches the schema exactly.
- Write a JSON Schema for `expected.json` and validate both fixtures against it in a test.
- **Done when:** the fixtures exist, validate, and a human has read them and agreed the expected output is right. Nothing runs yet.

### Step 2 — Code extractor ✅
- `graphql-js` loads SDL, walks types, fields, args, nullability, enum values, `@deprecated`.
- Emits `CodeFact[]` with stable IDs (`Order.status`, `OrderStatus.REFUNDED`).
- Snapshot test against both fixture schemas.
- **Done when:** `spec-drift facts --schema fixtures/orders-api/schema.graphql` prints the fact list and the snapshot test is green. No LLM involved.

### Step 3 — Spec extractor ✅ (code) / ⏳ (recordings)
- `remark` parses `spec.md`, chunks by heading, records line ranges.
- Extraction prompt asks for `Claim[]` per chunk, constrained to the taxonomy, with source location and confidence.
- Content-hash cache in `.spec-drift/cache/`.
- Record real LLM responses for the fixtures once, commit them, and drive tests through `MockLlmClient`. Recordings live in `fixtures/<name>/recordings/` and are keyed on the full request, so any prompt change requires re-recording with `spec-drift record-fixtures`.
- The eval test (`test/claims-eval.test.ts`) skips a fixture with no recordings and says how to record them, so the suite stays green on a fresh clone without an API key.
- **Done when:** `spec-drift claims --spec fixtures/orders-api/spec.md` prints claims, and a test asserts every claim in `expected.json` is found with the correct `claim_type`. Missed or mis-typed claims are the first real signal about prompt quality.

### Step 4 — Retrieval ✅
- Lexical scorer over fact IDs and names. Embedding index over facts, cached to disk.
- `retrieve(claim, facts) -> CodeFact[]` capped at N.
- Test: for every checkable claim in the fixtures, the correct fact appears in the candidate list. This is a recall test and it should be at or near 100 percent before moving on, because the comparator cannot recover from a retrieval miss.
- **Done when:** the recall test is green and `--verbose` prints candidates per claim.

### Step 5 — Comparator ✅ (code) / ⏳ (recordings + eval bar)
- Comparison prompt takes one claim and its candidates, returns classification plus a one-sentence "what differs" for drifted.
- Not-checkable claims skip the LLM entirely and are classified by `claim_type`.
- Verdict cache keyed by claim hash plus candidate hashes.
- Reverse pass: facts with no confirmed or drifted claim become `undocumented`.
- **Done when:** the eval harness runs end to end on both fixtures and reports precision and recall per classification. Set a bar (for example no false drift on the clean fixture, all expected drift found on the other) and iterate on prompts until it is met.

### Step 6 — Report and CLI
- Terminal report grouped drifted, unmatched, undocumented, not checkable, confirmed.
- `--json` output, sorted and stable. Test that two runs produce identical bytes.
- `.specdriftignore` with `suppressed` flag in JSON.
- `spec-drift check --spec ... --schema ...` wires the whole pipeline together.
- **Done when:** running `check` against the fixture produces a report a stranger could act on without reading the code.

### Step 7 — Docs and worked example
- README: deterministic-vs-LLM split, determinism guarantees, false-positive patterns, the not-checkable bucket, and the fixture as a worked example with actual output pasted in.
- Short write-up in `/docs` on the retrieval and matching approach.
- **Done when:** someone who has never seen the project can run the worked example from the README and get the same output.

### Step 8 — Real-world trial
- Point the tool at one real spec and one real schema, not a fixture.
- Log every false positive, false negative, and confusing result into the false-positive section of the README and into new fixture cases where appropriate.
- **Done when:** the results have been triaged and the plan for v2 has been adjusted based on what actually went wrong.

## Future updates (post-MVP)

- **More code fact sources** — REST route extraction (via NestJS decorators/`ts-morph`), feature flag definitions, config constants. Each unlocks new claim types and shrinks the not-checkable bucket.
- **CI/GitHub integration** — run on PR, post drift summary as a PR comment, fail/warn on new unmatched-critical claims. Depends on the stable-output work above.
- **Notion as a live spec source** — pull directly via API instead of a static Markdown file, so it fits how PMs actually work
- **Drift history/trend tracking** — store reports over time, show whether drift is growing or shrinking per area of the spec
- **Confidence-based triage** — auto-file low-confidence matches for human review vs. surfacing high-confidence drift immediately
- **Claim-to-code traceability links** — clickable links from a claim straight to the relevant schema field/route in the repo
- **Web dashboard** — visual report instead of CLI-only
- **Multi-spec support** — reconcile multiple spec docs (e.g. PRD + API design doc) against each other, not just against code

## Notes on scope discipline

Starting with GraphQL schema-only as the code-fact source keeps the MVP honest and achievable — it's a clean, well-typed source you already know deeply, and it avoids the much harder problem of extracting "facts" from arbitrary REST route handlers on day one. REST/route extraction is a natural and impressive v2 addition once the core pipeline is proven.

The trade-off is that a schema-only MVP can verify only API-shaped claims. That is fine as long as the report says so honestly via the not-checkable bucket, and as long as the worked-example spec is written with enough API-level detail to exercise the tool.

## Portfolio framing

Kept separate from the engineering checklist so the MVP stays about shipping.

- **Engineers:** schema-as-ground-truth tooling. The pitch is "your API doc lies and this proves it, deterministically, from the schema." The reverse pass (undocumented fields) is the hook here.
- **Product owners / TPOs:** spec hygiene. The pitch is "your PRD doesn't match reality and here is exactly where." The not-checkable bucket doubles as a prompt: these are the claims that need a different verification path.
- The README's deterministic-vs-LLM section is the piece to lead with for both audiences, since it explains why the tool can be trusted at all.
