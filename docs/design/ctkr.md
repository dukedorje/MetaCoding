# CTKR — Category-Theoretic Knowledge Representation

> **Companion docs.** This is the theoretics. For the strategic framing
> see [`../VISION.md`](../VISION.md); for the phased build plan with
> tool surface, CT references, and worked examples see
> [`ct-pipeline.md`](./ct-pipeline.md). The same ladder over a personal
> / organizational archive (pages, entities, typed links) is
> [`ctkr-information-domain.md`](./ctkr-information-domain.md).

A research/design track layered on top of the MetaCoding graph. The core
MetaCoding lanes give us a clean, queryable, cross-repo code-graph. CTKR
asks the next question:

> Given a corpus of N codebases as one graph, can we **discover** the
> objects, roles, design patterns, and ontology that connect them — without
> imposing any of those concepts up front — by treating the corpus as a
> categorical structure and reading its topology?

This document captures the vision, the layered plan, and the honest
tooling/research split so future work has a reference point.

## Why this exists

The MCP surface (`graph_neighbors`, `graph_callers`, `code_search`,
`graph_cypher`, …) answers *targeted* questions: "who calls X", "what
implements Y". That's enough when you already know what to ask.

It is *not* enough for the cold-corpus problem: 60 agent-orchestrator
repos, no prior knowledge, the goal is *understanding* — what objects
recur, what roles they play, what patterns they instantiate, how the
repos differ in approach. Grep doesn't scale. Reading 60 READMEs gives
you marketing copy, not architecture.

The hypothesis: **the structure already encodes the answers**. A
codebase isn't *like* a category — it *is* one. Symbols are objects,
typed edges (CALLS / IMPLEMENTS / IMPORTS / REFERENCES) are morphisms,
composition is path concatenation. Recurring patterns are recurring
small categories. Cross-repo "the same role under different names" is
the existence of a structural functor between two subcategories. The
ontology shared by 60 frameworks is the colimit of their schemas.

CTKR is the plan to read that structure out, with a pragmatic ladder
from cheap mechanical tooling to honest categorical machinery.

## The corpus as a category

For a single indexed repo:

- Objects: every Symbol node (function, class, module, file, …).
- Morphisms: typed edges from the schema (CALLS, REFERENCES,
  IMPLEMENTS, IMPORTS, plus future kinds).
- Composition: edge-path concatenation, restricted by type-compat
  rules (e.g. CALLS ∘ CALLS → CALLS-path; IMPLEMENTS ∘ CALLS is
  meaningful, but CALLS ∘ IMPLEMENTS may not be).

For the corpus:

- Disjoint union of per-repo categories, plus inter-repo edges where
  one repo imports another (rare across these 60 but not zero).
- Useful structural questions:
  - **Functors** between subcategories of repo A and repo B that
    preserve edge type → cross-repo role analogy.
  - **Limits** (pullbacks): shared interfaces under different names.
  - **Colimits** (pushouts): minimal shared ontology that
    accommodates all variants.
  - **Ends / coends**: invariants that hold uniformly across all repos.

This framing isn't decoration. It tells us *what to compute* — the
universal constructions are the answers we're after.

## Layered plan

```
                ┌───────────────────────────────────────────────┐
   Layer 3 →    │  LLM-bridged semantic enrichment              │
                │  motif → role label → narrative pattern doc   │
                └───────────────────▲───────────────────────────┘
                                    │ feeds, never imposes
                ┌───────────────────┴───────────────────────────┐
   Layer 2 →    │  Categorical machinery (research)             │
                │  functor discovery / pullbacks / colimits     │
                │  Yoneda-style role identification             │
                │  Spivak-style schema integration / operads    │
                └───────────────────▲───────────────────────────┘
                                    │ extends
                ┌───────────────────┴───────────────────────────┐
   Layer 1 →    │  Mechanical structure-mining (buildable now)  │
                │  motif mining · embeddings · persistent       │
                │  homology · spectral / centrality             │
                └───────────────────▲───────────────────────────┘
                                    │ reads
                ┌───────────────────┴───────────────────────────┐
   Layer 0 →    │  MetaCoding code-graph (already exists)       │
                │  graph.lbug + tokens.fts.sqlite               │
                └───────────────────────────────────────────────┘
```

### Layer 0 — what we have

The shipped MetaCoding store: typed graph in ladybugdb (Kùzu fork),
token FTS in SQLite. Indexed across 59 repos as of the first build
(corpus size: ~25k files, ~300k symbols on first pass).

CTKR builds on this. Nothing in CTKR replaces the existing query
surface; it adds new analyses *on top* of the same graph.

### Layer 1 — mechanical structure-mining

Buildable in days, no new theory required. Each technique below maps
to a concrete categorical idea but doesn't require categorical tooling
to compute.

