# CT Pipeline — historical categorical research plan

> **Status: historical research/design plan, superseded as a delivery roadmap.**
> The current order is graph core → task-backed structural analysis → optional
> CT experiments after routine full-cycle use. See [current design](ctkr.md),
> [names and guarantees](structural-analysis-terminology.md), and
> [the research track](category-theory-research.md). The phase labels, tool names,
> and artifact sketches below preserve the original proposal; they are not a
> shipped-feature checklist. Some components now exist, but their implemented
> heuristics do not establish the mathematical guarantees originally envisioned.
>
> Current terms: structural profiles, similar roles, approximate structural
> alignment, and composition patterns. Legacy names remain compatibility
> identifiers. `orbit` denotes exact-profile classes, not exact automorphism
> orbits. Equal profiles and high edge fidelity do not imply categorical or
> behavioral equivalence. Compare each experiment against the same-data,
> same-budget graph/search baseline on verified tasks before promotion.

How MetaCoding goes from "indexed code-graph" to "extracted essence." Each phase is independently shippable. Each upgrades what came before. Read this alongside the vision doc ([`../VISION.md`](../VISION.md)) and the CTKR theoretics doc ([`ctkr.md`](./ctkr.md)).

## Conventions

- **Identity hashes**: blake3 throughout (provenance fields, motif signatures, pattern_ids, ethos/iteration hashes). Existing blake2b sites will migrate.
- **Artifact root**: `.metacoding/ctkr/` (Parquet + JSONL). See [`ctkr-artifacts.md`](./ctkr-artifacts.md).
- **Provenance fields**: every artifact row carries `{sha, generated_at, source_uri, schema_version}` from Phase 4 onward.
- **Language seam.** TS owns the MCP surface (Phase 1) and the Layer 2 categorical machinery (Phase 2). Python (`ctkr/`) keeps Layer 1 mining (`embed`, `mine-motifs`, `shape`, `centrality`) and Layer 3 LLM labeling — gudhi and gensim are the load-bearing reason to stay. Phase 4 multi-tier embeddings split similarly: structural stays Python (gensim), semantic + diff can live wherever (likely TS). New TS modules: `src/ctkr/` (algorithms) and `src/mcp/ctkr-tools.ts` (tool definitions). The MCP server stays a single process — CTKR tools are registered alongside the existing graph tools.
- **Artifact shapes held lightly.** Row schemas below are sketches. Final shapes emerge from algorithmic contact — pin them only when the implementation forces a choice.

## The four phases at a glance

```
Phase 1: Expose       Phase 2: Construct       Phase 3: Name           Phase 4: Sustain
 ────────────         ──────────────────       ────────────            ─────────────────
 MCP tools over       Layer 2 categorical      L2 shapes ⊗ L3         Multi-tier embeddings
 L1 artifacts          machinery — the         labels → emergent      Incremental indexing
 (motifs, embeds,      heart of CTKR           pattern library         Provenance / audit
  centrality, shape)                                                    Worktree-aware
```

Each phase corresponds to a sub-pipeline:

```
                              ┌──────────────────────────────────┐
                              │ Phase 3 — Essence Extraction     │
                              │ Pattern library (named + unnamed)│
                              └──────────────▲───────────────────┘
                                             │
       ┌──────────────────┐     ┌────────────┴───────────────────┐
       │ Phase 1 — MCP    │     │ Phase 2 — Layer 2 Machinery    │
       │ surface for L1   ├────▶│ hom-profiles · functors ·      │
       │ artifacts        │     │ colimits · operads             │
       └──────────────────┘     └────────────▲───────────────────┘
                │                            │
       ┌────────▼────────────────────────────┴───────────────────┐
       │ Layer 1 (existing) — embeddings · motifs · PH · cent.   │
       └────────▲───────────────────────────────────────────────┘
                │
                │  Phase 4 — Infrastructure (cross-cutting)
                │  multi-tier embeddings · incremental updates ·
                │  provenance · worktree-aware reads
                ▼
       ┌────────────────────────────────────────────────────────┐
       │ Layer 0 — MetaCoding graph.lbug + tokens.fts.sqlite    │
       └────────────────────────────────────────────────────────┘
```

