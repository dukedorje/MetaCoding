# MetaCoding — design and use

MetaCoding is a local-first code graph for AI coding agents: resolved symbols,
typed relationships, source locations and text search, exposed through MCP.
Its starting point is a useful full cycle: inspect a real dependency, make a
change, check the result, and refresh the index. Establish repeated use before
adding more analytical machinery.

## Foundation

SCIP supplies resolved symbol relationships, LSP supports live language-server
queries, Tree-sitter extracts syntax structure, and SQLite FTS5 covers identifiers,
strings and comments. The embedded ladybugdb graph stores typed relationships.
Optional analysis lanes have their own prerequisites; extraction coverage varies
by language and index health.

The core MCP surface includes `graph_neighbors`, `graph_implementers`,
`graph_callers`, `graph_diff`, `code_search` and `graph_cypher`, plus live LSP
tools. Compose traversals with `graph_neighbors`; `graph_path` is not a shipped
tool. See [the actual tool surface](design/mcp-surface.md).

Structural analysis (legacy package/namespace `ctkr`) adds profile similarity,
boundaries, motifs, embeddings and approximate mappings where they help a task.
Category theory remains an optional research track, not an implied guarantee
of those algorithms. Offline LLM labeling can use a remote provider; the local
index/query core does not require sending source code to one.

## Start here

- [VISION.md](VISION.md) — graph-first priorities, routine full-cycle use, and the
  criteria for adding structural analysis or experimental theory.
- [design/ctkr.md](design/ctkr.md) — current structural-analysis capabilities,
  limitations and empirical acceptance; `ctkr` is the compatibility namespace.
- [design/structural-analysis-terminology.md](design/structural-analysis-terminology.md)
  — descriptive names, old aliases, unchanged wire identifiers and guarantees.
- [design/category-theory-research.md](design/category-theory-research.md)
  — theoretical inspiration and the obligations stronger mechanisms would need.
- [design/mcp-surface.md](design/mcp-surface.md) — concrete tools and response contracts.
- [../ctkr/README.md](../ctkr/README.md) — structural-analysis batch commands.

## Reference and research

- [design/architecture.md](design/architecture.md) — extraction/query architecture.
- [design/schema.md](design/schema.md) — graph/FTS schema design; consult current
  types and tool discovery when historical sketches differ from implementation.
- [design/storage-integration.md](design/storage-integration.md) — embedded graph
  and FTS storage, lifecycle and compatibility.
- [design/ctkr-artifacts.md](design/ctkr-artifacts.md) and
  [design/ctkr-l3-artifacts.md](design/ctkr-l3-artifacts.md) — retained artifact
  contracts; legacy categorical identifiers do not confer categorical guarantees.
- [design/ct-pipeline.md](design/ct-pipeline.md) — historical research ladder,
  not today's delivery order or a claim that every construction is implemented.
- [design/build-plan.md](design/build-plan.md) — original MVP build plan.
- [notes/](notes/) — working notes and historical experiments.
- [research/paper-2601.08773v1.md](research/paper-2601.08773v1.md) and
  [research/prior-art.md](research/prior-art.md) — motivation and comparisons.

## Operating principles

- Prefer deterministic extraction and explicit evidence over inferred relations.
- Distinguish missing index coverage from an absence of dependencies.
- Return source locations, mapping ambiguity and measured coverage.
- Use graph algorithms for the questions they answer; verify behavior separately.
- Keep theory experiments optional. Promote them only with task evidence against
  simpler methods using comparable data and budget.
