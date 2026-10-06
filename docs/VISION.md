# MetaCoding — Vision

MetaCoding helps coding agents use a codebase's structure while doing real work.
The immediate goal is a reliable local graph: find a symbol, trace a dependency,
change the code, test it, and check the updated graph. Structural analysis earns
its place when it makes that cycle more useful.

## The thesis

Names and text are useful, but they do not capture every relationship. Typed
calls, references, implementations, and containment can help an agent find what
it would otherwise miss. The graph complements source reading and text search;
it does not replace them or fully describe a program's behavior.

Across projects, similar wiring may reveal similar roles under different names.
That is a testable hypothesis, not a promise that matching graphs imply matching
meaning. We want findings an agent can inspect, challenge, and use in a task.

## The delivery ladder

### 1. A useful graph core

Make indexing, health reporting, typed MCP queries, and source evidence work
reliably on a real project. Prioritize the full loop:

> index → inspect → change → test → re-index → verify

Repeat it during routine development. Incomplete extraction must be visible;
missing graph evidence must not silently become a negative answer. Improve the
core where those cycles fail before expanding the feature surface.

### 2. Structural analysis with task evidence

Build a thin layer on the graph, using the existing `ctkr` implementation:

- **Structural profiles and similar roles:** candidate symbols worth reading.
- **Subsystems and interfaces:** candidate boundaries and observed dependencies.
- **Approximate structural alignment:** partial cross-repo mappings with edge
  fidelity, coverage, and assignment ambiguity.
- **Composition patterns:** recurring role paths and fan-in, with exemplars.

Motifs, embeddings, centrality, topological signatures, and LLM labeling already
provide additional experimental building blocks. Availability is not evidence
of usefulness. Keep only the detail that helps an observed task, and show the
source evidence and limits with each result.

Profiles are finite feature summaries, not full hom-functors. Equal profiles
form exact-profile classes, not proven automorphism orbits. Approximate mappings
do not establish categorical or behavioral equivalence. Static composition
patterns do not establish runtime protocols or operad laws.

### 3. Experimental category theory, after routine full-cycle use

Category theory remains an inspiration and research track. It offers ways to
state questions about composition, correspondences, and shared structure. A
graph can generate a free category; using that model does not itself add
semantic evidence to the graph.

Research on functors, colimits, operads, and cross-language structure remains
valuable. Before promoting a construction, define its mathematical objects and
laws, distinguish the exact construction from its heuristic approximation, and
test whether it helps tasks more than simpler methods. Formal properties within
a model and empirical usefulness in code are separate obligations.

## What counts as progress

Compare the same task under three conditions: source/text tools, the graph core,
and the graph plus a candidate analysis. Keep the repository revision, extraction
coverage, settings, evidence, false matches, missed findings, and verified task
outcome. Record measured effort or cost when available. Repeat through the full
change/test/re-index cycle, rather than judging a single attractive visualization.

The question is concrete: did the added analysis help locate a dependency,
choose a boundary, make a correct change, or reject a bad correspondence? No
speed, accuracy, or cost improvement is assumed without that comparison.

## Current state and limits

The code graph, FTS, typed MCP surface, and offline structural-analysis tooling
exist. Coverage differs by extractor and language. Offline artifacts can be
missing or stale. Health gating reduces silent failures, but artifact timestamps
are not complete run-level provenance. Partial alignments can contain ambiguous
symbol assignments even when their aggregate scores look strong.

The priority is routine, evidence-backed use of the existing pieces, not a new
categorical layer as a prerequisite for shipping value. The `ctkr` namespace,
legacy commands/tools, artifact names, and schema identifiers stay compatible.
See [names and guarantees](design/structural-analysis-terminology.md) for the
canonical compatibility contract, [`design/ctkr.md`](design/ctkr.md) for current
capabilities, and [`design/mcp-surface.md`](design/mcp-surface.md) for the tool guide.
The [research track](design/category-theory-research.md) states the obligations
for stronger categorical claims.

## Research horizons

- **Cross-language roles:** which structural signals survive a language change,
  and where do extractor differences dominate?
- **Change over time:** can graph histories help distinguish architectural drift
  from local refactoring?
- **Patterns without names:** can exemplars and contrast pairs make a recurring
  structure useful before a label is agreed?
- **Compositional models:** when do explicit categorical constructions improve
  reasoning beyond profile similarity, clustering, and graph alignment?

The historical [`design/ct-pipeline.md`](design/ct-pipeline.md) preserves the
original four-phase research plan and references. It is not the current delivery
order or a list of mathematical guarantees shipped by the product.

## Project boundaries

MetaCoding owns code indexing and understanding. Orchestrators owns evolution-loop
state. Dreamball owns its container protocol. They can exchange evidence and
artifacts without merging their responsibilities.
