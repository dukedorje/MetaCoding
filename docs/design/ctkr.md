# Structural analysis (legacy namespace: `ctkr`)

Structural analysis adds offline graph analytics to MetaCoding's code graph.
It helps an agent find candidate roles, subsystem boundaries, recurring paths,
and cross-repo correspondences, then inspect the source evidence. It does not
prove that two programs have the same meaning or behavior.

The `ctkr` package, MCP namespace, artifact filenames, and schema identifiers
remain compatible. CTKR's category-theory origins remain a research direction,
not a guarantee attached to current results.

## Delivery order

1. **Graph core.** Index a real project, find relevant symbols and dependencies,
   make a change, run its checks, re-index, and inspect the result. Make this
   full cycle reliable in routine use before expanding the analysis stack.
2. **Task-backed structural analysis.** Add the smallest analysis that helps an
   observed task: similar-role retrieval, a subsystem boundary, or an approximate
   structural alignment. Return source locations, coverage, and uncertainty.
3. **Experimental category theory.** Explore stronger constructions only after
   repeated full-cycle use shows where simpler graph methods fall short. Compare
   each experiment with the graph-only and existing structural-analysis baselines.

This order is a product priority, not a claim that no advanced code exists.
Several offline analyses and research prototypes are already implemented.

## Available building blocks

| Component | Current use | Important limit |
|---|---|---|
| Typed graph + FTS | Find symbols, callers, implementers, and text evidence | Resolution and edge coverage depend on extractor, language, and index health |
| Structural profiles | Count typed incoming/outgoing edges; optional deeper neighborhood summary | A finite feature vector, not a full hom-functor |
| Similar roles | Cosine nearest neighbors over profiles | Similarity proposes candidates, not interchangeable implementations |
| Subsystem partition and interfaces | Group symbols and inspect observed boundary edges and data shapes | Partition confidence and extraction gaps matter; not a complete behavioral contract |
| Approximate structural alignment | Partial symbol mappings with coverage, edge fidelity, and ambiguity metadata | Heuristic search, not a guaranteed maximal map or semantic equivalence |
| Composition patterns | Recurring role paths and fan-in summaries | Static observations, not verified operad laws or runtime protocols |
| Motifs, embeddings, centrality, shape signatures | Additional ways to rank and compare graph structure | Results depend on graph construction and analysis settings |
| LLM labels and cards | Attach tentative meaning and source evidence to findings | Labels need review; optional provider calls can send source context off machine |

Use [`mcp-surface.md`](mcp-surface.md) for the read-side tools and
[`../../ctkr/README.md`](../../ctkr/README.md) for the Python batch workflow.
Some artifacts need separate generation steps; registering a tool does not
mean its artifacts exist or are current.

## What the scores mean

A **structural profile** summarizes observed graph features. Default profiles
use typed-edge counts. Weighting and depth options change the representation.
Equality is equality of that representation only. The **exact-profile class**
view retains the legacy wire value `orbit`; it does not compute exact graph
automorphism orbits. Distinct neighborhoods can share a profile. Similarity
classes are a further approximation, sensitive to distance and thresholds.

An **approximate structural alignment** is a partial symbol mapping. Coverage
measures how much of the source is mapped; fidelity measures observed edge
preservation under the implementation's scoring rules. Inspect assignment
margins and ambiguous pairs, not just aggregate scores. A fidelity of 1.0 does
not establish categorical equivalence, behavioral equivalence, or a safe port.
A type-preserving graph map can induce a functor between explicitly constructed
free categories, but that formal model does not establish program semantics.

**Composition patterns** project observed paths onto role classes. Legacy
`non_operadic`, `missing_composite`, and `back_call_cycle` records are diagnostic
identifiers. Missing observed paths and cycles are not, on their own, violations
of categorical or operad axioms. Static call edges do not prove runtime order.

## Evidence and known limits

