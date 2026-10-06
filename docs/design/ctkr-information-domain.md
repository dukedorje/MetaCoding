# CTKR-I — the information domain

> **Research/design vocabulary, not a shipped guarantee.** This document retains
> historical categorical terminology. Current implementations and preferred names
> are defined in [Structural analysis: names and guarantees](structural-analysis-terminology.md).
> Profiles are lossy signatures, mappings are approximate structural alignments,
> and mined paths are composition patterns—not verified categorical laws.
> Category-theory extensions are an [optional research track](category-theory-research.md),
> after repeated useful graph/search workflows, not a prerequisite for them.

> **Companion docs.** This extends [`ctkr.md`](./ctkr.md) (theoretics) and
> [`ct-pipeline.md`](./ct-pipeline.md) (the phase ladder) to a second
> corpus domain: a personal / organizational knowledge archive. The
> functor-search formalization it leans on is
> [`ct-functor-discovery.md`](./ct-functor-discovery.md); artifact shapes
> follow [`ctkr-artifacts.md`](./ctkr-artifacts.md) and
> [`ctkr-l3-artifacts.md`](./ctkr-l3-artifacts.md).

The epistemology charter names the method's second target explicitly:
*"messy corporate memory — meeting notes, emails, transcriptions."* This
document specifies what CTKR needs — and, more importantly, what it does
*not* need — to run over an information corpus instead of a code corpus:
pages, chunks, entities (people / orgs / projects / events), typed links
(`works_at`, `attended`, `mentions`), tags, timestamps. The working
instance is a GBrain-style brain, but nothing below depends on GBrain
specifics beyond its ability to export a typed graph as JSONL.

The design constraint, held throughout: **the L1–L3 algorithms do not
change.** The port is a schema-adapter problem. Everything domain-specific
becomes data in the export manifest.

## The corpus as a category, re-read

Same construction as [`ctkr.md`](./ctkr.md) — the free category on a
typed multigraph — with the alphabet swapped.

**Objects.** One polymorphic node table, `Item`, `kind`-discriminated
(mirrors `Symbol.kind` — avoids per-entity-type label explosion):

| kind | code analogue | examples |
|---|---|---|
| `page` | file / module | note, memo, meeting note, journal entry |
| `chunk` | function / method | retrieval unit within a page |
| `entity.person` / `entity.org` / `entity.project` | class | people, companies, ventures |
| `entity.event` / `entity.place` | — | gatherings, trips; locations |
| `concept` | interface / type_alias | topics, ideas |
| `tag` | annotation | frontmatter / inline tags |
| `source` | *repo* | a synced source: wiki, inbox, CRM, mail |
| `attachment` | file | stored binary |

