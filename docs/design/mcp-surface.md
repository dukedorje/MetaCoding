# MCP surface

Small, typed, opinionated. Specific tools the agent will actually call rather
than a Cypher passthrough that requires the agent to author graph queries.

> **Discovery.** The live, authoritative tool list is whatever
> `describe_api` returns — it is generated from `TOOL_DESCRIPTIONS` in
> `src/mcp/tools.ts` (core + LSP) spliced with `CTKR_TOOL_DESCRIPTIONS` in
> `src/mcp/ctkr-tools.ts` (the `ctkr.*` family). A drift guard
> (`src/mcp/describe-api.test.ts`) fails if any registered tool is missing
> from that list, so an agent harness that calls `describe_api` always sees
> the full surface. This document is the human-readable companion; when the
> two disagree, `describe_api` is right and this file is stale.

Server identity: `name: "metacoding"`, stdio transport, one server per data
dir (`src/mcp/server.ts`). Read-only by design.

---

## Core graph tools

### `graph_neighbors`
```
input:  symbol (id or qualified_name), direction (in|out|both), edge_kinds? (filter), limit=50, repo_commit_sha?
output: list of Symbol with edge metadata
```
The workhorse. "What does this touch / what touches this."

### `graph_implementers`
```
input:  symbol (id or qualified_name), limit=50, repo_commit_sha?
output: list of Symbol implementing or extending it (incoming IMPLEMENTS/EXTENDS)
```
The interface-consumer trick from the 2026 paper, first-class. "Which classes
implement `IOrderService`?"

### `graph_callers`
```
input:  symbol, limit=50, repo_commit_sha?
output: list of Symbol that call or reference this one (incoming CALLS/REFERENCES)
```
"Who depends on this function?" Convenience wrapper over `graph_neighbors`.
Available only after a SCIP pass — Tree-sitter alone can't resolve cross-file
references.

### `graph_diff`
```
input:  repo, from_sha, to_sha, limit=1000
output: { added, removed, changed } Symbol rows (changed = same qualified_name, different ast_hash)
```
"What changed between these two indexed snapshots?" Requires both snapshots to
coexist in the store — usually means the repo was indexed with
`--per-commit-identity`.

### `graph_cypher`
```
input:  cypher, params?, limit=100
output: rows
```
Escape hatch. Don't lean on it; if a query type is common, promote it to a
typed tool.

---

## Text / FTS tools

### `code_search`
```
input:  query (FTS5), kind? (literal|identifier|comment|annotation_arg|config_value), limit=50, repo_commit_sha?
output: list of token hits with {file, line, col, kind, snippet, symbol_id?}
```
The string-blind-spot lane. Catches string DI, reflection, dynamic dispatch,
ORM strings, route paths — the AST/SCIP blind spots.

---

## LSP tools (live, dirty-buffer-aware)

These read the running language server, so they reflect unsaved edits.
Positions are 0-indexed.

### `lsp_hover`
```
input:  file, line, col
output: hover markdown (type, signature, docstring)
```

### `lsp_definition`
```
input:  file, line, col
output: definition locations
```

### `lsp_references`
```
input:  file, line, col, include_declaration=false
output: reference locations
```
Use when `graph_callers` might be stale (file edited after indexing).

### `lsp_diagnostics`
```
input:  file, wait_ms=3000
output: list of diagnostics with severity, message, range
```
Current type errors / lints. Poll after edits.

---

## Structural-analysis tools (`ctkr.*`)

These read derived Parquet/JSONL artifacts under `<data_dir>/ctkr/` (see
[`ctkr-artifacts.md`](ctkr-artifacts.md) and [`ctkr.md`](ctkr.md)). Set
`METACODING_CTKR_DATA_DIR` to the **data directory**, not its `ctkr/` child.
It is mandatory; there is no implicit corpus fallback.

The current [names and guarantees](structural-analysis-terminology.md) contract
separates implemented graph analytics from the optional
[category-theory research track](category-theory-research.md). Preferred tools
and compatibility aliases share inputs, outputs, and implementation:

| Preferred name | Legacy alias |
|---|---|
| `ctkr.similar_roles` | `ctkr.role_equivalent` |
| `ctkr.structural_alignment` | `ctkr.functor_between` |
| `ctkr.composition_patterns` | `ctkr.composition_rules` |

Existing artifact names, fields, and enum values are unchanged. Other tool names
remain unchanged. Call `describe_api` for the full live schemas; the summaries
below show their main arguments rather than every constraint/default.