---

## Phase 1 — Expose: typed MCP surface over L1 artifacts

**What it is.** Five typed MCP tools that let agents query the L1 artifacts directly instead of going through ad-hoc Parquet reads or full-text search.

**What we get.** Immediate utility. Existing motifs, embeddings, patterns, shape signatures, and centrality scores become first-class data for any MCP-speaking agent (Claude Code, dreamseed, the proposer/judge loop). No new math required.

### Tools

| Tool | Input | Output | Reads |
|---|---|---|---|
| `ctkr.motif_search` | `{min_support?, edge_kinds?, repo_coverage_min?, label?, limit?}` | `[MotifRow]` with optional L3 label | `motifs.parquet`, `patterns.jsonl` |
| `ctkr.nearest_symbols` | `{symbol_id \| qualified_name, k?, cross_repo_only?, embedding_kind?}` | `[{symbol, distance, repo}]` | `nn_index/`, `embeddings.parquet` |
| `ctkr.pattern_search` | `{label?, source_kind?, min_confidence?, instances_in_repo?}` | `[PatternRow + EvidenceRow[]]` | `patterns.jsonl`, `evidence.jsonl` |
| `ctkr.shape_distance` | `{repo_a, repo_b?, k_nearest?}` | bottleneck distance matrix or top-k nearest repos | `wasserstein_h1.parquet`, `shape_pds.parquet` |
| `ctkr.centrality_query` | `{repo?, kind?, top_k?, metric: pagerank\|betweenness\|eigenvector}` | ranked `[{symbol, score, cluster_id?}]` | `centrality.parquet`, `spectral_clusters.parquet` |

### Why this comes first

It validates the artifact set under real query load before adding Layer 2 on top, and it gives downstream consumers (the LLM proposer in dreamseed, agent-driven code exploration sessions) a structured surface to call into. Phase 2 will add tools alongside these — same MCP server, same tool envelope.

---

## Phase 2 — Construct: Layer 2 categorical machinery

**What it is.** The core categorical constructions, in dependency order. Each one is a derived artifact written to `.metacoding/ctkr/` and exposed through a new MCP tool.

This was the proposed research expansion, not a prerequisite for useful graph tooling.

### 2a — Hom-profile computation (Yoneda)

**Research inspiration.** Yoneda characterizes objects through their representable hom-functors and natural transformations. A finite typed-edge count vector is not such a functor: it omits identities, path composition, and most relational detail. Similar profiles suggest candidate roles; they do not determine a symbol's role or prove isomorphism. The current public term is **structural profile**.

**Computation.** For each symbol `s`, compute:

```
hom_profile(s) = {
  (edge_kind, direction): [symbol_kind frequencies]
}
```

A `Controller` and a `Handler` from different frameworks should have similar hom-profiles: both have many `incoming:REFERENCES`, both have outgoing `CALLS` to `Service`-like kinds, both are `CONTAINED` in a routing-table-like parent.

**Artifact.** `hom_profiles.parquet` — one row per symbol with a compact profile vector + the raw counts.

**MCP tool.** `ctkr.role_equivalent(symbol, k?, scope?, granularity?, kinds_filter?)` — find symbols across the corpus with the most similar hom-profile to a given one. `granularity` and `kinds_filter` control the resolution at which profiles are compared — see [`../notes/entropy-as-dial.md`](../notes/entropy-as-dial.md) for why these should be tunable parameters rather than baked-in choices.