`source` is the corpus partition key — everywhere the code pipeline says
`repo`, the information pipeline says `source`. A second partition,
**era** (time window), has no code analogue and is discussed under
[Temporal structure](#temporal-structure).

**Generating morphisms.**

| edge kind | from → to | code analogue | counted |
|---|---|---|---|
| `MENTIONS` | page/chunk → entity/concept | CALLS | yes |
| `LINKS_TO` | page → page | REFERENCES / IMPORTS | yes |
| `CONTAINS` | source → page → chunk | CONTAINS | no |
| `TAGGED` | page → tag | ANNOTATES | no |
| `ABOUT` | page → concept | TYPE_OF | no |
| `DERIVED_FROM` | page → page | OVERRIDES | no |
| `WORKS_AT` | person → org | IMPLEMENTS | no |
| `MEMBER_OF` / `PART_OF` | person → project / project → org | EXTENDS | no |
| `ATTENDED` | person → event | — | no |
| `KNOWS` / `INTRODUCED_BY` | person → person | — | no |
| `FOUNDED` / `INVESTED_IN` / `ADVISES` | person/org → org/project | — | no |
| `LOCATED_IN` | event/org → place | — | no |
| `FOLLOWS` | page/event → page/event | — | no |
| `SAME_AS` | entity → entity | — | derived |

Held lightly, per the schema doc's own convention: the list grows the
same way the code schema grew `READS_FIELD` / `WRITES_FIELD` — when the
typed-edge entropy is too low for hom-profiles to discriminate roles,
split the coarse kind (`MENTIONS` → `QUOTES` / `DISCUSSES` /
`NAME_DROPS`). Entropy-as-dial
([`../notes/entropy-as-dial.md`](../notes/entropy-as-dial.md)) applies
unchanged.

**Composition.** Path concatenation in the free category, as always.
The domain adds a composition-typing table — which composites carry
meaning and may be materialized as derived edges (with provenance, the
same pattern as Joern's `FLOWS_TO` write-back):

```
MENTIONS ∘ WORKS_AT    → ASSOCIATED_WITH   (page → org, via employee)
MENTIONS ∘ MEMBER_OF   → ASSOCIATED_WITH   (page → project, via member)
CONTAINS ∘ CONTAINS    → CONTAINS          (transitive)
TAGGED   ∘ CONTAINS⁻¹  → tag inheritance   (chunk inherits page tags)
FOLLOWS  ∘ FOLLOWS     → FOLLOWS-path      (timeline)
```

One structural difference from code deserves flagging: the dominant
relation-former in an archive is the **span**, not the chain —
`person —ATTENDED→ event ←ATTENDED— person` (co-attendance),
co-mention, co-tagging. A code graph is mostly composable chains; an
information graph is mostly pullback-shaped meets. Motif mining already
handles this (it mines shapes, not paths), but any path-only analysis
(operad recovery over call paths) must be extended with span
enumeration in this domain.

### Temporal structure

Information edges carry time in a way code edges (pre-git-history) do
not: validity intervals (`WORKS_AT` 2019–2022) and event timestamps. Two
v1-mandatory consequences:

- Edges carry optional `valid_from` / `valid_to` / `ts` attributes, and
  the exporter/loader must pass them through.
- A composite is *temporally valid* only when its constituents' intervals
  intersect (`MET_AT(e) ∘ WORKS_AT` implies an org association only if
  the event falls inside the employment window). v1 records the
  attributes and applies the guard in derived-edge materialization only;
  interval-aware functor search is deferred (see open questions).

This makes the "time as a dimension" open question from `ctkr.md`
load-bearing here rather than deferred: era-windowed hom-profiles and
temporal PH filtrations are the information domain's equivalent of
branch-aware reads.

## What each layer yields on an information corpus

Layer 0 is whatever store the archive lives in; CTKR only sees the JSONL
export. The ladder above it is unchanged in mechanism, changed in
meaning:

| layer / tool | on code | on an archive |
|---|---|---|
| L1 motif mining | design patterns | recurring situation-shapes: "external meeting", "project genesis", "introduction" — emergent page genres and relationship shapes, cross-source coverage instead of cross-repo |
| L1 embeddings (+ name bridges) | cross-repo role analogy | cross-domain neighbors: entities/pages that *sit* alike; bridges are shared entities — people and orgs are the natural inter-source bridges |
| L1 persistent homology | subsystem/loop shape signature per repo | life-domain merge structure (H₀), social circles that close (H₁), per-era shape signatures; PD distance clusters *periods of a life* |
| L1 centrality / Louvain | emergent modules, cut vertices = seams | emergent life domains vs declared folders; cut vertices = broker entities bridging domains — where serendipity lives |
| 2a hom-profiles (Yoneda) | name-free "same role" symbols | an entity *is* its relationship pattern: mentors across domains, service-provider roles, role *drift* across era windows, `SAME_AS` coreference candidates |
| 2b functor discovery | cross-repo structural maps | cross-era / cross-project analogy: "Startup B is re-running Startup A's structure; fidelity breaks exactly here" |
| 2c colimit | shared ontology of 59 frameworks | the minimal ontology all sources instantiate — role classes (⟨Person⟩, ⟨Gathering⟩, ⟨Commitment⟩, ⟨Artifact⟩) emerge with support counts; ontology maintenance dissolves into recomputation |
| 2d operads | composition algebra of a framework | the empirical grammar of workflows (intro→meeting→follow-up→…), and its divergence from the espoused workflow |
| L3 labeling | pattern library | named genres/roles with evidence; the pre-conceptual channel (`labeling_pressure`, contrast pairs) matters *more* for personal material |

## The discoverability inversion

Capture-time categorization freezes the ontology of the capture moment;
a link not made then is invisible to every later query phrased inside
the declared schema. Structure-first discovery computes latent relations
from global topology and materializes them back (with provenance, never
silently), so ordinary retrieval inherits the discoveries. Three
recurring maintenance jobs, all built from existing L1/L2 outputs:

1. **`motif-linker`** — link prediction by motif completion. Find
   *almost-instances*: subgraphs matching a high-support motif minus
   exactly one edge. Emit `{src, dst, proposed_kind, motif_id, support,
   exemplars}` to a `proposals.jsonl` review queue (PatternRow-style
   provenance); auto-materialize only the high-precision subset as
   `derived`-flagged low-confidence edges.
2. **`role-twin-scan`** — Yoneda drift and cross-domain analogy. Emit
   (a) role twins: hom-profile-near pairs in different communities with
   zero shared tags/links; (b) role drift: entities whose windowed
   profile changed cluster since last run; (c) `SAME_AS` merge
   candidates. Every finding ships its evidence pack.
3. **`ontology-diff`** — emergent categories vs declared taxonomy. Diff
   colimit role classes / Louvain clusters against tags, types, folders.
   Emit dead tags (members scatter structurally), unnamed categories
   (coherent clusters with no tag → L3 label or pre-conceptual
   exemplar set), and misfiled members. Output is a proposal document;
   application is human- or policy-gated.

## The domain profile — the entire adapter

Ground truth from the current code: the Python side consumes only
`nodes.jsonl + edges.jsonl + manifest.json` (written by
`metacoding export`, read by `ctkr/graph_loader.py`) into a generic
`nx.MultiDiGraph`. Domain assumptions live in five places: the
`EDGE_KINDS` tuple in `graph_loader.py`; `DEFAULT_INTERESTING_KINDS` in
`motif_mining.py`; `repo` as partition key across `shape.py`,
`centrality.py`, motif coverage, and functor endpoints; `short_name` as
the embedding bridge key in `embed.py`; and the exporter's edge-kind
lists in `src/cli/export.ts`. The target design puts all five in one manifest block (only loading and the
small-graph discovery adapter are implemented today):

```json
{
  "domain": {
    "name": "information",
    "edge_kinds": ["MENTIONS", "LINKS_TO", "CONTAINS", "TAGGED", "ABOUT",
                   "DERIVED_FROM", "WORKS_AT", "MEMBER_OF", "PART_OF",
                   "ATTENDED", "KNOWS", "INTRODUCED_BY", "FOUNDED",
                   "INVESTED_IN", "ADVISES", "LOCATED_IN", "FOLLOWS",
                   "SAME_AS"],
    "counted_edge_kinds": ["MENTIONS", "LINKS_TO"],
    "anchor_node_kinds": ["page", "entity.person", "entity.org",
                          "entity.project", "concept"],
    "partition_key": "source",
    "bridge_key": "short_name",
    "scaffold_edge_kinds": ["CONTAINS", "TAGGED"]
  }
}
```

Loaded into a `DomainProfile` dataclass; absence of the block resolves
to the current built-in code-domain constants, so existing code node and edge semantics are preserved. The target
design makes hom-profile dimensionality (`DIMS` / `DIM_IDX`), motif
edge alphabet, anchor eligibility, partitioning, bridging, and
`kind_weights` defaults (down-weight `scaffold_edge_kinds`, exactly as
`CONTAINS` is down-weighted today) derive from the profile. In that target design, every
artifact manifest records the profile, so consumers cannot silently mix
domains.

### Changes, exhaustively

| change | where | size |
|---|---|---|
| 1. `DomainProfile` from manifest, threaded to L1 miners + TS L2 | `ctkr/graph_loader.py`, `hom_profiles.py`, `motif_mining.py`, `embed.py`, `shape.py`, `centrality.py`; `src/ctkr/*.ts` | plumbing, no algorithm changes |
| 2. attribute aliasing (`partition_key → repo`, `bridge_key → short_name`) at load | `graph_loader.py` | small |
| 3. edge-attr pass-through whitelist (`valid_from`, `valid_to`, `ts`, `confidence`) | `graph_loader.py`, exporter | ~5 lines each |
| 4. information-side exporter emitting the same three files | GBrain (or converter script) — **zero MetaCoding changes** | external |

Explicitly *not* needed: no store/ingest-lane changes, no new graph
engine, no L1 algorithm changes, no L3 changes beyond new `source_kind`
strings, no MCP changes for a first run.

### Validation path

1. Build the archive→JSONL converter externally.
2. Throwaway shim run: rename information edge kinds onto the existing
   code alphabet (`MENTIONS`→`CALLS`, `LINKS_TO`→`REFERENCES`,
   `WORKS_AT`→`IMPLEMENTS`, …) and run today's CTKR **unmodified**
   end-to-end. Ugly, zero repo changes, proves or kills the signal
   hypothesis in an afternoon.
3. If signal: land changes 1–3, drop the shim, re-run under honest
   names.

The shim step is the no-oracle-fallback discipline applied to this
design itself: the domain-profile abstraction is only worth building
once a real archive has shown the miners produce non-noise.

## Honest limits & open questions

- **Sparse regime.** A personal archive is 10²–10⁵ items, orders of
  magnitude below the 300k-symbol corpus, and edge-poor until entity
  extraction has run. All support thresholds, walk lengths, and
  filtrations need re-tuning; measure typed-edge entropy first and let
  it dial the schema.
- **Extractor noise.** Code edges come from compilers; information edges
  come from NER/LLM extraction with confidence ∈ [0, 1]. Fidelity-as-
  metadata absorbs this in principle; whether functor search stays
  stable under 0.7-confidence edges is an open empirical question.
- **Span-shaped structure.** Path-based constructions (operad recovery)
  need span enumeration added; scope of that extension is unpinned.
- **Interval-guarded composition.** v1 stores temporal attrs and guards
  only derived-edge materialization. Interval-aware hom-profiles
  (windowing) are cheap; interval-aware functor search is not designed.
- **Privacy.** Evidence packs materialize snippets of personal material;
  the L3 loop needs a local-model and/or redaction mode before running
  on a real brain. Artifacts inherit the sensitivity of the source.
- **Identity.** `Item.id` should be a stable hash of
  `(source, slug-or-entity-canonical-name)`; entity canonicalization
  before hashing is the information analogue of signature normalization,
  and `SAME_AS` discovered later must merge *profiles*, not ids —
  policy unpinned.

## Status

Design landed in this repo 2026-08-19. `ctkr.graph_loader` now has
`DomainProfile` / `load_domain_profile` / `INFORMATION_DOMAIN`;
`load_graph` aliases `partition_key → repo` and `bridge_key → short_name`,
and passes through `valid_from` / `valid_to` / `ts` / `confidence`.
Absence of a `domain` block is still the code-corpus path. The graph now also
carries profile metadata; this is not a byte-identity claim.

L1 miners still import the code-domain `EDGE_KINDS` constant; threading
the profile into motif/hom-profile/embed is the next plumbing step,
after a shim-rename run against a real archive export has shown signal.


### Runnable small-graph discovery (implemented)

The broader L1–L3 adapter above remains a design, not an end-to-end shipped
pipeline. The available conservative alternative needs no embeddings, models,
network calls, edge renaming, or artifact-store writes:

```bash
cd /home/dorje/projects/MetaCoding/ctkr
.venv/bin/python -m ctkr.information_discovery \
  --data-dir /path/to/information-export --out /path/to/candidates.json --limit 20
```

Python API: `ctkr.information_discovery.discover(load_graph(export_dir), limit=20)`.
The manifest must declare `domain.name: information`. A name-only block gets
`INFORMATION_DOMAIN` defaults. Explicit empty arrays remain empty. Invalid
manifest field types fail rather than quietly selecting the code alphabet.
Custom edge kinds are preserved by the loader; the profile alphabet is metadata,
not a validation filter. Information exports must aggregate duplicate
`(src_id, dst_id, kind)` rows before loading; duplicates fail closed to avoid
input-order-dependent provenance loss. The loader preserves provenance and
`generated` / `generated_by` / `derived` flags even with a custom attribute list.

`typed-shared-neighbor-v1` compares same-kind nodes using exact
`(edge kind, direction, neighbor ID)` features. A candidate needs at least two
distinct shared neighbors and no direct edge in either direction, of any kind.
Its score is `sum(1 / feature_frequency for shared features) / union_size`,
where frequency counts eligible nodes with that exact feature. Thus shared hubs
are weaker witnesses. This is a ranking heuristic, not a probability, inferred
semantic relation, `SAME_AS` assertion, full Yoneda computation, or motif completion.
Names and content do not rank candidates. Counts, confidence, and time attributes
remain evidence metadata; the algorithm does not infer simultaneous relations.

JSON output includes `algorithm`, `candidates`, counts and limitations. Each
candidate has a stable pair ID, `left`/`right` exported node IDs, score,
`shared_features`, and an `evidence` list of raw typed edge dictionaries.
Output is deterministic for the same graph. The candidate ID does not change
when evidence changes; consumers must version their input snapshot separately.
Zero candidates is valid. `--limit 0` emits only summary metadata. The command
refuses more than 2,000 nodes and refuses overwriting export inputs.

Generated/derived nodes and edges, any `generated_by` marker, proposal paths
containing `suggested-link-`, and flagged administrative nodes cannot support
or receive candidates. Known administrative `notes/{constitution,commitments,
hot-snapshot,recipes,self-model}` pages are also excluded. Scaffolding kinds
`CONTAINS`/`TAGGED` and identity kind `SAME_AS` never support scores. Exclusion
still depends on the exporter retaining provenance and administrative flags;
unmarked generated content cannot be reliably identified by topology.
The CLI only writes the requested JSON. Review and vault application belong
to the external orchestrator, not CTKR.
