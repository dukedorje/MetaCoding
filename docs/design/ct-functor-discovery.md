# CT Functor Discovery — Phase 2b design

> **Research/design vocabulary, not a shipped guarantee.** This document retains
> historical categorical terminology. Current implementations and preferred names
> are defined in [Structural analysis: names and guarantees](structural-analysis-terminology.md).
> Profiles are lossy signatures, mappings are approximate structural alignments,
> and mined paths are composition patterns—not verified categorical laws.
> Category-theory extensions are an [optional research track](category-theory-research.md),
> after repeated useful graph/search workflows, not a prerequisite for them.

How MetaCoding computes partial, structure-preserving maps between the categories of two codebases. This is the design + build plan for **Phase 2b** of the CTKR ladder ([`ct-pipeline.md` §2b](./ct-pipeline.md#2b--functor-discovery-cross-repo-structural-maps)); it consumes Phase 2a's hom-profiles and produces the functor edge stream Phase 2c's colimit construction runs on.

Companion docs: [`../VISION.md`](../VISION.md) (why), [`ctkr.md`](./ctkr.md) (theoretics), [`ctkr-artifacts.md`](./ctkr-artifacts.md) (artifact conventions), [`../notes/ctkr-bead-roadmap.md`](../notes/ctkr-bead-roadmap.md) (the deferred bead set this plan instantiates).

Decisions honored, not relitigated:

- **MetaCoding-ebg** — edge preservation is *partial weighted with fidelity metadata*. Fidelity is data, not a gate; callers filter at query time.
- **MetaCoding-at0** — Phase 2c consumes `functor_edges.parquet` as a weighted meta-graph edge stream for Louvain. The artifact shape below is designed around that consumer.
- **MetaCoding-p4b** — TS owns Phase 2 machinery. The search runs in TypeScript (`src/ctkr/`), reading `hom_profiles.parquet` through the existing DuckDB loader (`src/ctkr/artifacts.ts`) and typed edges through the graph store. No Python is required for this phase (see [Language seam](#language-seam)).
- Terminology per the 2026-05-28 session: what we compute is a **graph homomorphism with edge-preservation fidelity**. We call it a functor when fidelity = 1.0 and an *approximate functor* otherwise. "Strict/partial/approximate", never "faithful/lax".

---

## 1. Formalization

### 1.1 The categories

For an indexed repo `R`, the category `C_R` is the free category on the typed multigraph:

- **Objects** `O(C_R)`: the Symbol nodes of `R` that survive the hom-profile kinds filter (i.e. the rows of `hom_profiles.parquet` with `repo = R`; file-kind symbols are excluded per `MetaCoding-o7k` option A).
- **Generating morphisms**: the typed edges of the schema — `CALLS, REFERENCES, EXTENDS, IMPLEMENTS, OVERRIDES, INJECTS, CONTAINS, IMPORTS, ANNOTATES, TYPE_OF, READS_FIELD, WRITES_FIELD, RETURNS_TYPE, CONSTRUCTS` (the 14 kinds in `EDGE_KIND_VALUES`, `src/store/types.ts`) — restricted to edges whose both endpoints are objects.
- **Composition**: path concatenation in the free category. Every morphism is a typed edge path; identities are empty paths.

### 1.2 Partial weighted functor

A discovered functor from `C_A` to `C_B` is a pair `(F, φ)`:

- `F : dom(F) → O(C_B)` — an **injective partial map on objects**, `dom(F) ⊆ O(C_A)`. Injectivity is a v1 design choice (see [Risks §7.4](#74-one-to-many-correspondences) for the one-to-many discussion): it prevents the degenerate high-coverage map that sends everything to one hub.
- `φ : mapped pairs → [0, 1]` — per-pair fidelity metadata (defined below).

**Edge preservation.** A generating edge `e = s →ₖ t` in `C_A` with `s, t ∈ dom(F)` is *preserved* iff an edge `F(s) →ₖ F(t)` of the **same kind `k` and same direction** exists in `C_B`. This is the edge-type-preservation requirement: the functor's action on morphisms is "send `s →ₖ t` to the witness edge `F(s) →ₖ F(t)`", and the witness must carry the same type. Edges with an endpoint outside `dom(F)` are neither preserved nor violated — they're outside the subcategory the functor is defined on. This is exactly the partiality decided in MetaCoding-ebg.

**Witness well-definedness.** The store dedupes edges by `(src_id, dst_id, kind)` — parallel repeats fold into `Edge.count` (`src/store/types.ts`) — so the graph is per-kind simple and a witness, when it exists, is *unique*. That's what makes "send `s →ₖ t` to `F(s) →ₖ F(t)`" a well-defined action on generators rather than a choice among parallel edges; without it the morphism map would need an explicit witness-selection rule. Multiplicity is deliberately ignored: three call sites and one call site preserve the same morphism.

**Composition preservation.** In a free category, composition is path concatenation, so a map that preserves every generating edge automatically preserves every composite: the image of a path is the concatenation of the images of its edges. Therefore **checking edge preservation on generators *is* checking composition preservation** — no separate check is needed when fidelity = 1.0. When fidelity < 1.0, composites through a violated edge break, and composites through *unmapped* intermediate objects are undefined. We approximate the composition health of an approximate functor with an optional diagnostic:

```
path_fidelity_2(F) = |{typed 2-paths in dom(F) whose full image path exists in C_B}|
                     / |{typed 2-paths in dom(F)}|
```

computed over a bounded sample (default 10k 2-paths) and recorded on the functor row. It is diagnostic metadata, not part of the search objective — for a strict functor it is 1.0 by the free-category argument; the gap between `fidelity²` (the independence expectation) and observed `path_fidelity_2` measures whether violations are clustered (localized noise, good) or scattered (structural mismatch, bad).

### 1.3 Metrics

Let `E(dom F)` = the set of generating edges of `C_A` with both endpoints in `dom(F)` ("internal edges"), and `P(F) ⊆ E(dom F)` the preserved ones.

```
coverage(F)  = |dom(F)| / |O(C_A)|                    ∈ [0, 1]
fidelity(F)  = |P(F)| / |E(dom F)|                    ∈ [0, 1]   (undefined when E(dom F) = ∅ — stored −1, surfaced null)
```

Per-pair fidelity, the column Phase 2c weights its meta-graph with — for a mapped pair `(s, F(s))`, over the internal edges incident to `s`:

```
pair_fidelity(s) = |preserved internal edges incident to s| / |internal edges incident to s|
```

(`null` when `s` has no internal edges — an isolated mapped object contributes coverage but carries no structural evidence; Phase 2c and the MCP tool must treat `null` as "no evidence", not as 1.0.)

The same discipline applies at the functor level: a functor row with `n_edges_internal = 0` has *no* fidelity, not perfect fidelity. It is stored as `-1` and must fail any `min_fidelity > 0` filter (a `min_fidelity = 0` caller still sees it, flagged). An edgeless `dom(F)` preserves nothing and proves nothing — reporting it as 1.0 would make the most evidence-free maps look the most functorial.

Aggregate fidelity is the edge-count-weighted mean of pair fidelities — equal to `|P|/|E(dom F)|` up to the factor-2 double-count, so the two views are consistent.

**The coverage/fidelity trade-off is explicit.** Shrinking `dom(F)` to well-matched cores raises fidelity and lowers coverage; the search emits the map at a configured operating point and records the config, and callers re-filter via `min_pair_fidelity` at query time (the MetaCoding-ebg discipline: 1.0 = pure functor, 0.8 = robust approximation, 0.5 = exploratory).

**Directionality.** `F : C_A → C_B` and `G : C_B → C_A` are different objects with different scores (a small library maps into a big framework with high coverage; the reverse doesn't). The pipeline computes and stores both directions per repo pair.

---

## 2. Algorithm — seeded constraint propagation with greedy extraction

### 2.1 Why not exact search

Maximum common (typed) subgraph and maximum-fidelity partial homomorphism are NP-hard; VF3-class subgraph-isomorphism algorithms answer the wrong question (exact induced embedding, all-or-nothing) and blow up on graphs beyond a few thousand nodes without heavy pruning. What we want — a *maximal partial map scored by a soft objective, with anytime behavior* — is the shape of **seeded graph matching**, and the practical prior art is:

- **Similarity Flooding** (Melnik, Garcia-Molina, Rahm, ICDE 2002) — fixpoint propagation of pairwise similarity over the product graph; our propagation step is exactly this, restricted to typed edges.
- **Seeded graph matching / FAQ** (Fishkind et al., Vogelstein et al.) — relaxed QAP with seeds; validates the "seeds + local refinement beats global search" strategy.
- **VF2/VF3** (Cordella et al.; Carletti et al.) — the feasibility-rule discipline (only extend a partial map when local constraints hold) is what our candidate pruning borrows, without demanding exactness.
- **CSP arc consistency (AC-3)** — pruning a candidate pair when its typed-edge support disappears is arc-consistency over the candidate lists.
- Categorically: Fong & Spivak, *Seven Sketches* ch. 3 (schema morphisms as functors) frames what the output *is*; the search itself is graph matching, honestly.

### 2.2 Pipeline

Input: repo pair `(A, B)`, `hom_profiles.parquet`, typed edge lists for `A` and `B`. Output: mapping `{(s, F(s), score, pair_fidelity)}` + functor-level metrics.

**Step 0 — Load & filter.** Pull objects (hom-profile rows) and internal typed edges for both repos into memory as CSR-style adjacency indexed by `(edge_kind, direction)`. At the observed scale (per-repo 2k–30k symbols within the ~300k corpus; edges a small multiple of that) this is tens of MB — in-process is fine.

**Step 1 — Candidate blocking (hom-profile KNN seeds).** For each object `s ∈ A`, take its top-`k_seed` (default 10) hom-profile nearest neighbors in `B` by cosine distance (the `homProfilesKnn` primitive, batched as one DuckDB cross-repo query rather than N calls), keeping candidates with distance ≤ `τ_seed` (default 0.30). Hard-block on symbol kind compatibility (class↔class/interface, function↔function/method, field↔field) — cheap and prunes hard. Objects with no surviving candidate are simply outside `dom(F)`: this is where partiality enters, and it's also what makes the whole thing tractable — the search space is `Σ|cand(s)| ≈ k_seed·|A|`, not `|A|·|B|`.

**Blocking under BORDERLINE seeds.** Measured reality (2026-07-13, --scip self-index): hom-profile entropy is 4.845 bits — usable but coarse, with ~16% of symbol pairs >0.9 cosine-similar and top-5 profile coverage at 67.7%. Two consequences for blocking, both cheap:

- *Adaptive widening.* A fixed `k_seed` truncates exactly where seeds are least informative. When `s`'s KNN distances are flat (`d(k_seed) − d(1) < δ_flat`, default 0.05), widen to `k_wide` (default 25) and mark `s` low-confidence; the flatness itself is signal that structure, not seeds, must decide. Prefer the relative cut `d ≤ d(1) + δ_rel` over the absolute `τ_seed` alone — absolute thresholds are miscalibrated in low-entropy profile regions.
- *Seed confidence.* Record each source's seed margin `m(s) = d(2) − d(1)` and carry it into propagation: `σ₀` from a flat region should not be trusted as strongly as `σ₀` from a sharp one (see Step 2). This is the confidence-aware down-weighting of low-entropy seed regions.

**Candidate recall is the load-bearing number.** If the true match isn't in `cand(s)`, nothing downstream can recover it. The spike must measure candidate recall on the rename fork (fraction of true pairs present after blocking) *before* tuning anything else — it gates `k_seed`/`δ_flat`, and if it's low the fix is upstream (the MetaCoding-ijo RAISES/DECORATES edges), not algorithmic.

**Step 2 — Constraint propagation (similarity flooding over typed edges).** Initialize `σ₀(s,t) = homProfileSimilarity(s,t)` for each candidate pair. Iterate for `R` rounds (default 8, or until max delta < 1e-3):

```
σᵣ₊₁(s,t) = α · σ₀(s,t)
          + (1−α) · (1/|N(s)|) · Σ over typed edges s →ₖ s′ (both directions)
                                   max{ σᵣ(s′,t′) : t′ ∈ cand(s′) with t →ₖ t′ in B }
                                   (0 when no such t′ exists)
```

with `α = 0.3`. Reading: *a candidate pair is good if the pair's own hom-profiles match AND each typed edge out of `s` can be matched by a same-typed edge out of `t` landing on a good candidate pair.* This is the constraint "if `a↦a′` and `a —CALLS→ b`, then `b` should map to some `b′` with `a′ —CALLS→ b′`", softened into a score instead of a hard rule — hard propagation is what makes strict matchers brittle on real code, and MetaCoding-ebg says record the failure, don't reject the map.

Three hardenings on the raw flooding recurrence, all mandatory — vanilla similarity flooding **saturates on BORDERLINE seeds**. When ~1 in 6 pairs is near-indistinguishable, almost every neighbor edge finds *some* candidate-supported witness, the max-term approaches a constant for everyone, and the fixpoint collapses back to `α·σ₀` rank order — propagation adds no discrimination exactly where it's needed. The fixes:

1. **Per-round competitive normalization (Sinkhorn-style).** After each round, L1-normalize `σ` across each source's candidate list, then across each target's claimant list (one or two alternating passes on the sparse candidate matrix). Candidates now *compete*: a target claimed by 500 sources can't score high for all of them, which also kills the hub-attractor failure (a popular `t` accumulating mass from every lookalike) without waiting for injective extraction to clean it up. This turns Step 2 into a soft-assignment / entropic-coupling iteration — see the fused-GW connection in §8.1. Keep the *pre-normalization* converged `σ` as the emitted `similarity` column; normalization shapes the dynamics, not the reported evidence.
2. **Kind-discriminativeness weights.** Weight each edge kind's contribution by inverse corpus frequency (`w_k ∝ 1/log(2 + freq_k)`, precomputed per run and recorded in `config`). A matched `INJECTS` or `OVERRIDES` edge is strong evidence; a matched `CONTAINS` edge is nearly none — 57.5% of pre-scip symbols collapsed onto `CONTAINS:in=1.00`, and unweighted propagation would happily rediscover the directory tree (Risk §7.3) with high confidence.
3. **Seed-confidence damping.** Scale the `α·σ₀` anchor term by the seed margin from Step 1 (`α_eff(s) = α · (0.5 + 0.5·min(1, m(s)/δ_flat))`): flat-region seeds anchor weakly and let structure dominate; sharp seeds anchor strongly. Exact form is a spike decision; the invariant is *low-entropy seed regions must not be allowed to vote with full weight*.

The denominator `|N(s)|` counts every typed edge of `s`, including edges to objects with no candidates — those contribute 0. This is a deliberate conservative bias (a symbol whose neighborhood is unmatchable *should* score lower), but it double-punishes boundary nodes of a genuinely-partial correspondence; the runner also tracks the candidate-supported degree so the spike can compare both normalizations on the rename fork.

**Convergence & determinism.** The max-operator recurrence is bounded in [0,1] but not guaranteed monotone; `α > 0` acts as damping (PageRank-style restart). We don't rely on convergence: the loop runs at most `R` rounds and exits early only on the delta tolerance, and the result is well-defined either way. Determinism is a *summation-order* contract, not just a tie-break contract: adjacency lists are sorted by `(edge_kind, dst_symbol_id)` at build time, accumulation is sequential in that order (no parallel reduction over floats — non-associativity would break byte-identical artifacts), and any future parallelism must partition by source symbol with per-source sequential accumulation.

**Arc-consistency pruning** between rounds: drop candidate `(s,t)` when `σᵣ(s,t) < ε_prune` (default 0.05) or when fewer than `⌈β·deg(s)⌉` of `s`'s typed edges have *any* candidate-supported witness at `t` (default β = 0.25). Pruning shrinks the frontier each round; the max-over-candidates inner loop is bounded by `k_seed`.

**Complexity**: `O(R · Σ_s deg(s) · k_seed²)` ≈ `O(R · |E_A| · k_seed²)` — for a 30k-symbol repo with 150k edges, `8 · 150k · 100 = 1.2·10⁸` cheap ops, seconds in Bun. The corpus-scale cost is the number of repo *pairs*, addressed in Step 5.

**Step 3 — Extraction (greedy maximum-weight matching).** Sort all surviving candidate pairs by converged `σ` descending (ties broken by `(src_symbol_id, dst_symbol_id)` lexicographic — determinism is a contract; same inputs + config must yield byte-identical artifacts). Greedily accept pairs whose source and target are both unclaimed.

Greedy is a ½-approximation to max-weight matching, but on BORDERLINE seeds the ½-approx bound is not the real cost — **assignment identity under ties is**. When several candidates score within ε, greedy resolves them by lexicographic accident: deterministic, but arbitrary, and total matching *weight* barely notices (the near-ties have near-equal weight) while the *mapping* can be near-random among lookalikes. Two consequences:

- Every accepted pair records its **`margin`** — converged `σ` of the accepted candidate minus the best unaccepted alternative for the same source (`1.0` when there is no alternative). A high-similarity/low-margin pair is a coin-flip and downstream consumers (Phase 2c weighting, the MCP tool, humans) must be able to see that. This is the honest-uncertainty move: don't pretend the matcher resolved what the data left ambiguous.
- The spike measures the **ambiguity rate** (fraction of accepted pairs with `margin < δ_amb`, default 0.02). If it's material (>10%), upgrade extraction from global greedy to **exact max-weight matching per connected component** of the surviving candidate graph (LAPJV/Hungarian; components are small after pruning since each source holds ≤ `k_seed` candidates, with greedy fallback above a component-size cap). Exact matching doesn't invent information ties don't contain, but it resolves them consistently with global structure instead of symbol-id ordering.

**Step 4 — Fidelity scoring + repair.** Compute `pair_fidelity` for every accepted pair and functor-level `coverage` / `fidelity`. Then a bounded hill-climb (default 2 sweeps):

- *Drop*: remove a pair whose `pair_fidelity < f_min` (default 0.10) **and** whose removal raises functor fidelity — these are hom-profile lookalikes with no structural support, the raw material of the high-coverage/low-fidelity mirage (Risk §7.1).
- *Swap*: for dropped sources, retry their next-best unclaimed candidate; accept if it scores positive pair fidelity.

The search is **anytime**: Steps 2–4 all improve monotonically-inspectable state, and each has a bounded budget; a wall-clock cap (default 120 s/pair) exits with the current extraction, recording `budget_exhausted: true` in the functor row's config blob.

**Step 5 — Corpus-level gating.** All-pairs over 59 repos is 1,711 pairs × 2 directions. Don't: gate pair selection by cheap Phase 1 signals — `shape_distance` top-`k_repos` neighbors (default 10) and/or motif `repo_coverage` overlap. The runner accepts an explicit pair list too (the MCP consumer's on-demand path only ever needs one pair).

### 2.3 Where this could have been Python — and why it isn't

Nothing here needs gudhi/gensim. It needs: a parquet reader (have it: DuckDB-Node), typed adjacency (trivial), float loops (fine in TS/Bun), and optionally Hungarian (200 lines, well-known). Per MetaCoding-p4b, TS owns it; the only Python touch is `ctkr/schema.py` staying the canonical schema source (§3.3) so the pydantic→TS codegen (`MetaCoding-0pz`) keeps types honest.

**Edge access.** Hom-profiles seed the search but the propagation needs the actual typed edges. The MCP/TS process already owns the graph store (`src/store`, `graph.lbug`); the functor runner reads per-repo edge lists through it (one query per repo: all typed edges with both endpoints in the repo). No new artifact or Python export lane is required. If store-read-at-scale turns out slow, fallback is a `ctkr export-edges` parquet lane — deliberately not designed until the spike proves the need.

---

## 3. Artifacts

Both files live in `.metacoding/ctkr/` beside the existing set and follow [`ctkr-artifacts.md`](./ctkr-artifacts.md) conventions: Parquet, `schema_version` on every row, canonical pydantic models in `ctkr/schema.py` with codegen'd TS mirrors, manifest presence booleans (`functors`, `functor_edges`) plus `n_functors`, `n_functor_edges` counts.

### 3.1 `functors.parquet` — `FunctorRow`

One row per `(repo_src, repo_dst, config)` discovery run — a *directed* pair; both directions appear as separate rows.

| column | type | meaning |
|---|---|---|
| `functor_id` | string | blake3 of `(repo_src, repo_dst, config_json, mapping digest)` — stable, content-addressed |
| `repo_src` | string | source repo (domain category `C_A`) |
| `repo_dst` | string | target repo (codomain `C_B`) |
| `n_objects_src` | int | `|O(C_A)|` — denominator of coverage |
| `n_mapped` | int | `|dom(F)|` |
| `coverage` | float32 | `n_mapped / n_objects_src` |
| `fidelity` | float32 | `n_edges_preserved / n_edges_internal`; `-1` when `n_edges_internal = 0` |
| `n_edges_internal` | int | typed edges of `C_A` with both endpoints in `dom(F)` |
| `n_edges_preserved` | int | of those, edges with a same-kind witness in `C_B` |
| `path_fidelity_2` | float32 | sampled 2-path composition diagnostic (§1.2); `-1` if not computed |
| `cycle_consistency` | float32 | fraction of `s ∈ dom(F)` with `G(F(s)) = s`, where `G` is the stored reverse-direction functor under the same config; `-1` when the reverse hasn't been computed. Cheap (both directions are computed per pair anyway) and the strongest ground-truth-free lie detector we have — see §5.6 |
| `config` | string | JSON blob: `{k_seed, k_wide, delta_flat, tau_seed, alpha, rounds, beta, epsilon_prune, f_min, delta_amb, kind_weights, extraction: "greedy"\|"lap", budget_exhausted, hom_profiles_generated_at}` |
| `generated_at` | string | ISO 8601 |
| `schema_version` | int | row-level guard |

The `hom_profiles_generated_at` field inside `config` ties the functor to the hom-profile artifact generation it was seeded from — staleness detection, same trick as `NNIndexMeta.embeddings_source`.

### 3.2 `functor_edges.parquet` — `FunctorEdgeRow`

One row per object↦object correspondence. **This is the Phase 2c meta-graph edge stream** (MetaCoding-at0): Louvain's nodes are `(repo, symbol_id)` across the corpus; each row here is a weighted meta-edge.

| column | type | meaning |
|---|---|---|
| `functor_id` | string | FK into `functors.parquet` |
| `src_symbol_id` | string | matches `Symbol.id` |
| `src_repo` | string | denormalized (Louvain builds the meta-graph without a join) |
| `src_qualified_name` | string | denormalized for human-readable output |
| `dst_symbol_id` | string |  |
| `dst_repo` | string |  |
| `dst_qualified_name` | string |  |
| `similarity` | float32 | converged propagation score `σ` — seed evidence ⊗ neighborhood consistency |
| `margin` | float32 | `σ` gap to the best unaccepted alternative for this source (§2.2 Step 3); low margin = the assignment was a near-coin-flip among lookalikes — expected often under BORDERLINE seeds, and consumers must be able to discount it |
| `pair_fidelity` | float32 | preserved/total internal incident edges (§1.3); `-1` when no internal edges (no evidence — consumers must not read as 1.0) |
| `n_edges_incident` | int | internal typed edges incident to `src` (evidence mass — Phase 2c can weight by it) |
| `n_edges_preserved` | int | of those, preserved |
| `schema_version` | int |  |

**Recommended Phase 2c weight**: `pair_fidelity` where `≥ 0`, optionally scaled by `log(1 + n_edges_incident)`; `similarity` is kept as an independent column so the colimit lane can choose — both metrics ride along rather than pre-committing (artifact-shape-held-lightly, MetaCoding-63v). Fidelity sits in [0,1] and Louvain modularity handles it natively; the threshold-sweep/persistence story from the design session needs exactly this raw per-edge weight, unthresholded.

### 3.3 Writer & schema ownership

The runner is a TS CLI entry (`bun run src/ctkr/functorRunner.ts --data-dir … --pairs …` — final invocation shape decided at implementation), writing Parquet via the same DuckDB-Node instance the loader uses, then updating `manifest.json`. Canonical row models are added to `ctkr/ctkr/schema.py` (`FunctorRow`, `FunctorEdgeRow`, `*_COLUMNS` tuples, round-trip tests in `tests/test_schema.py`) even though Python never writes them — one schema authority, codegen keeps `types.gen.ts` in sync, and Python-side L3/analysis code can read the artifacts without re-declaring shapes.

Runs are append-idempotent: re-running a pair with the same config produces the same `functor_id` and replaces those rows; a new config appends new rows (pre-Phase-4c approximation of immutability — full provenance columns arrive with 4c).

---

## 4. MCP surface — `ctkr.functor_between`

Follows the `ctkr-tools.ts` pattern exactly: pure handler function + zod schema + entry in `CTKR_TOOL_DESCRIPTIONS` + registration in `registerCtkrTools`. Data dir from `METACODING_CTKR_DATA_DIR` (mandatory, no fallback — same `resolveCtkrDataDir()`). The tool **reads artifacts only**; discovery is the batch runner's job (same read-side discipline as every Phase 1 tool).

```ts
export interface FunctorSummary {
  functor_id: string;
  repo_src: string;
  repo_dst: string;
  coverage: number;
  fidelity: number;
  n_mapped: number;
  n_objects_src: number;
  path_fidelity_2?: number;
  generated_at: string;
}

export interface FunctorMappingRow {
  src_symbol_id: string;
  src_qualified_name: string;
  dst_symbol_id: string;
  dst_qualified_name: string;
  similarity: number;
  margin: number;                 // assignment confidence — low = coin-flip among lookalikes
  pair_fidelity: number | null;   // null = no structural evidence (isolated pair)
}

export interface FunctorBetweenResult {
  functor: FunctorSummary | null;      // null when the pair has no artifact row
  reverse?: FunctorSummary | null;     // B→A summary, when direction="both"
  mapping: FunctorMappingRow[];        // filtered + truncated
  truncated: boolean;
  _note?: string;                      // e.g. "no functor meets min_coverage=0.5; best available: 0.31"
}
```

Input schema (zod / JSON-schema mirror in `CTKR_TOOL_DESCRIPTIONS`):

| param | type | default | meaning |
|---|---|---|---|
| `repo_a` | string, required | — | source repo (domain) |
| `repo_b` | string, required | — | target repo (codomain) |
| `direction` | `"a_to_b" \| "b_to_a" \| "both"` | `"a_to_b"` | which stored direction(s) to return; `"both"` adds the reverse summary |
| `min_coverage` | number 0–1 | 0 | drop functors below this coverage |
| `min_fidelity` | number 0–1 | 0 | drop functors below this fidelity; `1.0` = pure (strict) functors only |
| `min_pair_fidelity` | number 0–1 | 0 | filter the returned mapping rows (query-time strictness dial, per MetaCoding-ebg) |
| `limit` | int 1–5000 | 200 | max mapping rows returned, sorted `pair_fidelity` desc, then `similarity` desc |

Semantics & error modes:

- Multiple functor rows for the pair (different configs) → return the one maximizing `coverage × fidelity` among those passing the filters; note alternatives count in `_note`.
- Pair present but fails `min_coverage`/`min_fidelity` → `functor: null` with an explanatory `_note` giving the best available scores (agents should learn the landscape, not just get an empty list).
- `functors.parquet` absent → throw `"functor artifacts not found in <dir> — run the functor discovery runner first"` (mirrors the loader's missing-artifact errors).
- `METACODING_CTKR_DATA_DIR` unset → existing `resolveCtkrDataDir()` throw.
- Unknown repo names → `functor: null`, `_note` listing available repos from `functors.parquet` distinct values.
- **Staleness**: when the functor's `config.hom_profiles_generated_at` differs from the current `hom_profiles` generation in `manifest.json`, the result still returns but `_note` flags it (`"functor was discovered against an older hom-profile generation — re-run the discovery runner"`). Silent staleness is how a regenerated corpus quietly serves months-old correspondences; same trick as `NNIndexMeta.embeddings_source`, but surfaced to the caller rather than only recorded.

`describe_api` picks the tool up automatically via the `CTKR_TOOL_DESCRIPTIONS` splice into `TOOL_DESCRIPTIONS` (`src/mcp/tools.ts`) — one new entry in the array, one `server.registerTool` block, same file, per the co-location rule documented there. Summary text leads with the use case: *"Discover how two repos' designs correspond: the maximal partial structure-preserving map (functor) between them, with per-correspondence fidelity."* New loader methods on `CtkrHandle`: `functors(opts)` and `functorEdges(functorId, opts)` with pushdown filters, mirroring `motifs`/`motifInstances`.

---

## 5. Eval / validation — real vs. noise

Extends the Phase 2a eval harness (`MetaCoding-23q.5`: 9 clusters / 48 ground-truth role members, stub-client wiring).

1. **Rename fork (the isomorphism control — must-pass).** Mechanically α-rename a small repo (identifiers, file names; structure untouched), index the fork, run discovery repo↔fork. Expect: `coverage ≥ 0.95`, `fidelity ≥ 0.98`, mapping correctness ≥ 0.90. **Correctness must be automorphism-aware**: real repos contain structurally identical symbols (copy-paste modules, generated clients, N interchangeable field accessors), and a name-blind matcher *cannot* distinguish members of a structural orbit — nor should it be penalized for swapping them. Score a pair correct when the predicted target lies in the same orbit as the true target, with the orbit approximated as "identical hom-profile AND identical sorted `(kind, neighbor-orbit)` edge lists" (one refinement round of the color-refinement/WL partition — cheap and conservative). Report raw exact-match correctness alongside; the *gap* between the two is the corpus's intrinsic ambiguity mass and the honest ceiling for every downstream number. Without this, the must-pass gate would fail on any repo with real duplication and pass only on artificially asymmetric fixtures.
2. **Edge-dropout fork (fidelity calibration).** Delete a random `p ∈ {5%, 15%, 30%}` of edges from the fork before indexing. Expect fidelity to track `1 − p` within a few points and coverage to degrade gracefully — verifies fidelity measures what it claims. (Note the confound: dropout also perturbs hom-profiles, so seeds shift and *coverage* moves too; the tolerance is deliberately loose and both metrics are recorded.)
3. **Null model (the noise floor — must-pass).** (a) Discovery against a degree-matched edge-rewired shuffle of repo B; (b) random kind-compatible object map scored directly; (c) **permuted-seed control** — real graphs, hom-profile rows shuffled among kind-compatible symbols before seeding. (c) isolates how much of the result is carried by structure vs. by seeds: if the permuted-seed run scores close to the real run, propagation is doing the work and BORDERLINE seeds are survivable; if it collapses, the whole lane is seed-bound and MetaCoding-ijo is the critical path. All three give the expected score of a meaningless map; report every real functor's fidelity as **lift over the null**, and put the null scores in the eval fixture so regressions are visible. A "discovery" without lift is noise, whatever its raw coverage says.
4. **Cross-framework ground truth (soft signal).** For repo pairs covering the 9 role clusters (crewAI/autogen/mastra…), measure how many ground-truth same-role pairs land in the mapping (recall) and spot-check precision on the top-50 by `pair_fidelity` (`crewAI.Crew ↔ autogen.GroupChatManager`-class assertions). Soft thresholds — these frameworks are *analogous*, not isomorphic; the numbers become the tracked baseline rather than a gate.
5. **Anytime/determinism checks.** Same input + config twice → byte-identical artifacts. Halved budget → strictly-subset-or-equal quality, never garbage.
6. **Cycle consistency (the plausible-but-wrong detector — must-pass on controls).** Compose the two stored directions: fraction of `s` with `G(F(s)) = s`. A high-fidelity map matched onto the *wrong* region of a self-similar codebase (boilerplate, mirrored subsystems) can pass every per-edge check — witnesses exist locally — while being globally displaced; round-tripping through the independent reverse search exposes it, because two independently-wrong maps rarely invert each other. Requires no ground truth, costs one join over artifacts already computed. Gate: ≥ 0.9 on the rename fork (automorphism-adjusted); tracked-not-gated on cross-framework pairs, where genuine one-to-many structure (Risk §7.4) legitimately lowers it.
7. **Seed-degradation stress (the BORDERLINE simulation).** On the rename fork, progressively corrupt seeds before search — add noise to profile vectors and/or collapse a fraction `q ∈ {10%, 20%, 30%}` of profiles onto their nearest neighbor (mimicking the measured ~16% near-indistinguishable mass). Plot mapping correctness vs. `q`. The requirement is *graceful degradation and an honest signal*: correctness may fall, but reported `margin` must fall with it (Spearman check) — the matcher is allowed to be wrong under bad seeds, not allowed to be confidently wrong. This is the test that certifies v1 for the seeds it will actually run on.

---

## 6. Build plan

Maps 1:1 onto the deferred Phase 2b bead set in [`ctkr-bead-roadmap.md`](../notes/ctkr-bead-roadmap.md); create the beads from these rows when work starts.

**Hard prerequisite — `MetaCoding-73m` (SCIP reindex) — and the measured reality.** Functor quality is bounded by hom-profile quality. Without scip, seeds are BLOCKED (3.818 bits; 57.5% of symbols collapsed onto `CONTAINS:in=1.00` pre-scip — any discovered "functor" is a containment-scaffolding artifact). *With* scip (measured 2026-07-13, self-index): **4.845 bits — BORDERLINE, not a clean GO** (top-5 profile coverage 67.7%, ~16.4% of symbol pairs >0.9 cosine-similar). So the operating assumption for every task below is **usable-but-coarse seeds where ~1 in 6 pairs is structurally near-indistinguishable** — the §2.2 hardenings (adaptive blocking, competitive normalization, kind weights, seed-confidence damping, margins) and eval 7 exist because of this number, and none of them are optional polish. **Gate every task on repos indexed with `--scip`**; the spike may start on the 5-repo scip subset immediately; eval fixtures must record which lane indexed them. The concurrent `MetaCoding-ijo` epic (RAISES/DECORATES edges) sharpens seeds independently — `hom_profiles_generated_at` staleness detection makes re-running discovery after it lands cheap, and the eval suite must be re-run against the sharper seeds to quantify the lift (a free before/after experiment; don't waste it).

| # | Bead (type) | Deliverable | Acceptance criterion |
|---|---|---|---|
| 1 | spike: constraint-propagation algorithm | Throwaway TS harness: Steps 0–4 on one real scip-indexed repo + its rename fork and one dropout fork. Measures **first**: candidate recall after blocking, ambiguity rate (`margin < δ_amb`), saturation (rank correlation of converged `σ` vs `σ₀` — high = propagation added nothing). Decides: greedy vs per-component LAP extraction (gated on ambiguity rate >10%), normalization variant (§2.2 hardening 1), edge access via store vs export, defaults `α/k_seed/δ_flat/rounds/β` | Rename fork: ≥ 90% **automorphism-aware** mapping correctness (§5.1), < 60 s on a ~2k-symbol repo pair. Candidate recall reported — if < 0.9 the finding is "fix seeds (ijo), not algorithm" and downstream tasks pause. Written findings pin the §2.2 defaults (or revise them) |
| 2 | feature: TS functor search impl | `src/ctkr/functorSearch.ts` — typed-adjacency build, batched KNN seeding, propagation, pruning, extraction, fidelity scoring, repair; unit tests on hand-built fixture graphs (known optimum, partiality case, kind-blocking case, determinism case) | Tests pass under `bun test`; deterministic across runs; anytime budget honored; zero-edge and no-candidate degenerate inputs handled |
| 3 | feature: emit `functors.parquet` + `functor_edges.parquet` | Runner CLI + Parquet writers + `manifest.json` update; `FunctorRow`/`FunctorEdgeRow` in `ctkr/schema.py` + codegen'd TS types + column-order round-trip tests; `CtkrHandle.functors()/functorEdges()` readers | Round-trip: runner output loads through `CtkrHandle` with correct types/ordering; re-run same config → identical `functor_id`s; manifest booleans/counts correct |
| 4 | feature: `ctkr.functor_between` MCP tool | Handler + zod schema + `CTKR_TOOL_DESCRIPTIONS` entry + registration, per §4; tests mirroring `ctkr-tools.role-equivalent.test.ts` (happy path, filters, `direction:"both"`, all five error modes) | Tests pass; `describe_api` lists the tool; `min_fidelity=1.0` provably returns only strict functors from a mixed fixture |
| 5 | feature: eval harness extension | §5 suite: rename-fork + dropout + null-model (incl. permuted-seed) + cycle-consistency + seed-degradation in CI-runnable form (small fixture repos committed or synthesized); cross-framework recall/precision reported against the 9-cluster ground truth | Controls 1, 3 and 6 pass at stated thresholds; dropout tracks within tolerance; seed-degradation shows margin/correctness correlation (§5.7); cross-framework numbers recorded as baseline in the eval output |

Tasks 3 and 4 are independent once 2 lands; 5 needs 3. Each is independently shippable and separately verifiable.

---

## 7. Risks & open questions

### 7.1 The high-coverage/low-fidelity mirage

The named failure mode of partial-weighted: a map that pairs 80% of objects on hom-profile lookalikes with almost no edge support "discovers" a correspondence that means nothing — and partiality can also *hide* infidelity by silently shrinking `dom(F)` to a trivial core (high fidelity, meaningless coverage). Defenses, all in the design: injectivity (no hub collapse), `f_min` drop-repair (Step 4), `pair_fidelity` exposed per row so consumers filter, `n_edges_incident` distinguishing evidence-rich pairs from isolated ones, and the null-model lift as the reported headline rather than raw coverage. Residual risk: repos sharing heavy boilerplate (generated clients, vendored code) will score genuinely high — real structure, uninteresting essence. Mitigation deferred to Phase 2c, where boilerplate communities are visible corpus-wide; flag, don't solve, here.

### 7.2 Cross-language correspondence (TS↔Python)

Extractor lanes emit systematically different edge-kind mixes per language (e.g. `TYPE_OF`/`RETURNS_TYPE` density in TS vs Python), so raw hom-profile cosine carries a language-shaped bias, and seeding degrades exactly where the Yoneda hypothesis (VISION "cross-language essence") is most interesting. v1: eval gates on same-language pairs only; run one TS↔Python pair as an *experiment*, reported but ungated. If the bias is confirmed, the candidate fix is per-language edge-alphabet normalization at seed time (reweight profile dimensions by corpus-language marginals) — query-time, consistent with the maximal-precision artifact contract.

### 7.3 Granularity

Symbol-level functors on `CONTAINS`-heavy graphs risk rediscovering directory trees. The kinds filter and behavior-capturing edges mitigate; the real answer is module/class-granularity functors over *aggregated* hom-profiles — same algorithm, coarser objects, and likely the right resolution for "how do these two architectures correspond". Deliberately out of v1 scope; the artifact schema doesn't block it (a granularity field can join `config`), and the entropy-as-a-dial note already frames granularity as a query-time parameter. Revisit after Phase 2c shows which resolution the colimit actually wants.

### 7.4 One-to-many correspondences

Real designs split roles (`crewAI.Crew` ≈ autogen's `GroupChat` + `GroupChatManager`); injective v1 must pick one and drop the other. Recording near-miss alternates (2nd-best candidates above a score floor) as low-weight extra rows in `functor_edges.parquet` would feed Phase 2c useful evidence cheaply — the community detector merges what the matching had to separate. Decision deferred to the spike; if adopted, an `is_alternate` flag keeps the primary matching unambiguous.

### 7.5 Scale

Per-pair cost is fine (§2.2); corpus cost is pairs × directions. Gating (Step 5) plus the batch-runner model keeps this a scheduled job, not an interactive one. If repos beyond ~100k symbols appear, blocking must tighten (`k_seed` down, kind-blocking mandatory, possibly per-community sub-searches) — noted, not designed.

### 7.6 Open questions for downstream phases

- Should `fidelity` eventually be read as `P(true mapping)` and the whole lane go stochastic (posterior over maps, per the design session's Bayesian opening)? v1 stays deterministic; the artifact columns are compatible with that reading.
- Functor *composition* across repo chains (`A→B→C` vs discovered `A→C`) is a free consistency check and the entry point to the 2-category structure — cheap to compute from the artifacts once ≥3 repos are covered; tracked in the roadmap's research section, not built here. (Its 2-object special case, `G∘F` cycle consistency, *is* built here — §5.6.)

---

## 8. Architecture review — alternatives & hardening

Adversarial second pass (2026-07-13), grounded in the measured BORDERLINE seed quality (4.845 bits with scip; ~16% of symbol pairs >0.9 cosine-similar). This section records the alternatives considered, why the design keeps its frame, and the defenses added above. Honored decisions (MetaCoding-ebg/at0/p4b) were re-examined and stand.

### 8.1 Is seeded graph matching even the right frame?

Four alternatives were weighed seriously:

**Gromov-Wasserstein optimal transport — the strongest challenger.** GW is *literally* structure-matching between metric-measure spaces: it finds a soft coupling `π(s,t)` minimizing the discrepancy between intra-space structures, and **fused GW** adds a node-feature term — hom-profile cost as the Wasserstein part, typed adjacency as the Gromov part. Genuine advantages over similarity flooding: a *global* objective instead of a local fixpoint; soft couplings that natively express one-to-many correspondences (Risk §7.4) and the design session's fidelity-as-probability reading; marginal constraints that prevent hub collapse *by construction* rather than via the injectivity patch. Real costs: (a) the typed multigraph must be encoded into GW's cost tensor — one GW term per edge kind, kind-weighted, is workable but nonstandard; (b) entropic GW is non-convex and initialization-dependent, and byte-identical determinism (a hard contract here) requires pinning solver iteration order and never parallel-reducing floats; (c) dense couplings are O(|A|·|B|) memory — 30k × 30k is out — so it needs the *same candidate blocking* as the current design anyway; (d) fidelity would still be computed post-hoc from a rounded map, so GW replaces only Step 2–3, not the semantics.

**The verdict is a synthesis, not a swap.** Once GW is restricted to the sparse blocked candidate set and solved entropically, its Sinkhorn projections are *exactly* the per-round competitive normalization now mandated in §2.2 (hardening 1), and its fused feature term is the `α·σ₀` anchor. The hardened Step 2 **is a fused-GW-shaped iteration on the candidate support** — we keep the anytime/deterministic/partial-map skeleton that matches the MetaCoding-ebg semantics, and adopt the piece of GW that actually addresses the BORDERLINE failure mode (candidates competing for mass instead of everyone saturating). A full entropic fused-GW solver on the blocked support is the natural v2 *if* the spike's saturation metric shows the hardened flooding still under-discriminates; the artifact schema needs nothing new for it (couplings round to the same mapping + margin columns).

**Spivak-style schema functor / left Kan extension.** The honest framing of what the *output* is, and the right machinery for the module-granularity v2 (Risk §7.3), where categories are small and colimits/Kan extensions are computable Catlab-style. But it doesn't answer the *discovery* question at symbol scale: a Kan extension extends a functor you already have — circular when the functor is the thing being searched for. Kept as the formal target, not the search algorithm.

**Learned matcher (GNN embeddings + matching head).** Rejected for v1: no training pairs exist (the eval ground truth is 48 members — a validation set, not a training set), determinism and auditability degrade, and it contradicts the deterministic-structure/probabilistic-interpretation discipline. Becomes interesting only if hand-set kind weights (§2.2 hardening 2) prove inadequate — a learned kind-weighting is the minimal ML insertion point, far short of a learned matcher.

**Spectral / relaxed-QAP seeding (GRAMPA, FAQ).** Dense O(|A|·|B|) — blocked out at this scale as a global method. Noted as a per-component fallback if propagation stalls on large near-symmetric components.

### 8.2 Failure cases added defenses for

| Failure | Defense (where) |
|---|---|
| Propagation saturation on near-duplicate candidates — flooding converges back to seed order exactly where seeds are weakest | Competitive (Sinkhorn-style) per-round normalization; saturation metric in the spike (§2.2, §6 Task 1) |
| Greedy tie-breaking silently deciding lookalike assignments by symbol-id order | `margin` column on every pair + ambiguity-rate gate for per-component exact LAP (§2.2 Step 3, §3.2) |
| `CONTAINS` scaffolding masquerading as structural evidence | Kind-discriminativeness weights, recorded in `config` (§2.2) |
| Low-entropy seed regions voting with full confidence | Seed-margin damping of the anchor term; adaptive candidate widening (§2.2 Step 1–2) |
| Hub attractors — one popular target accumulating mass from thousands of sources | Target-side normalization pass (§2.2); injectivity remains the extraction-time backstop |
| `fidelity = 1.0` on edgeless `dom(F)` — evidence-free maps scoring as perfect functors | Undefined/−1/null semantics unified across §1.3, §3.1, §4; must fail `min_fidelity > 0` |
| Ill-defined morphism action under parallel same-kind edges | Witness uniqueness via store-level `(src, dst, kind)` dedup, made explicit (§1.2) |
| Structurally identical symbols (copy-paste, codegen) making exact-match eval unpassable and matcher choices unfalsifiable | Automorphism-aware correctness via one WL/color-refinement round; the exact-vs-orbit gap reported as intrinsic ambiguity mass (§5.1) |
| Plausible-but-displaced functor — locally witness-supported, globally wrong region | Cycle-consistency `G∘F` column + must-pass control (§3.1, §5.6) |
| Confidently wrong under degraded seeds | Seed-degradation stress: margin must fall with correctness (§5.7) |
| Nondeterminism from float non-associativity | Summation-order contract: sorted adjacency, sequential accumulation, no parallel reduction (§2.2) |
| Stale functors served after hom-profile regen | `hom_profiles_generated_at` checked against manifest at query time; `_note` staleness flag (§4) |
| Non-convergent flooding on cyclic structure | α-damping + bounded `R` rounds; result well-defined without convergence (§2.2) |
| Disconnected candidate components | Free with per-component extraction; components with no candidates are honest partiality (no change needed — recorded here so it isn't re-litigated) |

Boilerplate/vendored high-fidelity correspondences remain flagged-not-solved (§7.1) — genuinely real structure, corpus-level visibility arrives with Phase 2c; cycle consistency partially mitigates the *displaced*-match variant meanwhile.

### 8.3 Sequencing changes

1. **The spike is re-scoped from "tune defaults" to "measure the failure modes first"** — candidate recall, ambiguity rate, saturation — because on BORDERLINE seeds those three numbers decide whether the answer is algorithmic (normalization, LAP), parametric (`k_seed`), or upstream (wait for MetaCoding-ijo). Candidate recall < 0.9 pauses downstream tasks: no extraction cleverness recovers a true match that blocking discarded.
2. **Cycle consistency moved from "downstream research" (§7.6) into Task 3's artifact columns and Task 5's gates** — both directions are computed per pair anyway; the check is a join, and it's the only ground-truth-free lie detector available at v1.
3. **MetaCoding-ijo is treated as a scheduled seed upgrade, not a blocker**: v1 builds against BORDERLINE seeds by design, and the eval suite re-runs when ijo lands (staleness plumbing makes this cheap) — a free natural experiment quantifying seed-quality → functor-quality sensitivity, which is exactly the curve §5.7 simulates synthetically.
4. Task decomposition otherwise stands (2→{3,4}, 5 after 3): the boundaries are artifact-shaped and survived review.