**CT references.**
- *Categories for the Working Mathematician*, Mac Lane — Chapter III.2 (the Yoneda lemma)
- nLab: [Yoneda lemma](https://ncatlab.org/nlab/show/Yoneda+lemma)
- Spivak, *Category Theory for the Sciences* — Section 3.3 on representable functors

**Why this was the entry point.** It is tractable on the existing graph and gives name-independent similarity candidates. Whether those candidates help a task must be tested; there is no exact "same-role" predicate here.

### 2b — Functor discovery (cross-repo structural maps)

**Concept.** A functor `F: C → D` maps objects and morphisms and preserves identities and composition. Whether this model usefully relates two codebases is a research question; solving similar problems does not guarantee such a correspondence or semantic equivalence.

In real codebases, extractor noise, refactoring drift, and idiomatic differences can produce edge-preservation failures. Fidelity records observed edge preservation; thresholds filter candidates, not mathematical or semantic guarantees. Even fidelity 1.0 is not categorical equivalence or behavioral equivalence. The current public term is **approximate structural alignment**.

**Computation.**

1. Seed candidate mappings: for each symbol `s ∈ C`, take its top-k hom-profile-nearest neighbors in `D` (from Phase 2a).
2. Build a bipartite graph of candidate mappings, weighted by hom-profile similarity.
3. Search for a high-scoring partial mapping `F: C₀ → D` using a fidelity score, defined in this proposal as (heuristic search does not guarantee a maximal or optimal mapping):

   ```
   fidelity(F) = preserved_edges / total_edges_in_C₀
   ```

   where an edge `s →ₖ t` in C₀ is *preserved* iff `F(s) →ₖ F(t)` exists in D. Search uses constraint propagation seeded from hom-profile-nearest candidate pairs.
4. Emit the mapping with two metrics: `coverage` (|C₀| / |C|, how much of the source got mapped) and `fidelity` (preserved / total, how strictly structure was preserved on the mapped subcategory).

**Artifact.** `functors.parquet` — one row per discovered functor with source/target repos, the mapping table, coverage, fidelity. *Plus* `functor_edges.parquet` — one row per individual symbol-pair mapping with its local fidelity score (so consumers can re-aggregate at different thresholds).

**MCP tool.** `ctkr.functor_between(repo_a, repo_b, min_coverage?, min_fidelity?)` — returns the discovered functor between the two repos. Filtering at `min_fidelity=1.0` selects rows scoring full observed edge preservation; it does not certify categorical or semantic equivalence. Lower values widen the result. The preferred tool name is now `ctkr.structural_alignment`; this name remains an alias.

**Terminology correction.** Use "approximate structural alignment" for the implemented partial graph mapping. "Faithful" and "lax" have specific CT meanings that a fidelity score does not establish. An explicitly witnessed graph map can extend to a functor between free path categories; other categorical models require their equations to be respected. None of this establishes program equivalence. `functor` remains a legacy artifact/tool identifier, not a score-derived theorem.

**CT references.**
- Mac Lane — Chapter I.3 (functors)
- Riehl, *Category Theory in Context* — Section 1.3
- Fong & Spivak, *Seven Sketches in Compositionality* — Chapter 3 (databases as categories, schema morphisms)

**Intended result.** Candidate cross-repo correspondences with typed-edge evidence and uncertainty. A claim that `crewAI.Crew` corresponds to `GroupChatManager` requires source and task validation; the mapping alone does not prove they are equivalents.

### 2c — Colimit construction (shared ontology extraction)

**Concept.** A colimit is defined by a universal property over a specified diagram and compatible cocones. Calling it a "minimal shared ontology" is an intuition, not a consequence for arbitrary code graphs. A categorical model and suitable mappings must first be supplied.

**Proposed heuristic: alignment-guided community detection.** This constructs a role-cluster summary, not a categorical colimit. A true colimit requires a specified diagram and the universal property; Louvain does not check it. The historical proposal was:

1. Take all pairwise functor mappings from Phase 2b. Each mapping `F_ij(s) = t` with fidelity `c` becomes a weighted edge `s — t` (weight = c) in a meta-graph G whose nodes are all symbols across all repos.
2. Run Louvain modularity on G. Communities become colimit object candidates (role classes). Weighted Louvain naturally weights high-fidelity functor evidence more heavily.
3. Lift edges: for each typed edge in any source repo, project to the corresponding edge between the role classes its endpoints landed in. Keep edges supported by ≥ k repos. Record support count as edge weight.
4. The result is a graph of candidate role classes and supported relationships. It is not, merely by clustering, a colimit or a shared semantic ontology.

**Threshold as a queryable parameter.** Because the meta-graph is weighted, we don't need to commit to a single threshold at build time. Stable communities across many thresholds are *persistent* (robust), narrowly-stable ones are *ephemeral* (noise or boundary cases). Persistence sweep is a follow-up tool; the v1 ships at a default modularity-stable threshold with metadata letting callers re-run at their own.

**Why not a categorical construction?** A pushout requires an explicit span of suitable morphisms. It is a different construction from community detection, not merely a more precise clustering algorithm. Explore it only when a defined task justifies the extra model; see [Open theoretic questions](#open-theoretic-questions).

**Artifact.** `colimit.parquet` (role classes with representative symbols + modularity / persistence metadata) + `colimit_morphisms.parquet` (edges between role classes with repo-support count and weight). Final shapes hold lightly until algorithmic contact pins them down.

**Proposed MCP tool (not a current registered tool).** `ctkr.essence(repo_scope, min_repo_support?, min_persistence?)` was intended to return a shared-role summary. Such a summary would not establish a categorical colimit.

**CT references.**
- Mac Lane — Chapter III.3 (limits and colimits)
- Spivak, *Functorial Data Migration* — colimits as schema integration
- nLab: [colimit](https://ncatlab.org/nlab/show/colimit), [pushout](https://ncatlab.org/nlab/show/pushout)
- [Catlab.jl](https://github.com/AlgebraicJulia/Catlab.jl) — practical colimit computation for finitely-presented categories

**Intended result.** A compact, inspectable summary of shared structural evidence. Clustering does not guarantee a minimum ontology, and information lost by grouping means an original framework cannot generally be recovered by choosing class representatives.

### 2d — Operad recovery (composition algebra)

**Research inspiration.** An operad describes multi-input operations with substitution, units, and laws. One could model selected code composition this way, but static call paths do not supply that algebra by themselves. The implementation mines **composition patterns**, not a verified operad.

**Computation.**

1. From call paths (length ≥ 2 in the colimit category), enumerate (role × role × role) composition triples that occur with high frequency.
2. Collect recurring composition patterns with observed arity. This is a pattern library, not by itself an operad.
3. Record pattern diagnostics. This does not verify associativity or unit laws: missing mined composites may reflect thresholds or lost instance information, and cycles do not violate generic category/operad axioms. `non_operadic` remains a legacy diagnostic identifier.

**Artifact.** `operads.parquet` — operations with arity, role signatures, support, exemplar call paths.

**Historical MCP sketch.** `ctkr.composition_rules(scope?, min_support?)`. The preferred name is now `ctkr.composition_patterns` (legacy alias retained); see the live MCP schema for subsystem/repo scope. Results are observed patterns, not verified operadic rules.

**CT references.**
- Leinster, *Higher Operads, Higher Categories* — Chapter 2
- Yau, *Colored Operads* — for typed (multi-sorted) operads, which matches our typed-edge setting
- nLab: [operad](https://ncatlab.org/nlab/show/operad)
- Fong & Spivak — Chapter 6 (operads of wiring diagrams), the most accessible entry point

**Intended result.** Recurring static composition patterns to compare with documentation and source. Observed call/reference paths are not necessarily executable traces or runtime ordering contracts.

---

## Phase 3 — Name: essence extraction (L2 ⊗ L3)

**What it is.** Layer 2's geometric discoveries (role classes, functors, colimits, operadic operations) get labeled by Layer 3's LLM enrichment loop. Existing motif-labeling machinery (`ctkr label-motifs`, evidence packs, structured LLM output) extends to label the L2 outputs.

**What we get — three flavors of essence:**

1. **Confirmation of known patterns.** Many L2 discoveries will map to documented design patterns (Strategy, Observer, MVC, Hexagonal). L3 proposes labels with source evidence; these interpretations require review and are not structural ground truth.

2. **Naming of unnamed patterns.** Some L2 discoveries don't match anything documented but recur across many repos. L3 proposes a name + description with evidence. These are new patterns the field has converged on without naming.

3. **Pre-conceptual presentation.** Some L2 discoveries resist clean labeling — they're real structural regularities, but no language fits. We surface them as exemplar sets + visualizations + contrast pairs, letting human users perceive the pattern directly and conceptualize on their own side. This is the deepest version of "grok."

**Pipeline.**

- L2 outputs (role classes, functors, colimits, operads) → evidence pack assembler (existing `evidence.py`, generalized) → LLM labeler (existing `label_motifs.py` pattern, extended schemas) → `patterns.jsonl` with new `source_kind` values (`"role-class"`, `"functor"`, `"colimit-object"`, `"operad-op"`).

- For pre-conceptual cases: emit `unnamed_patterns.jsonl` instead, with high-quality exemplar sets and structural evidence, marked for human review.

**MCP tools.** `ctkr.pattern_search` (from Phase 1) gains new `source_kind` filters. New tool `ctkr.unnamed_patterns(scope?, min_support?)` for surfacing the unconceptualized.

### Pre-conceptual UX — findings from the 2026-05-28 prototype

The prototype spike (`MetaCoding-5wi`) tested three presentation formats on a real candidate pattern (the correlated tool-result re-injection across 5 LLM-agent frameworks). The findings shape the `ctkr.unnamed_patterns` design:

- **Contrast pair is the strongest format.** Showing one canonical exemplar against a near-miss (a counter-example that *almost* fits but doesn't) lets the reader perceive the pattern's boundary before they can name it. Better than side-by-side (which needs annotation tables to work) and better than structural skeleton alone (which evokes naming pressure prematurely).
- **Do NOT include a `label` field in the output.** A label slot creates immediate naming pressure that forecloses the pre-conceptual state. Once an LLM has proposed a name, the reader can no longer perceive the pattern as unnamed.
- **Replace `label` with `labeling_pressure` metadata** — a structured note capturing what words *kept trying to form* during analysis, without committing to any of them. Preserves the naming-difficulty signal without preempting human perception.
- **Annotation axes over prose.** Use `{axis, verdict: "constant"|"varies"|"absent"}` triples to highlight what's structurally invariant across exemplars vs. what varies, rather than free-text descriptions.
- **Suggested output order**: contrast pair first, exemplar set with annotation axes second, structural skeleton as opt-in metadata.

Details and full rationale: [`../notes/preconceptual-prototype-findings.md`](../notes/preconceptual-prototype-findings.md).

---

## Phase 4 — Sustain: cross-cutting infrastructure

Not new analyses — the plumbing that makes everything above usable continuously rather than as a batch job.

### 4a — Multi-tier embeddings with unified KNN

Today: one embedding type (DeepWalk over the graph). Needed: three tiers addressable through one interface.

| Tier | Source | Captures | Existing? |
|---|---|---|---|
| **Structural** | DeepWalk / GraphSAGE over graph | local topology + edge-type mix | yes (`embed.py`) |
| **Semantic** | text embedding of name + signature + docstring | nominal/lexical similarity | new |
| **Diff** | trigram-hashed sparse vector of file diffs | change-shape similarity (used by dreamseed) | new (port from harness) |

All three indexed in the same HNSW interface (`nn_index/{structural,semantic,diff}/`), queryable through a single `embedding_kind` parameter in `ctkr.nearest_symbols`.

### 4b — Incremental index maintenance

Today: CTKR is full-scan; you re-run `ctkr embed` / `ctkr mine-motifs` / etc. against the whole graph. Needed: file-watch + partial recompute.

- Watch `.metacoding/graph.lbug` and the FTS tokens for changes (mtime + checksum).
- On change, identify the symbol delta (added / removed / modified).
- Recompute only the affected artifact rows: embeddings for changed symbols' neighborhoods; motifs whose anchor symbols touched; centrality rows for affected components.
- Cold artifacts rebuilt on first query.

### 4c — Provenance + immutability

Every artifact row carries `{sha, generated_at, source_uri, schema_version}`. Updates create new rows; old rows are immutable. The Parquet files become append-only logs of analysis history. Auditability matches what Orchestrators wants for ethos rules — applied at the meta level.

### 4d — Worktree-aware reads

MetaCoding already tracks `{repo, branch, repo_commit_sha}`. Extend to `{repo, branch, worktree, repo_commit_sha}` so two worktrees of the same branch produce distinct addressable rows. Matches Dreamball's planned branch-identity model.

---

## How a query flows through

Historical hypothetical example, not a measured result or current API recipe:
*"What structural patterns recur across the agent-orchestrator corpus?"*
The original corpus size and illustrative names below identify the proposal,
not established correspondences.

1. **Phase 1 retrieval.** `ctkr.motif_search(min_support=12, edge_kinds=[CALLS,IMPLEMENTS])` returns recurring structural patterns.
2. **Phase 2a.** For each candidate role symbol (`Agent`, `Crew`, `Task`, …), `ctkr.similar_roles` retrieves candidates by structural profile (legacy alias `ctkr.role_equivalent`); inspect their source evidence.
3. **Phase 2b.** Pairwise functors over the 59 repos give the mapping tables — `crewAI.Crew ↔ autogen.GroupChatManager ↔ mastra.Workflow`, with edge-preservation scores and assignment ambiguity.
4. **Phase 2c (proposed).** A shared-role summary might contain candidate classes such as `Orchestrator`, `Worker`, `Task`, `Tool`, and `Memory`. Neither those labels nor universal corpus support nor a colimit are established by this example.
5. **Phase 2d.** `ctkr.composition_patterns` (legacy alias `ctkr.composition_rules`) reads supported role-path and fan-in patterns. These are static observations, not a recovered operadic structure.
6. **Phase 3.** L3 proposes labels with evidence. Output: a tentative pattern summary to test against exemplars and counterexamples, not *the* agent-orchestrator pattern or a verified colimit.

This was an illustrative research flow, not a validated corpus result or semantic guarantee. Similar experiments may be tried on HTTP servers, state machines, build systems, or AST visitors; each needs an explicit comparison with simpler graph tools and source-backed task outcomes.

---

## Open theoretic questions

These don't block Phase 1 but will shape Phase 2 and beyond.

- **Categorical pushout for true colimits (v2).** Phase 2c proposed alignment-guided community detection as a shared-role summary. It does not establish a colimit. A categorical construction needs an explicit diagram and well-defined functors; fidelity=1.0 alone is not a certificate. Worth implementing once the approximate version proves signal. Closest reference: Catlab.jl's diagram operations, ported to TS.
- **Persistent clustering of role classes.** Functor edges carry fidelity ∈ [0, 1]. As you sweep the threshold, communities grow and merge. The *persistent* communities (stable across a wide threshold band) are robust role classes; the *ephemeral* ones are noise. This is the same idea as persistent homology applied to functor-induced equivalence — gives us a principled "this role class is real" signal without committing to a threshold. Follow-up MCP tool: `ctkr.essence_persistence(scope?)`. The same construction applies to hom-profile granularity at Phase 2a — see [`../notes/entropy-as-dial.md`](../notes/entropy-as-dial.md) for the generalized treatment.
- **2-category structure.** Pairwise functors between repos compose. The 2-cells (natural transformations between functors) record "different ways of viewing the same correspondence" and may be where the deepest essence lives.
- **Persistent functors over git history.** Persistent homology gives time-varying topological signatures. Is there a corresponding "persistent functor" construction over the time-filtered graph? (Likely yes, via Reeb graphs or zigzag persistence.)
- **The colimit-fix point.** L3 labels feed back as priors for L2 functor discovery. Iterating creates a closed refinement loop. Does it converge? To what?

---

## References — entry points

For practitioners building on this:

- **Spivak, *Category Theory for the Sciences*** (free PDF) — the most accessible CT-for-engineers book, with the schema-as-category framing.
- **Fong & Spivak, *Seven Sketches in Compositionality*** (free PDF) — applied CT, includes operads, functorial data migration, hypergraph categories.
- **Riehl, *Category Theory in Context*** — rigorous but readable; chapter on Yoneda is the best in print.
- **[nLab](https://ncatlab.org)** — encyclopedic; entries on Yoneda, colimit, operad linked above.
- **[Catlab.jl](https://github.com/AlgebraicJulia/Catlab.jl)** — practical Julia implementation of finitely-presented categories, functors, colimits. Reference implementation when we build Phase 2c.
- **Mac Lane, *Categories for the Working Mathematician*** — the canonical reference, dense but authoritative.