- Check index fitness before aggregating. Missing CALLS or REFERENCES edges
  can mean incomplete extraction, not an architecture with no dependencies.
- Structural MCP tools read derived artifacts. They refuse by default when
  graph fitness is unestablished or their generation stamp predates the graph's
  fitness verdict. Timestamp checks are not full per-run provenance.
- A batch artifact is not a live view of an edited worktree. Regenerate the
  relevant artifacts after changes and verify scope, manifest, and source SHA.
- Profiles can collapse unrelated symbols. Alignment can have many near-tied
  assignments. Review concrete exemplars and counterexamples in the source.
- Clustering is not a categorical colimit. A repeated motif is not automatically
  a design pattern. A human or LLM label is an interpretation, not ground truth.
- Optional dependency stacks and language coverage vary. Full incremental
  analysis, complete semantic coverage, and universal cross-language matching
  are not product guarantees.

## Empirical acceptance

For each candidate feature, keep a small reproducible task record:

1. Record the repository revision, language, index health, analysis settings,
   and artifact versions.
2. Run a real task (navigation, change-impact review, refactor, or port) with
   text/source tools, with the graph core, and with the added analysis.
3. Keep source-backed findings, false matches, missed dependencies, abstentions,
   and task outcomes. Record measured time/cost if available; do not infer wins
   from attractive clusters or fidelity scores alone.
4. Complete the change/test/re-index cycle and check whether the analysis helped
   a decision. Repeat across tasks before broadening the default surface.

No general performance improvement is claimed here. Experimental CT must earn
its place against these simpler baselines, not merely offer richer terminology.

## Compatibility vocabulary

The shared [names and guarantees](structural-analysis-terminology.md) document
is the canonical terminology and compatibility contract. This table summarizes
its entry points and the retained artifact identifiers.

| Preferred wording or entry point | Retained identifier or alias |
|---|---|
| Structural analysis | `ctkr` package / directory / MCP namespace |
| Structural profiles; `ctkr structural-profiles` | `ctkr hom-profiles`, `hom_profiles.parquet` |
| `ctkr.similar_roles` | `ctkr.role_equivalent`, `hom_profile_distance` |
| `ctkr.structural_alignment` | `ctkr.functor_between`, `functors.parquet`, `functor_edges.parquet` |
| Composition patterns; `ctkr composition-patterns` | `ctkr operads`, `operads.parquet` |
| `ctkr.composition_patterns` | `ctkr.composition_rules` |
| Exact-profile class | `orbit` wire enum |

Existing commands, tool aliases, artifact names, schema fields, and enum values
remain valid. This vocabulary change does not change graph algorithms or require
a data migration.

## Research preserved

See [category theory: inspiration and experimental track](category-theory-research.md)
for the current research boundaries and promotion requirements.

The long-term question remains useful: can relational structure reveal roles
and patterns that names hide? Category theory is one source of models for that
question. A typed graph can generate a free category with paths as morphisms
and empty paths as identities; the stored graph alone is not a proof that these
paths model execution or meaning.

The following documents preserve the theory, design history, and experiments.
Read their categorical terms as research proposals unless a specific
construction and validation are stated:

- [`ct-pipeline.md`](ct-pipeline.md) — historical four-phase research ladder,
  with status and corrected claim boundaries.
- [`ct-functor-discovery.md`](ct-functor-discovery.md) — alignment search design
  and free-category model; legacy "functor" terminology.
- [`ct-subsystem-extraction.md`](ct-subsystem-extraction.md) — subsystem and
  composition research.
- [`ctkr-information-domain.md`](ctkr-information-domain.md) — extending the
  ideas to typed information graphs.
- [`../notes/entropy-as-dial.md`](../notes/entropy-as-dial.md) — representation
  granularity and its trade-offs.
- [`ctkr-artifacts.md`](ctkr-artifacts.md) — retained artifact contracts.
- [`../VISION.md`](../VISION.md) — current priorities.
