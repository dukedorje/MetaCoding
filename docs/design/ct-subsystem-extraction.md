# CT Subsystem Extraction — stack-agnostic specification pipeline

> **Research/design vocabulary, not a shipped guarantee.** This document retains
> historical categorical terminology. Current implementations and preferred names
> are defined in [Structural analysis: names and guarantees](structural-analysis-terminology.md).
> Profiles are lossy signatures, mappings are approximate structural alignments,
> and mined paths are composition patterns—not verified categorical laws.
> Category-theory extensions are an [optional research track](category-theory-research.md),
> after repeated useful graph/search workflows, not a prerequisite for them.

How MetaCoding takes **one** indexed project and extracts a per-subsystem, stack-agnostic specification — roles, composition laws, interface contract, data shapes, topology, and natural-language intent — good enough that the project can be **re-implemented from scratch in a different language and a completely different stack**.

This is the design for the *subsystem-spec-extraction* use case raised in the 2026-07-13 design discussion. It composes shipped primitives (Phase 1 tools, 2a hom-profiles, the 2b functor track) with the deferred 2c/2d machinery, and defines what 2c/2d must produce *for this use case specifically*.

Companion docs: [`../VISION.md`](../VISION.md) (the colimit/essence-extraction and cross-language-essence horizons), [`ctkr.md`](./ctkr.md) (theoretics), [`ct-pipeline.md`](./ct-pipeline.md) (the phase ladder), [`ct-functor-discovery.md`](./ct-functor-discovery.md) (Phase 2b — this pipeline's port-verifier), [`ctkr-artifacts.md`](./ctkr-artifacts.md) / [`ctkr-l3-artifacts.md`](./ctkr-l3-artifacts.md) (artifact conventions), [`../notes/entropy-as-dial.md`](../notes/entropy-as-dial.md) (dials, not gates), [`../notes/functor-spike/2hop-findings.md`](../notes/functor-spike/2hop-findings.md) (depth-as-a-dial; the 22.7% floor).

Decisions honored, not relitigated:

- **MetaCoding-ebg** — fidelity is metadata, not a gate; callers filter at query time.
- **MetaCoding-at0** — colimit-style constructions are functor-guided community detection (Option C), not textbook pushouts, in v1.
- **MetaCoding-p4b** — TS owns Phase 2 machinery and the MCP surface; Python keeps L1 mining and L3 labeling.
- **MetaCoding-63v** — artifact shapes held lightly until algorithmic contact.
- **MetaCoding-4ty** — single-repo/endofunctor mode for functor discovery, and depth-as-a-dial (--depth 1 for role *surfacing*, --depth 2 for precise 1:1 *correspondence*). This pipeline is that bead's primary consumer.
- Terminology per 2026-05-28: "strict/partial/approximate", never "faithful/lax". Extended here: what we extract is called a **presentation** when the role quotient is exact and an **approximate presentation** otherwise.

---

## 1. Formalization — presentation extraction, not isomorphism

### 1.1 What is different about this use case

Everything in Phase 2b/2c so far compares *existing* categories: functors between two repos, colimits across N repos. This use case is different in kind:

> Given **one** category `C` (the project), extract for each subsystem a **schema** — a small category presented by generators and relations — such that the original code is one *instance* of that schema and a faithful re-implementation in another stack is another instance of the *same* schema.

This is Spivak's databases-as-categories move run in reverse. In *Functorial Data Migration*, a schema is a finitely-presented category and an instance is a functor `Schema → Set`. Here: the extracted subsystem schema is the finitely-presented category; the original TypeScript code and the future Rust/Go/whatever port are both instances — set-valued functors that pick concrete symbols for each role class and concrete call paths for each composition law. **A stack-agnostic spec is a schema stripped of instance-specific accidents.** Porting = constructing a new instance of the same schema; verifying the port = discovering a functor between the two instances (§6).

The categorical construction, in three steps:

1. **DECOMPOSE.** Partition `C` into subsystems `S₁ … Sₙ` — full subcategories on disjoint object sets — with explicit **boundaries**: for each `Sᵢ`, the generating morphisms with exactly one endpoint inside. Those crossing morphisms *are* the subsystem's interface (§3).
2. **EXTRACT** each subsystem's **presentation**: its *generators* (role classes — the essential objects, obtained by quotienting members by structural equivalence) and its *relations* (essential composition laws — which role-typed paths recur, i.e. the empirical operad). This is where Phase 2c-style machinery (community detection over a weighted equivalence meta-graph) and Phase 2d (operad recovery) plug in, single-repo (§4).
3. **DESCRIBE.** Attach natural-language intent. Structure is name-blind and defines *what each element is and where it ends*; the NL lane (identifiers, comments, docstrings, README fragments) defines *what it is for*. The two lanes stay separate through analysis and fuse only in the output card (§5).

### 1.2 Honesty about the math

What we actually compute is not a categorical presentation in the strict sense:

- The role quotient is **approximate**. Members of a role class have *similar* (dial-controlled — [`entropy-as-dial.md`](../notes/entropy-as-dial.md)) hom-profiles, not provably isomorphic hom-functors. Exact-profile orbits (the WL classes from the 2-hop work) give an exact-but-conservative quotient; similarity clustering gives a useful-but-approximate one. Both are exposed; the dial chooses.
- The relations are **empirical**, not axiomatic. Phase 2d recovers composition patterns from *observed* call paths; a law with support 47 is strong evidence, not a proof. Associativity/unit violations are recorded, not hidden (per ct-pipeline §2d — "non-operadic composition is interesting in itself").
- **The N=1 problem is real and must be stated.** With a single repo there is no structural way to distinguish essence from accident — every quirk of this codebase is "supported by 1 of 1 instances." Cross-repo colimits solve this by voting across N instances; we don't have N. Three partial mitigations: (a) the **invariance tagging** of §6.1 (a normalization layer encoding *known* per-language/per-framework accidents, applied mechanically); (b) the **L3 lane** — the LLM, primed with the structural element and its evidence pack, judges "essential to intent vs. incidental to stack," which is exactly the kind of judgment LLMs are good for and exactly where we accept non-rigor; (c) **the port itself is the second instance** — the moment `S'` exists, `functor_between(S, S')` empirically separates what survived (essence) from what didn't (accident), and the card's invariance tags can be *corrected* from that evidence. The spec deck is therefore not a one-shot artifact; it sharpens with each port.

### 1.3 Relation to Phase 2c (and what changes)

Phase 2c's colimit (decision at0) builds a meta-graph whose edges are *cross-repo functor edges* and Louvain-clusters it into role classes. This pipeline reuses that machinery with **two different edge sources**, both intra-repo:

- **Partition meta-graph** (§2): edges are structural cohesion signals (typed adjacency, spectral community co-membership, H₀ co-component, directory/CONTAINS prior) → communities are *subsystems*.
- **Role meta-graph** (§4): within one subsystem, edges are hom-profile similarity (depth-1 — per MetaCoding-4ty, depth 1 is the role-*surfacing* dial; you *want* the orbits) plus intra-repo endofunctor edges (MetaCoding-4ty diagonal-exclusion mode, which finds internally-repeated structure) → communities are *role classes*, i.e. the schema's generators.

Same Louvain-over-weighted-meta-graph core, same persistence-sweep robustness story, different edge streams. **Open decision (new — flagged):** whether the Phase 2c implementation beads should be generalized to "meta-graph community detection with pluggable edge sources" so 2c-for-colimits and 2c-for-subsystems share one engine. Recommended yes; costs one abstraction seam in the runner.

---

## 2. Stage A — Subsystem partition (DECOMPOSE)

**Goal.** Partition the object set of `C` into subsystems with *robust* boundaries — robust meaning stable under the resolution dial, not an artifact of one clustering run.

### 2.1 Available-now approximation (v1)

Ensemble of three shipped/near-shipped signals plus one prior:

1. **Spectral/modularity communities** — `spectral_clusters.parquet` (Louvain per repo, shipped; queryable via `ctkr.centrality_query`). The primary signal.
2. **Cut vertices / articulation points** — the "real seams vs. nominal ones" from ctkr.md L1 §4. ⚠ **Reality check:** cut vertices are in the L1 *vision* but are **not currently computed or exposed** — `ctkr.centrality_query` returns pagerank/betweenness/eigenvector joined with clusters only (`src/mcp/ctkr-tools.ts`), and `ctkr/centrality.py` doesn't emit articulation points. High betweenness is a serviceable proxy in the interim; a proper `articulation` column on `centrality.parquet` is a small Task-1 line item (§7).
3. **Persistent-homology H₀** — `shape_pds.parquet` dim-0 bars under the existing filtrations give component births/merges: coarse subsystem count and merge scale. ⚠ **Reality check:** PH is computed *per repo*, not per subgraph; H₀ here is a corroborating global signal in v1, not a per-subsystem primitive (per-subsystem PD is a stretch task, §7 T7).
4. **Declared-structure prior** — directory / module / `CONTAINS`+`IMPORTS` structure. Deliberately a *prior with a low weight*, not ground truth: the interesting output is exactly where emergent structure disagrees with declared structure. But for a spec meant for human re-implementers, ignoring the declared module map entirely produces unrecognizable subsystems; the prior keeps names attachable.

**Consensus + persistence.** Run the ensemble across a Louvain-resolution sweep (the entropy-as-a-dial pattern applied to partitioning). Symbol pairs that co-cluster across most of the sweep are *persistently* co-subsystem; boundaries that hold across the sweep are robust. Emit the partition at a default resolution **plus** per-pair persistence metadata so callers can re-cut. Boundary symbols (assignment flips across the sweep, or high-betweenness/articulation nodes) are flagged `boundary_confidence < 1` — a re-implementer must know which assignments were judgment calls.

**Granularity target.** Subsystems should land at roughly "a team would own this" scale — for a 5k-symbol project, ~5–20 subsystems, not 200. Resolution default is tuned to that and recorded in config; it is a dial, not a truth.

### 2.2 Phase 2c upgrade path

When functor discovery ships its **endofunctor mode** (MetaCoding-4ty), internal functor edges (subsystem X maps onto subsystem Y within the same repo — parallel modules, twice-instantiated patterns) join the partition meta-graph: two regions connected by a high-fidelity internal functor are *the same schema instantiated twice* and should become **one schema with two instances** in the deck, not two near-duplicate cards. This is the single-repo analogue of at0's functor-guided community detection, and the first concrete consumer of 4ty.

### 2.3 The zero-profile floor at partition time

22.7% of symbols carry no typed-edge signal at any profile depth ([`2hop-findings.md`](../notes/functor-spike/2hop-findings.md) — the largest equivalence class *is* the structurally-isolated set). They cannot be placed by structure. Placement rule: assign by `CONTAINS`/file locality (their one reliable fact), mark `placement: "locality"`, and hand them to the NL lane (§5.4) — they still appear in cards, specced by language rather than structure. This is the honest division of labor the floor forces.

### 2.4 Artifacts

`subsystems.parquet` — one row per `(run_config, subsystem_id)`: `subsystem_id` (blake3 of repo + config + member digest), `repo`, `n_members`, `resolution`, `persistence_score`, `config`, `generated_at`, `schema_version`.

`subsystem_members.parquet` — one row per `(subsystem_id, symbol_id)`: `symbol_id`, `qualified_name`, `boundary_confidence` ∈ [0,1], `placement` (`"structural" | "locality"`), `schema_version`.

---

## 3. Stage B — Boundary and interface extraction

A subsystem's **interface contract is not written down anywhere — it is the set of morphisms crossing its boundary.** For subsystem `S` with complement `S̄`:

- **Provides** (the API surface): generating morphisms `x → s` with `x ∈ S̄`, `s ∈ S`. Group by target: each externally-referenced symbol `s` is an *export*, with the crossing edge kinds as its usage modes (`CALLS` in = invoked; `IMPLEMENTS` in = implemented externally, i.e. `s` is an extension point; `TYPE_OF`/`RETURNS_TYPE` in = used as a type; `IMPORTS` in = module-level dependency).
- **Consumes** (the dependency surface): morphisms `s → y` with `y ∈ S̄`. Group by target symbol and by *target subsystem* (or external package) — this yields the subsystem-level topology: the deck's dependency graph is the quotient of `C`'s edges by the partition.
- **Data shapes**: the type vocabulary crossing the boundary, recovered from the data-flavored edge kinds. For every type `T` referenced by a crossing `TYPE_OF` / `RETURNS_TYPE` / `CONSTRUCTS` edge, collect its field structure via `READS_FIELD` / `WRITES_FIELD` / `TYPE_OF`-on-fields edges (the MetaCoding-e54/3s5/9le alphabet — this is what those edges were built for). Distinguish **boundary shapes** (cross the interface; the port *must* reproduce them semantically) from **internal shapes** (private; the port may restructure them — recorded, tagged accidental-unless-persistent). Record per-field read/write direction: a field only ever written by `S` and read by `S̄` is an output contract, and vice versa.

⚠ **Reality check on the data alphabet.** `READS_FIELD` arrived via SCIP (e54, partial) and tree-sitter (9le); `WRITES_FIELD`/`CONSTRUCTS`/`RETURNS_TYPE` via tree-sitter (3s5); coverage is per-lane and per-language uneven (the entropy history: 2.55 → 3.65 bits pre-scip, 4.845 with `--scip`). Data-shape extraction inherits that unevenness: cards must carry an `alphabet_coverage` note per repo lane so a thin shapes section reads as "extractor gap," not "this subsystem has no data model." Everything in this stage gates on `--scip`-indexed repos, same as Phase 2b.

**Artifacts.** `interfaces.parquet` — one row per crossing morphism: `subsystem_id`, `direction` (`"provides" | "consumes"`), `internal_symbol_id`, `external_symbol_id`, `external_subsystem_id` (nullable — null = external package), `edge_kind`, `edge_count`, `schema_version`. `data_shapes.parquet` — one row per `(subsystem_id, type_symbol_id, field)`: `boundary` (bool), `field_name`, `field_type`, `read_by_internal/external`, `written_by_internal/external` (bools), `constructed_by` (list), `schema_version`.

---

## 4. Stage C — Per-subsystem presentation (the schema)

For each subsystem, three structural sections, in increasing compositional depth:

### 4.1 Role inventory (generators)

Quotient the members by hom-profile equivalence — **depth 1 by default** (per MetaCoding-4ty: depth 1 surfaces roles, you *want* the orbits; depth 2 splits them for 1:1 matching, wrong dial here). Exact-profile orbits give the conservative quotient; similarity clustering (cosine over the max-precision `hom_profiles.parquet` vectors, discretization at query time per the artifact contract) at a swept granularity gives the working one, with persistence metadata as always. Each role class records: member list, hom-profile centroid + the raw exemplar profile, cardinality, and its **interface participation** (does this role appear in provides/consumes edges?) — the re-implementer's first question about any role is whether it's public.

The role inventory is where "one class per role" dies properly: a re-implementer doesn't need the 14 concrete validators; they need the *Validator* role (profile: implements X, called by Y, constructs Z), its cardinality, and one exemplar.

### 4.2 Recurring internal structure (motifs)

`ctkr.motif_search` restricted to instances anchored inside the subsystem (join `motif_instances.parquet` against `subsystem_members.parquet`). Motifs are the mid-scale idiom layer between single roles and whole-subsystem topology — "this subsystem contains 9 instances of the register-then-dispatch motif." Already computable today with a filter; no new mining.

### 4.3 Composition laws (relations) — the Phase 2d slot

**This is what a re-implementer most needs and most lacks: not the pieces, but the algebra of how pieces combine.** Phase 2d's operad recovery ([`ct-pipeline.md` §2d](./ct-pipeline.md#2d--operad-recovery-composition-algebra)), scoped single-repo and per-subsystem, produces it. Concretely, for subsystem `S`:

1. Enumerate typed call paths (length ≥ 2) within `S`, **projected onto role classes** — the path `parseConfig → validateSchema → applyDefaults` becomes the role-path `Loader ∘ Validator ∘ Defaulter`.
2. Recurring role-paths with support ≥ k become **operations**: `{operation_id, arity, input_roles, output_role, edge_kinds, support, exemplar_paths}`. Multi-fan-in points (a role invoked with results of n other roles) yield the n-ary operations — the wiring-diagram reading (Fong & Spivak ch. 6).
3. Check the laws empirically: where composites of operations are themselves observed operations, record associativity; where a role acts as identity-like glue, record units; record violations as `non_operadic` rows rather than discarding.
4. Boundary operations get special standing: operations whose input or output roles participate in the interface are the subsystem's **protocol** — the order-of-operations contract external callers depend on (init-before-use, acquire-then-release, register-then-run). These are the composition laws a port breaks first and silently.

**What the artifact concretely gives the re-implementer:** "In this subsystem, `Orchestrator` composes 1..n `Worker`s through `Queue` (arity n, support 122); `Worker` never calls `Orchestrator` back except through `Callback` (the observed non-law); every externally-triggered path enters through `Handler` and exits through `Serializer`." That paragraph — machine-derived, evidence-linked — is the framework algebra recovered from behavior, per the ct-pipeline promise.

`operads.parquet` per ct-pipeline §2d, extended with `subsystem_id` and `is_boundary_op` columns (**new decision, flagged**: Phase 2d's artifact gains subsystem scoping; the corpus-wide colimit-scoped variant remains the other consumer).

### 4.4 Topological signature

Per-subsystem persistence diagram (H₀ trivially 1 component; H₁ = feedback/dispatch cycle structure — the part of "shape" that survives any port). Requires running the existing `ctkr shape` machinery on the subsystem-induced subgraph rather than the whole repo — an extension, not new math (§7 T7, stretch). Until then the card carries cheap invariants: size, internal edge-kind histogram, diameter, cycle count, interface in/out degree.

---

## 5. Stage D — The natural-language / intent layer

### 5.1 The layering principle

The user's key guidance, adopted as the design rule:

> **Identifiers, comments, docstrings, and naming carry the true intent of the code. They are essential to the spec — and they are not part of the categorical analysis.**

So: two lanes, kept strictly separate through analysis, fused only in the card.

- **Structural lane (name-blind).** Partition, interfaces, roles, motifs, operad — computed exclusively from typed edges. No token of source text influences any boundary, membership, or law. This is what keeps the CT layer rigorous, keeps the eval story honest (rename-fork controls stay meaningful), and is the established structure-first-meaning-second pattern (`ctkr/label_motifs.py`, `label_roles.py`, `llm.py`).
- **NL lane (name-full).** For each structural element the structural lane has *already fixed*, assemble an evidence pack — member identifiers and qualified names, docstrings/comments harvested via tree-sitter, FTS hits over the member set, exemplar code slices, adjacent README/doc fragments — and run the L3 labeler to produce label + intent description + supporting evidence quotes.

Structure decides **what to read and what the units are**; language decides **what it means and what to call it**. The inversion of the usual flow, per ctkr.md Layer 3, now applied to whole subsystems.

### 5.2 What the NL lane labels

Every structural element type gets a labeling pass (new `source_kind` values in `patterns.jsonl` per the Phase 3 convention): `"subsystem"` (name + one-paragraph intent + responsibilities list), `"role-class"` (name + what the role does + why it exists), `"operad-op"` (what this composition accomplishes; protocol ops get "callers must…" phrasing), `"interface-export"` (contract semantics of each provided symbol), `"data-shape"` (meaning of the type and its fields). All rows carry the mandatory `llm_model`/`llm_temperature`/`prompt_version` provenance per [`ctkr-l3-artifacts.md`](./ctkr-l3-artifacts.md).

### 5.3 When names and structure disagree

They will. Trust policy, explicit:

- **Structure owns identity and extent.** The LLM may not move a symbol between subsystems, merge role classes, or invent interface members, however loudly the names suggest it. Names never renegotiate the partition — that would silently re-import the name-bias the whole CT lane exists to escape.
- **Names own intent.** A structurally-clean role class whose members are named inconsistently still gets its intent from the names/comments — that's where intent lives; structure has no opinion about purpose.
- **Disagreement is a first-class output, not an error.** When the labeler reports low confidence, or members' names suggest different purposes than their shared structure, or a name-derived grouping cuts across a structural boundary, the card records `intent_dissonance: {kind, evidence}`. Dissonance is often the highest-value finding in the deck: a misleadingly-named module, a "Validator" that also writes state, a subsystem whose declared purpose has drifted from its behavior. **For the port, dissonant elements are exactly where the re-implementer must read the exemplar slices rather than trust either the name or our label.** Precedent: the pre-conceptual findings (MetaCoding-5wi) — where language genuinely fails, present evidence and `labeling_pressure`, don't force a name.

### 5.4 Covering the structural floor

The 22.7% zero-profile symbols (§2.3) are specced **entirely by the NL lane**: locality-assigned to a subsystem, sliced via tree-sitter, described from names/comments/content. Their card entries carry `spec_basis: "nl-only"` so the reader knows the categorical machinery never saw them. Constants files, config schemas, string tables, standalone scripts — often *load-bearing for a port* despite being structurally invisible. A spec pipeline that dropped them would fail its one job; this is the concrete reason the NL lane is a peer lane, not garnish.

---

## 6. Cross-language invariance — what survives the port

The crux of "completely different stack": partition every card field into what the port must preserve, what must be normalized before comparison, and what should be shed.

### 6.1 Invariance tiers

Every card field carries a tier tag:

| Tier | Meaning | Fields |
|---|---|---|
| **I — invariant** | Port must preserve; port-verifier checks it | role classes + cardinalities, composition laws over roles (the operad), boundary data shapes (field-level semantics), interface contract (provides/consumes at role level), subsystem dependency topology, H₁-class cycle structure |
| **N — normalize** | Real signal, but language-biased; compare through the normalization layer only | hom-profile vectors (edge-kind-mix bias, §6.2), edge-kind histograms, motif frequencies, role-class *granularity* (duck-typed languages merge roles that nominal type systems split — compare under a coarser dial) |
| **A — accidental** | Instance-specific; drop from the spec (retained in provenance) | symbol names & file layout (`CONTAINS` scaffolding), framework boilerplate roles, language idioms (getters/setters, dunders, interface-vs-duck-typing shims, decorators-vs-annotations), internal (non-boundary) data-shape layout, edge multiplicities (`Edge.count` — already ignored by the functor lane) |

Tier assignment is mechanical where possible (a lookup: `CONTAINS` → A; boundary shape → I) and **L3-assisted** where judgment is required (framework-boilerplate detection: roles whose profile is dominated by low-discriminativeness kinds *and* whose members match known-framework import provenance get proposed as A, human-reviewable). Per §1.2(c), tier tags are *corrected* from port evidence when a second instance exists.

### 6.2 The normalization layer, concretely

The known bias ([`ct-functor-discovery.md` §7.2](./ct-functor-discovery.md#72-cross-language-correspondence-tspython)): extractor lanes emit systematically different edge-kind mixes per language (`TYPE_OF`/`RETURNS_TYPE` density in TS vs Python; `IMPLEMENTS` scarcity in duck-typed code). Normalizations, all **query/compare-time** (the artifacts stay maximal-precision, per the established contract):

1. **Per-language edge-alphabet reweighting** — divide each profile dimension by its corpus-language marginal frequency before cross-language cosine (the §7.2 candidate fix, adopted here as the default for any cross-language comparison).
2. **Kind collapsing map** — a small explicit table folding near-synonymous kinds for cross-language comparison: `{IMPLEMENTS, EXTENDS, OVERRIDES} → subtypes`, `{TYPE_OF, RETURNS_TYPE} → typed-as`, `{ANNOTATES} → decorates-family`. Applied as a coarser profile dial, not a rewrite.
3. **Idiom shims** — per-language symbol-level folds before role quotienting of the *port* side: property getter/setter pairs fold into their field; dunder protocol methods fold into their class role; interface-only declaration files (TS `.d.ts`-style) fold into their implementations. A short, explicit, per-language list — maintained as data (`normalization.json`, versioned), not code, so adding a target language is a table edit.
4. **Boilerplate exclusion** — kind-discriminativeness weights (already mandated for 2b propagation) applied when scoring cross-language role similarity, so `CONTAINS` scaffolding and generated-client noise don't dominate exactly as they don't in functor search.

**Honest status:** §7.2 marks the cross-language bias *suspected, not yet measured* — the v1 eval runs one TS↔Python pair ungated. This pipeline inherits that: normalization ships as designed above, but its parameters get pinned by that experiment, and the first real port (§7 T6) is the true test of the Yoneda cross-language hypothesis the VISION names as an open horizon. We are building the instrument that answers it.

---

## 7. The verification loop — functor discovery as port-verifier

The just-built functor track is not adjacent to this pipeline; it is its **acceptance test**.

**Protocol.** After re-implementing subsystem `S` as `S'` in the new stack:

1. Index the new project with `--scip`; run `ctkr hom-profiles --depth 2` (depth 2 is the 1:1-correspondence dial — here we *want* orbits split, per MetaCoding-4ty).
2. Run functor discovery `S → S'` and `S' → S` restricted to the two member sets, with the §6.2 cross-language normalization applied at seed time.
3. Gates, in decreasing strictness:
   - **Role coverage** — every tier-I role class of `S` has ≥ 1 member mapped into `S'` (checked at role level, not symbol level: the port is *allowed* to change cardinalities and merge helpers; it is not allowed to lose a role).
   - **Interface preservation** — every `provides` morphism of `S` has an image: the export exists and is used in the same modes.
   - **Composition preservation** — every tier-I operad operation's role-path is realizable in `S'` (its image role-path occurs); protocol ops checked strictly.
   - **Fidelity + cycle consistency** — functor `fidelity` over mapped pairs ≥ threshold (start 0.8 — cross-language ports are approximate functors by nature; per ebg the number is a dial and the report shows the distribution), and `cycle_consistency(G∘F)` high enough to rule out a displaced match.
4. Failures are *localized*: an unmapped role, a missing witness edge, a broken protocol op each point at a specific card section and specific exemplar slices. The verifier's output is a punch list, not a boolean.

**Dependencies, honestly:** `functor_between` today assumes two distinct repos in one corpus index. The port lives in a different repo (fine — index both into one data dir) but **member-set-restricted search and the endofunctor/diagonal machinery are MetaCoding-4ty**, which is open. The subsystem restriction is a small extension of the runner (accept an object-set filter per side — the blocking and propagation code is unchanged). Verifier thresholds get calibrated on the rename-fork "port" (a fork is a perfect port; gates must pass at ~ceiling) before any real port is scored.

**Scope honesty.** The verifier checks that the port preserves the extracted *shape and contract*. It does not check behavior — algorithmic content inside a role (the actual parsing logic inside `Parser`) is opaque to every name-blind structural method and is carried by exemplar slices + intent text only. **The spec deck complements the original test suite; it does not replace it.** A port should pass both.

**Status — T6 shipped (2026-07-14).** The port verifier is `src/ctkr/verifyPort.ts` (`verifyPort()` pure core + `formatReport()`), composing the member-set-restricted `functorSearch` (MetaCoding-4ty) both directions with the §6.2 normalization (`src/ctkr/normalization.json`, versioned) applied at seed time — kind-collapse folds `{IMPLEMENTS,EXTENDS,OVERRIDES}→SUBTYPES` / `{TYPE_OF,RETURNS_TYPE}→TYPED_AS`, per-side inverse-marginal reweight de-biases language-dense edge kinds, and idiom shims fold accessors/dunders into their `CONTAINS` parent. The output is the punch list, not a boolean: every failure names a card section (`roles[role_id=…]` / `interface.provides[symbol=…]` / `composition_rules[operation_id=…]`) and carries exemplar slices; protocol (boundary) ops are checked strictly. **Acceptance met:** the rename-fork "port" lands every gate at ceiling (role coverage 1.0, interface preservation 1.0, composition 1.0, fidelity ≥ 0.95, cycle ≥ 0.9) with an empty punch list; a degree-rewired fork drops the gates and localizes the failures (`src/ctkr/verifyPort.test.ts`, 9 tests). The ungated §6 cross-language experiment (`eval/ctkr/port_verify_experiment.ts`, TS `src/ctkr` spec vs Python `ctkr` port on the MetaCoding self-index, endofunctor member-restriction) recorded the normalization ON/OFF delta: role coverage +5.9 pts, interface preservation +1.5 pts, composition preservation +10.3 pts, fidelity −4.6 pts, cycle consistency −6.0 pts — normalization lifts the tier-I *structural* gates (roles, composition) at a small cost to the raw edge-count metrics, exactly the tier-I-vs-tier-N trade the §6.1 tiers predict. `verify_port` ships as the recipe (§8.2 (c)), promotable to an MCP tool once the punch-list format is exercised on a real port.

---

## 8. The output — specification cards and the deck

### 8.1 Card schema

One card per subsystem; the deck (all cards + the subsystem dependency graph + repo-level preamble) is the re-implementation reference. JSONL per L3 conventions (human-read, append-friendly, git-diffable), backed by the structural Parquet artifacts it joins against.

```jsonc
// subsystem_cards.jsonl — one row per (subsystem_id, prompt_version)
{
  "card_id": "…",                     // blake3(subsystem_id, structural digests, prompt_version, llm_model)
  "subsystem_id": "…",                // FK → subsystems.parquet
  "repo": "…",
  "name": "…",                        // L3 label
  "intent": "…",                      // L3 paragraph: purpose, responsibilities, non-goals
  "spec_basis_summary": {"structural": 0.77, "nl_only": 0.23},   // the honest floor, on every card

  "roles": [{
    "role_id": "…", "label": "…", "description": "…",           // L3
    "cardinality": 14, "members": ["…"],                          // structural
    "profile_centroid_ref": "…", "profile_depth": 1, "granularity": "…",
    "interface_participation": ["provides"], "invariance_tier": "I",
    "exemplar_symbol": "…", "intent_dissonance": null             // or {kind, evidence}
  }],

  "composition_rules": [{
    "operation_id": "…", "label": "…", "description": "…",       // L3
    "arity": 2, "input_roles": ["…"], "output_role": "…",
    "edge_kinds": ["CALLS"], "support": 122, "is_boundary_op": true,
    "law_notes": {"associative_observed": true, "violations": 3},
    "exemplar_paths": ["…"], "invariance_tier": "I"
  }],

  "interface": {
    "provides": [{ "symbol": "…", "role_id": "…", "usage_modes": ["CALLS","IMPLEMENTS"],
                   "contract": "…" /* L3 */, "n_external_callers": 12 }],
    "consumes": [{ "target": "…", "target_subsystem": "…" /* or external package */,
                   "edge_kinds": ["CALLS"], "purpose": "…" /* L3 */ }]
  },

  "data_shapes": [{
    "type": "…", "boundary": true, "meaning": "…",                // L3
    "fields": [{"name": "…", "type": "…", "flow": "in|out|internal"}],
    "invariance_tier": "I", "alphabet_coverage_note": "…"
  }],

  "topology": { "n_members": 214, "internal_edge_histogram": {"CALLS": 512, "…": 0},
                "h1_summary": null /* until T7 */, "cycles": 4,
                "interface_degree": {"in": 31, "out": 18} },

  "exemplar_slices": [{ "purpose": "role:Parser exemplar", "file": "…",
                        "line_start": 10, "line_end": 62, "code": "…" }],

  "provenance": { "generated_at": "…", "schema_version": 1,
                  "partition_config": {...}, "llm_model": "…", "llm_temperature": 0.0,
                  "prompt_version": "…", "hom_profiles_generated_at": "…",
                  "indexed_with_scip": true }
}
```

Structural backing artifacts (Parquet, per [`ctkr-artifacts.md`](./ctkr-artifacts.md) conventions — `schema_version` per row, pydantic-canonical in `ctkr/schema.py`, codegen'd TS mirrors, manifest presence booleans): `subsystems.parquet`, `subsystem_members.parquet` (§2.4), `interfaces.parquet`, `data_shapes.parquet` (§3), per-subsystem role rows in `presentations.parquet`, scoped `operads.parquet` (§4). Cards are **derived** — regenerable from the Parquet + a labeler run; the Parquet is the ground truth, the JSONL is the human/port-facing fusion.

### 8.2 MCP surface

Read-side discipline as everywhere (tools read artifacts; extraction is a batch runner):

- `ctkr.subsystems(repo, resolution?, min_persistence?)` — the partition with boundary-confidence metadata.
- `ctkr.subsystem_card(repo, subsystem, sections?)` — one card, optionally section-filtered (cards are large; agents usually want one section).
- `ctkr.interface_of(repo, subsystem, direction?)` — the raw contract rows, for programmatic consumers.
- `ctkr.extract_spec` is **not** an MCP tool — it's the batch runner (`ctkr extract-spec` CLI orchestrating Stages A–E), same split as functor discovery's runner-vs-tool.
- Port verification reuses `ctkr.functor_between` plus a thin `ctkr.verify_port(repo_a, subsystem, repo_b, subsystem_b?)` wrapper emitting the §7 punch list. (**Resolved (T6, 2026-07-14):** shipped as the **recipe** — `verifyPort()` in `src/ctkr/verifyPort.ts` (pure core) + `eval/ctkr/port_verify_experiment.ts` (the artifact-reading recipe over `hom_profiles`/`subsystem_members`/`presentations`/`interfaces`/`operads` + the export JSONL). Promote to an MCP tool once the punch-list format is exercised on a genuine port; the format is stable but unproven on a real re-implementation.)

---

## 9. Build plan

Ordered, independently shippable. T1–T3 and T5 need nothing from the deferred 2c/2d beads and are buildable now against shipped primitives; T4 instantiates Phase 2d (design-first, per its roadmap note); T6 rides Phase 2b + MetaCoding-4ty. Everything gates on `--scip`-indexed repos (the 2b lesson: the alphabet is the floor under every downstream number).

| # | Task | Deliverable | Depends on | Acceptance criteria |
|---|---|---|---|---|
| **T1** | Subsystem partition runner | `ctkr subsystems` (Python — Louvain/graph tooling lives there): consensus partition + resolution sweep + persistence metadata → `subsystems.parquet`, `subsystem_members.parquet`; articulation-point column added to `centrality.parquet` (closing the §2.1 gap); `ctkr.subsystems` MCP tool | shipped L1 | On MetaCoding self-index: partition at default resolution recovers the known seams (src/ vs ctkr/ vs eval/ vs mcp/ — directory-truth ARI ≥ 0.6 as a sanity floor, with disagreements *listed and reviewed*, not auto-failed); ≥ 80% of symbols persistently assigned across the sweep; zero-profile symbols 100% locality-placed and flagged; deterministic re-run byte-identical |
| **T2** | Interface + data-shape extraction | Boundary-morphism and type-closure extraction → `interfaces.parquet`, `data_shapes.parquet`; `ctkr.interface_of` tool | T1 | For `src/ctkr/` as ground truth: extracted provides-set matches the hand-listed exported surface (precision ≥ 0.9, recall ≥ 0.9); boundary vs internal shape split spot-checked; `alphabet_coverage` note emitted per lane |
| **T3** | Role inventory (intra-subsystem quotient) | Depth-1 profile clustering scoped per subsystem, granularity sweep + persistence → role rows in `presentations.parquet` | T1 | On the 9-cluster/48-member ground truth restricted to within-repo pairs: same-role pairs co-class at ≥ the Phase 2a eval baseline; role count ≪ member count (compression ratio reported); every role has an exemplar; orbit-exact vs similarity-cluster both emitted |
| **T4** | Scoped operad recovery (Phase 2d instantiation) | Role-path mining + law checking per §4.3 → `operads.parquet` (+`subsystem_id`, `is_boundary_op`); `ctkr.composition_rules` scoped variant | T3 | On a hand-analyzed fixture (small repo with a written-down composition grammar): recovered ops cover the grammar (recall ≥ 0.8) with support-ranked precision spot-check; associativity/violation bookkeeping demonstrated; boundary ops correctly flagged against T2 interfaces |
| **T5** | NL lane + card assembly | L3 labeler extensions (`source_kind`: subsystem / role-class / operad-op / interface-export / data-shape), evidence-pack assembler (tree-sitter slices + FTS + docstrings), `intent_dissonance` detection, card fuser → `subsystem_cards.jsonl`; `ctkr.subsystem_card` tool; `ctkr extract-spec` orchestrator CLI | T1–T3 (T4 section optional-empty) | Full deck generated for MetaCoding self-index; human review of ≥ 3 cards: intent paragraphs judged accurate, dissonance flags spot-checked (≥ 1 genuine finding or a reviewed empty set); every nl-only symbol appears in exactly one card; provenance fields complete; re-run with same inputs+prompt_version → identical `card_id`s |
| **T6 ✅** | Port-verifier wiring | **SHIPPED** — `src/ctkr/verifyPort.ts` (member-set-restricted `functorSearch` both directions via MetaCoding-4ty), `src/ctkr/normalization.json` (versioned §6.2: kind-collapse + inverse-marginal reweight + idiom shims, at seed time), punch-list emitter (localized to card sections + exemplar slices, protocol ops strict); `eval/ctkr/port_verify_experiment.ts` recipe | 2b Tasks 1–3, 4ty | ✅ Rename-fork "port": all §7 gates at ceiling (role 1.0, interface 1.0, composition 1.0, fidelity ≥ 0.95, cycle ≥ 0.9), empty punch list; rewired-fork negative control drops gates + localizes failures (`verifyPort.test.ts`, 9 pass). ✅ Real TS↔Python pair (§6.3): normalization on/off delta recorded (role +5.9, iface +1.5, composition +10.3, fidelity −4.6, cycle −6.0 pts) — ungated |
| **T7** | *(stretch)* Per-subsystem topology | `ctkr shape --subsystem` on induced subgraphs → per-subsystem PD rows; card `topology.h1_summary` populated | T1 | PD computed per subsystem; H₁ summaries stable under the partition-resolution sweep for persistent subsystems |

**Sequencing note.** T1+T2+T5 alone already produce a *useful* deck (subsystems, interfaces, data shapes, intent, exemplars — no roles/operad sections); that is the minimum lovable spec and the recommended first milestone. T3 upgrades it to schema-grade; T4 adds the composition algebra; T6 closes the loop.

---

## 10. Honest limits & open questions

- **The 22.7% structural-isolation floor.** ~1 in 4–5 symbols carries zero structural signal at any profile depth. The NL lane covers them by design (§5.4), and `spec_basis_summary` on every card keeps the ratio visible — but for those symbols the "spec" is an LLM reading of source text, with exactly the trust profile that implies. Richer edges (MetaCoding-ijo and successors) lower the floor; nothing eliminates it.
- **Behavioral semantics are out of scope.** Roles, laws, contracts, shapes, topology — yes. The algorithm inside a role — no. Exemplar slices and the original test suite carry that. A deck consumer who skips the slices will build a structurally perfect, behaviorally hollow port.
- **N=1 essence/accident ambiguity** (§1.2). The invariance tiers are a normalization layer plus judgment, not a theorem, until the port supplies a second instance. State it on the deck preamble.
- **Operad claims are empirical** — support-weighted observations of composition, with recorded law violations. Useful precisely because frameworks' documented algebra and exhibited algebra diverge; never oversell as axioms.
- **Cross-language normalization — first measurement in (T6, 2026-07-14).** The §6.2 layer is now built and run once (TS `src/ctkr` vs Python `ctkr`, self-index): normalization ON lifts the tier-I structural gates (role coverage +5.9 pts, composition +10.3 pts) and dips the raw metrics (fidelity −4.6, cycle −6.0 pts) — a real, ungated signal, not a proof. Parameters still want the 2b §7.2 pair and a genuine port to pin. The Yoneda cross-language hypothesis remains the open horizon VISION says it is; this pipeline is now a *working* instrument, still not the answer.
- **Assumed-primitive deltas from reality** (flagged per review): cut vertices are vision-not-shipped (T1 closes); depth-2 profiles are the Python `ctkr hom-profiles --depth 2` opt-in (commit 611ae33) — the TS `src/ctkr/homProfile.ts` similarity path is depth-1-shaped and T6's seeding must read the depth-2 artifact, not recompute; `shape_pds` is per-repo only (T7); `ctkr.role_equivalent` is shipped in `ctkr-tools.ts` though the roadmap table still shows it blocked (roadmap needs a status pass); Phase 2c/2d/`functor_between` runner beads remain deferred/open as per the roadmap.
- **Open decisions (new, not relitigating anything):** (a) generalize the 2c community-detection engine to pluggable edge sources (§1.3) — recommended; (b) `operads.parquet` gains `subsystem_id`/`is_boundary_op` (§4.3); (c) `verify_port` as tool vs. recipe (§8.2) — start recipe; (d) whether endofunctor-detected duplicate subsystems collapse to one card with two instances (§2.2) — recommended yes, decide at T1 contact.
