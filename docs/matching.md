# How a claim is matched to the schema

This note explains the middle of the pipeline: how a claim extracted from the spec ends up compared against a handful of schema facts, and why the comparator's verdicts can be trusted or, when they cannot, how to find out why.

## The problem

After extraction there are two lists. On one side, a few dozen claims like "the `orders` query can be filtered by `customerId`". On the other, every fact the schema contains: on the fixture that is 75 facts, and on a real schema it can be thousands. Sending all of them to the model with every claim would be slow, expensive, and worse: the model would have to find the needle itself, and it would sometimes find the wrong one.

So there is a retrieval step in between. For each claim, pick the eight facts most likely to be relevant, render them with enough context to judge the claim, and send only those.

The consequence is that **retrieval recall is the ceiling on comparator accuracy**. If the right fact is not among the eight, the model cannot cite it and will, correctly given what it sees, say unmatched. That is why `test/retrieval-recall.test.ts` asserts that every labelled fact ID is retrieved for every labelled claim, and why `--verbose` prints the candidate list with reasons.

## Retrieval

Retrieval is deterministic. Nothing here calls a model.

**Fact tokens.** Each fact gets four token sets, from strongest to weakest evidence:

| Set | Contents | Example for `Order.shippingAddress` |
|---|---|---|
| primary | the fact's own name, lowercased, plus its singular | `shippingaddress` |
| parts | camelCase parts of the name | `shipping`, `address` |
| secondary | full names of what it belongs to: parent type, named type, field name for arguments, enum type for values | `order`, `address` |
| secondaryParts | camelCase parts of those | (none here) |

**Claim terms.** From each claim: the extractor's `mentions` (the identifiers it noticed, which are the strongest signal), qualified identifiers like `Order.status`, any token with a capital letter or underscore, and all remaining content words with stopwords removed and singulars added.

**Scoring.** A qualified identifier that equals a fact's full ID scores 3. Otherwise each claim identifier scores 1.0 against primary (1.25 if it came from `mentions`), 0.5 against parts, 0.4 against secondary, 0.15 against secondaryParts. Identifiers with no exact hit anywhere fall through to a fuzzy pass: character-trigram cosine similarity against primary tokens, scoring 0.7 times the similarity when it is at least 0.5. Content words score half of what identifiers do. Finally a small boost by fact kind depends on the claim type: a `type_exists` claim favours types, `field_args` favours arguments and fields, `enum_values` favours enum types and values.

Candidates are sorted by score, ties broken by ID so the order is stable, and the top eight are kept.

Two of those weights were wrong in the first draft, and the fixtures caught both:

- Parts scored the same as the full name, so `OrderStatus` (parts `order`, `status`) outranked `Order.status` (primary `status`) for the claim "Order has a status field".
- The full-ID bonus applied to bare type names, so the type `Order` always outranked its own fields.

Both are now regression-tested in `src/comparator/retrieval.test.ts`.

**What the fuzzy pass does and does not do.** Trigrams catch `statuses` versus `status`, `OrderStatuses` versus `OrderStatus`, and casing. They do not catch synonyms: "customer" will never find `User`. Anthropic has no embeddings endpoint, so a hosted embedder would mean a second provider. It is deferred until a real spec shows that synonym misses actually happen. The `Similarity` interface in `src/comparator/similarity.ts` is where one would plug in.

## Candidate cards

Each retrieved fact is rendered as a card that includes its surroundings, because most drift is about what is *missing*, and you cannot see an absence in a single fact:

- A **type** card lists every field with its full signature, or every value for an enum.
- A **field** card shows its type, nullability, arguments and deprecation, plus the names of its sibling fields.
- An **argument** card shows the field's complete signature, so a missing argument is visible.
- An **enum value** card lists every value of the enum.

This is what lets the comparator turn "Order exposes a trackingNumber field" into "Order has no trackingNumber field; its fields are customer, id, items, ..." while citing `Order`.

## Comparison

One model call per checkable claim, with the claim, its type, its mentions, its section, and the candidate cards. The response is constrained by a JSON schema to a classification, cited fact IDs, a difference sentence, a confidence and a one-line rationale.

The prompt encodes the decision rules:

- **Confirmed** if the candidates support the claim as stated.
- **Drifted** if the thing exists but differs, including a missing member on a parent that exists. The difference must name what the schema actually has.
- **Unmatched** if no candidate is about the claim's subject at all. Missing type means unmatched; missing field on an existing type means drifted.
- Wording rules: "required", "always has", "cannot be null" mean non-null. "accepts", "can be filtered by" are about arguments. A list of enum values is confirmed only if every one is present.

Two classes of claim never reach the model:

- **Not checkable** claim types (`behaviour`, `limit_or_policy`) are classified by rule.
- Claims with **zero candidates** are unmatched by rule. There is nothing to show the model.

## Invariants after the model answers

The model's answer is not taken at face value:

- Cited IDs that were not among the candidates are dropped. The model cannot invent a fact.
- A confirmed or drifted verdict that cites nothing has its confidence capped at 0.4.
- A drifted verdict with an empty difference gets a placeholder and the same cap.
- An unmatched verdict has its citations cleared.

These are cheap and they close the most common ways a plausible-sounding answer can be wrong.

## The reverse pass

After every claim has a verdict, the schema is walked once more. Any fact not cited by a confirmed or drifted verdict is **undocumented**, with a few exclusions to keep the list readable: root operation types (their fields matter, not the type), arguments (documented with their field), input object fields, and types that have at least one cited member.

This needs no model at all, which is why it is the part of the report engineers tend to trust first.

## Caching

Verdicts are cached by comparison prompt version, model, claim type, claim text, and a hash of every candidate fact shown. Change the schema so that any candidate changes, and the verdict is recomputed. Change an unrelated part of the schema, and it is not.

## Debugging a surprising verdict

1. Run with `--verbose`. Find the claim. Look at the candidate list and the reason string next to each candidate.
2. If the fact you expected is not there, it is a retrieval problem. Check what the extractor put in `mentions` for that claim; missing or mis-cased identifiers there are the usual cause. Then check the scoring weights above.
3. If the fact is there but the verdict is wrong, run with `--rationale` to see the model's one-line reasoning, and check the card rendering in `src/comparator/context.ts` shows what the model needed to see.
4. If the verdict is right and the label in `expected.json` is wrong, fix the label. The first recorded run found one of those.