1. **Frequent typed-subgraph mining** (gSpan / VF3 over the typed
   multigraph). Recurring motifs are emergent design patterns. A
   "1 abstract + N concretes + dispatch" motif clusters across repos
   without anyone writing down "Strategy/Template". Output: a motif
   library, ranked by support and cross-repo coverage.

2. **Graph embeddings** (node2vec / GraphSAGE / a small GAT) over the
   global cross-repo graph. Each symbol gets a vector summarizing
   local topology + edge-type mix. Then:
   - Cross-repo nearest neighbors of a symbol → emergent role
     analogies. `crewAI.Agent` neighbors should include
     `autogen.ConversableAgent`, `mastra.Agent`, etc., *because of
     where they sit*, not because their names rhyme.
   - Clusters in embedding space → emergent role taxonomy.

3. **Persistent homology** of the call graph under filtrations
   (call-fan-in, edge weight, file distance). H₀ → subsystems, H₁ →
   feedback loops & dispatch tables, H₂ → architectural cavities.
   The persistence diagram is a **shape signature** per repo.
   Cluster repos by PD distance → topology-driven taxonomy that
   ignores domain vocabulary entirely.

4. **Spectral & centrality decomposition.** Eigenvector centrality
   surfaces architectural skeleton; spectral clustering finds
   modules-as-emergent (vs. modules-as-declared); cut vertices
   reveal real seams vs. nominal ones.

All four can be implemented as scripts that read the ladybugdb graph,
write derived artifacts to a sibling table or to `.metacoding/ctkr/`,
and (eventually) get exposed as MCP tools.

### Layer 2 — categorical machinery

These are research-grade. The math is clear; tooling is sparse.

5. **Structural analogy as functor discovery.** Treat each repo's
   graph as a small category Cᵢ. Discover partial functors Cᵢ → Cⱼ
   that preserve edge type, scored by coverage and faithfulness.
   The set of high-coverage functors across the corpus is the
   emergent ontology — *concepts that appear under multiple skins*.

6. **Yoneda-style role identification.** An object is determined by
   its hom-functor — every symbol is fully characterized by *how
   everything else relates to it*. Two symbols across repos with
   identical hom-profiles (up to relabeling) play the categorically
   identical role. This gives a principled "same-role" predicate
   that doesn't depend on names, types, or comments.

7. **Spivak-style categorical data integration.** Each repo's graph
   schema is a small category. The colimit (pushout) over the family
   of repo schemas is *the minimal shared ontology that
   accommodates all of them* — exactly the no-top-down-ontology
   objective. Closest existing tooling: catlab.jl / CTGS work in
   Julia.

8. **Operadic view of composition.** Each codebase has implicit
   composition rules (how agents/tools/plans combine). The realized
   n-ary compositions across actual call paths constitute an
   empirical operad. The discovered operad tells you the algebra of
   the framework, recovered from behavior rather than from prose.

Layer 2 lifts Layer 1's heuristics to first-class structure: motif
mining ≈ approximate functor discovery; embedding nearest-neighbors ≈
approximate Yoneda; persistent homology ≈ shape signature of an
underlying simplicial set. The cheap and the principled point at the
same things; the categorical version is just exact and composable.

### Layer 3 — LLM-bridged semantic enrichment

Pure structure tells us *roles* and *shapes*. *Purpose* lives in
prose, comments, naming, README. The pragmatic move:

> Use the categorical structure to **select what to read**; use an LLM
> to **assign meaning** to what was discovered.

Inversion of the usual flow: structure first, label second.

A working pipeline:

1. Layer 1/2 surfaces a recurring 4-node motif across 12 repos.
2. Pipeline gathers the 12 instantiations (file paths, code slices,
   surrounding context) and feeds them to Claude.
3. Claude proposes a label, a short description, and the textual
   evidence supporting it.
4. The motif now has a *learned* name, defined by (a) its categorical
   shape, (b) its instantiations, (c) the assigned label, (d) the
   evidence. Stored as a new artifact alongside the graph.

Iterating across all discovered motifs and functors yields an
**emergent pattern library** specific to this corpus. The library is
auditable — every label is traceable to the structural fact and the
text that supports it.

## Architecture: how CTKR plugs in

CTKR is purely additive. No changes required to the existing five
lanes (SCIP / LSP / Tree-sitter / FTS / Joern). It reads the same
graph and writes derived artifacts.