### Health and result envelope

All these tools accept `acknowledge_unestablished_fitness?` (default false).
Their result is wrapped as:

```text
success: {ok: true, result: <payload below>, health, caveat?}
refusal: {ok: false, error: "INDEX_FITNESS_UNESTABLISHED", message, health}
```

A refusal has **no `result`**. Do not turn it into an empty finding. The tools
check graph health beside the artifacts and whether the artifact manifest
predates the latest graph fitness verdict. Missing or unestablished health and
missing/stale generation stamps cause refusal by default. A deliberate
acknowledgment permits a caveated read, not a claim that the data is now fit.
This timestamp check is not full per-run provenance. Missing artifact files can
still fail separately after the health gate permits a read.

### `ctkr.motif_search`
```text
input:  min_support?, edge_kinds?, repo_coverage_min?, label?, limit?
payload: MotifRow records, optionally joined with LLM labels
```
"What indexed shapes recur, and where?" A recurring motif is a candidate
pattern, not proof of a shared purpose.

### `ctkr.nearest_symbols`
```text
input:  symbol_id | qualified_name, k?, cross_repo_only?, embedding_kind?
payload: nearest symbols by embedding cosine distance
```
Uses learned structural embeddings, not raw profile counts. The current reader
uses the existing structural artifact; `embedding_kind` routing is not implemented.
Do not assume passing another kind selects a different embedding index.

### `ctkr.similar_roles` (alias: `ctkr.role_equivalent`)
```text
input:  symbol_id | qualified_name, k?, scope? (seed repo), cross_repo_only?
payload: candidate symbols with hom_profile_distance
```
Cosine KNN over structural profiles in `hom_profiles.parquet`. `scope`
disambiguates seed names; `cross_repo_only` excludes the seed's repo. Both the
artifact filename and output field keep their legacy names. The finite profile
summarizes typed-edge features; similarity is not a same-role predicate or
proof of categorical/behavioral equivalence. Even exact profile equality does
not establish an automorphism orbit. Inspect the source before using a match.

### `ctkr.structural_alignment` (alias: `ctkr.functor_between`)
```text
input:  repo_a, repo_b, direction? (a_to_b|b_to_a|both),
        min_coverage?, min_fidelity?, min_pair_fidelity?, min_margin?, limit?,
        members_a?, members_b?, exclude_identity?
payload: {functor, reverse?, mapping, n_ambiguous, truncated, _note?}
```
Reads precomputed partial mappings. `functor` and related artifact/output fields
are compatibility identifiers. The summary includes coverage, edge fidelity,
assignment ambiguity, and an optional sampled two-path diagnostic. Mapping
rows include similarity, margin, ambiguity, and pair fidelity. Missing pair
support can be `null`; it is not evidence of perfect preservation.

Use assignment margins and `is_ambiguous`, not just aggregate fidelity, to judge
individual pairs. A high-scoring partial mapping is not a guaranteed maximal
map, categorical equivalence, behavioral equivalence, or a safe port. Even
fidelity 1.0 describes observed edge preservation under the scoring rules.

### `ctkr.subsystems`
```text
input:  repo?, resolution?, min_persistence?, boundary_sample?
payload: {subsystems, config, _note?}
```
Returns a consensus graph partition and boundary-confidence metadata. Review
low-confidence members and those placed by directory locality rather than
structural signal. Stability across settings is not proof of a correct boundary.

### `ctkr.interface_of`
```text
input:  subsystem, repo?, direction? (provides|consumes),
        boundary_shapes_only?, limit?
payload: observed boundary edges, exports, dependencies, data shapes,
         alphabet_coverage, truncation and notes
```
Returns indexed interface evidence, not a complete behavioral contract.
`alphabet_coverage` helps distinguish thin evidence from extractor limitations.

### `ctkr.composition_patterns` (alias: `ctkr.composition_rules`)
```text
input:  subsystem?, repo?, view? (orbit|similarity),
        op_kind? (path|fan_in|non_operadic), min_support?, boundary_only?, limit?
payload: operations, violations, protocol_roles, counts, truncation and notes
```
Reads `operads.parquet`, produced by `ctkr composition-patterns` (legacy command
`ctkr operads`). The `orbit` view means **exact-profile classes**, not exact
automorphism orbits. `similarity` uses threshold-based role clusters.