```
                                ┌──────────────────────────────┐
                                │  CTKR MCP surface (future)   │
                                │  ctkr_motifs / ctkr_analogy  │
                                │  ctkr_pattern / ctkr_shape   │
                                └─────────────▲────────────────┘
                                              │
   ┌──────────────────┐    reads     ┌────────┴────────────────┐
   │  MetaCoding graph│ ───────────▶ │  CTKR pipeline           │
   │  graph.lbug      │              │  ─────────────────────── │
   │  tokens.fts      │              │  Layer 1: motif/embed/PH │
   └──────────────────┘              │  Layer 2: functor/Yoneda │
                                     │  Layer 3: LLM enrichment │
                                     └────────┬─────────────────┘
                                              │ writes
                                     ┌────────▼─────────────────┐
                                     │  .metacoding/ctkr/       │
                                     │  motifs.parquet          │
                                     │  embeddings.parquet      │
                                     │  shape-pds.parquet       │
                                     │  patterns.jsonl          │
                                     └──────────────────────────┘
```

New MCP tools (proposed, not yet built):

- `ctkr_motifs(min_support, edge_kinds)` — list discovered motifs
  ranked by support; each entry has its categorical signature, repo
  coverage, exemplar instantiations, and (if Layer 3 has run) a
  learned label.
- `ctkr_analogy(symbol)` — given a symbol, return cross-repo
  role-equivalent symbols by hom-profile / embedding distance.
- `ctkr_pattern(name)` — fetch a discovered pattern: definition,
  evidence, instantiations.
- `ctkr_shape(repo)` — return the persistence-diagram-based shape
  signature of a repo and its nearest neighbors in the corpus.

## Buildable now vs research

| Component                         | Status            | Effort           |
| --------------------------------- | ----------------- | ---------------- |
| Motif mining (Layer 1)            | Built             | shipped          |
| Graph embeddings (Layer 1)        | Built             | shipped          |
| Persistent homology (Layer 1)     | Built             | shipped          |
| Spectral / centrality (Layer 1)   | Built             | shipped          |
| LLM enrichment loop (Layer 3)     | Built (motifs)    | shipped          |
| MCP surface over L1 artifacts     | Phase 1           | days             |
| Hom-profile / Yoneda role         | Phase 2a          | weeks            |
| Functor discovery (Layer 2)       | Phase 2b          | weeks–months     |
| Schema-colimit / Spivak-style     | Phase 2c          | months           |
| Operadic composition mining       | Phase 2d          | months           |
| Essence extraction (L2 ⊗ L3)      | Phase 3           | weeks            |
| Multi-tier embeddings / incr.     | Phase 4           | weeks            |

L1 + L3-for-motifs is shipped. The phased plan in
[`ct-pipeline.md`](./ct-pipeline.md) carries it forward: Phase 1 makes
the existing artifacts queryable, Phase 2 adds the categorical
machinery proper, Phase 3 names what Phase 2 finds, Phase 4 makes the
whole thing run continuously.

## Open questions

- **Edge-type taxonomy.** The current schema has CALLS / REFERENCES /
  IMPLEMENTS / IMPORTS. Is this enough to surface design patterns, or
  do we need `RETURNS_TYPE`, `RAISES`, `READS_FIELD`, `WRITES_FIELD`,
  `CONSTRUCTS`, `DECORATES`? Richer edges → richer functor discovery,
  but indexing cost grows.

- **Cross-language unification.** TS and Python emit symbols with
  different shapes (Python's duck-typing vs TS's structural typing).
  Are categorical analogies stable across the language boundary, or
  do we need a normalization layer?

- **Granularity.** Symbol-level is the obvious unit, but module-level
  and file-level categories may be the right scale for some
  patterns. Multi-resolution Layer 1 outputs.

- **Time as a dimension.** With git history, every edge has a
  birth/death time. Persistent homology over the temporal filtration
  detects architectural drift, refactoring waves, deprecation
  patterns. Out of scope for v1, but the schema can accommodate it.

- **Validation.** How do we know a discovered "pattern" is real and
  not noise? Bootstrapping against known patterns (Strategy,
  Observer, Visitor) in synthetic corpora; cross-repo support
  thresholds; LLM agreement across instantiations.

- **The labeling-loop self-consistency.** Once Layer 3 has assigned
  labels to motifs, can those labels feed back as priors for Layer 2
  functor discovery? At some point this becomes a closed
  refinement loop — interesting to characterize the fixed point.

## Status

This document is the **vision and theoretics** for CTKR — no code
written yet. The MetaCoding graph it depends on is built and indexed
(the 59-repo orchestrator corpus at `$ORCHESTRATORS_ROOT/.metacoding`,
default `~/projects/Orchestrators/.metacoding`, provides a real first
testbed).

Next concrete step (when picked up): a small Python pipeline that
reads the ladybugdb graph, computes node2vec embeddings + a frequent
subgraph mining pass, and exposes nearest-neighbor / motif lookups —
the smallest viable Layer 1 to confirm signal exists.