Paths and fan-in are observed structural patterns, not verified operad laws or
runtime order. `violations`, `non_operadic`, `missing_composite`, and
`back_call_cycle` are retained diagnostic identifiers. Missing paths can result
from thresholds or lost instance detail; a cycle does not violate a generic
category/operad axiom. Boundary flags and `protocol_roles` do not certify a
runtime protocol.

### `ctkr.subsystem_card`
```text
input:  subsystem, repo?, sections?
payload: {card, _note?}
```
Reads the offline spec deck (`ctkr extract-spec`). Section identifiers include
`intent`, `roles`, `composition_rules`, `interface`, `data_shapes`, `topology`,
`exemplar_slices`, `nl_only_symbols`, and `dissonance`; `composition_rules` stays
as a compatibility field. Inspect provenance and source exemplars. Generated
intent and labels are interpretations, not facts guaranteed by the graph.

### `ctkr.pattern_search`
```text
input:  label?, source_kind?, min_confidence?, instances_in_repo?, limit?
payload: PatternRow records with attached evidence
```
Reads LLM-labeled findings. `source_kind='role-cluster'` selects role labels;
`source_kind='motif'` selects motif labels. Confidence is label metadata, not a
calibrated probability of semantic correctness.

### `ctkr.shape_distance`
```text
input:  repo_a (+ repo_b for a pair | + k_nearest for nearest repos)
payload: H₁ persistence-diagram distance(s) between repos
```
Reads `wasserstein_h1.parquet`. In pair mode, `distance: null` means the pair is
absent. A diagram distance depends on the graph construction and filtration;
it does not measure behavioral equivalence.

### `ctkr.centrality_query`
```text
input:  metric (pagerank|betweenness|eigenvector), repo?, kind?, top_k?
payload: per-symbol centrality scores joined with spectral cluster assignments
```
The `kind` argument is accepted but not applied in the current reader; inspect
returned notes. Centrality ranks graph position, not semantic importance.

### Use in a task

Start with graph/search evidence, then add the smallest structural query that
could improve a decision. Inspect its exemplars and near-misses, make the change,
run project checks, re-index, and verify. Compare outcomes and effort with the
same-data, same-budget graph/search baseline over repeated tasks. An attractive
cluster or high mapping score alone does not establish product value.

---

## `describe_api`
```
input:  {}
output: { name, version, tools[], schema: { edge_kinds, token_kinds } }
```
Self-describe. Agents (and harnesses) should call this first to discover the
live surface and exact input schemas.

---

## Tools we deliberately do NOT expose

- `vector_search` (raw) — exposed instead as the purpose-built
  `ctkr.nearest_symbols` / `ctkr.similar_roles`. No generic kNN endpoint.
- `extract_with_llm` — out of scope at query time. The graph is deterministic;
  LLM labeling happens offline in the L3 build (`ctkr label-roles`,
  `ctkr label-motifs`) and is read back via `ctkr.pattern_search`.
- Generic `db_query` — let the agent compose typed tools instead of writing
  SQL/Cypher; `graph_cypher` is the one reluctant escape hatch.
- Anything write-side — read-only by design. Refactoring tools, if ever added,
  go through the LSP's `workspace/applyEdit`, not raw graph mutations.

## Not yet implemented (vision)

Named in earlier drafts and still wanted, but not currently registered —
compose the shipped tools for now:

- `graph_callees`, `graph_path` — walk-out and pathfinding (compose
  `graph_neighbors`).
- `code_search_regex` — ripgrep-backed regex over the indexed file set.
- `graph_taint` — Joern `reachableByFlows` source→sink (slow, out-of-band).

## Design notes

- **Keep the surface small.** The temptation is 20 tools; the agent reliably
  uses 5. Ship the small set, watch which the agent reaches for, promote common
  `graph_cypher` patterns to typed tools.
- **Return symbol IDs, not full content.** Let the agent fetch source via
  `Read`. Tool outputs should fit comfortably in context.
- **Compose, don't bloat.** "Controllers that call services that touch the
  orders table" is the agent composing `graph_callers` + `code_search` +
  `graph_neighbors`, not a single bespoke tool.
- **Predictable shapes.** Every result that references a symbol returns the same
  `{id, qualified_name, file, line, kind}` envelope.
- **Co-locate descriptions with registration.** A new tool's `describe_api`
  entry lives next to its `registerTool` call (core tools in `tools.ts`, CTKR
  tools in `ctkr-tools.ts`), and `describe-api.test.ts` enforces parity.
