# Structural analysis: names and guarantees

MetaCoding's useful foundation is resolved symbols, typed relationships, source
locations, text search and graph queries. Structural analysis adds clustering,
pattern mining and approximate mappings. Category theory is an inspiration and
an experimental track, not an implied guarantee of these algorithms.

## Preferred vocabulary

| Prefer | Earlier name | What the implementation does |
| --- | --- | --- |
| Structural profile | Hom-profile / Yoneda profile | Counts typed incoming/outgoing edges; depth 2 adds typed neighbor means. A lossy structural signature. |
| Similar structural roles | Role equivalence | Ranks profile similarity. A candidate list, not proof of identical role, behavior or categorical equivalence. |
| Exact-profile class | Orbit / exact WL orbit | Groups identical stored profile vectors. This is not an automorphism-orbit computation. |
| Similarity cluster | Similarity quotient | Connected components at a cosine threshold; membership is not pairwise equality or guaranteed pairwise similarity above that threshold. |
| Approximate structural alignment | Functor discovery | Finds a partial typed-graph mapping using candidate similarity, propagation and edge-preservation heuristics. |
| Composition patterns | Operad recovery / composition laws | Mines supported role paths and fan-in patterns from indexed edges. |
| Pattern diagnostic | Non-operadic violation | Flags a pattern under chosen thresholds and modeling assumptions; not a violated mathematical axiom. |
| Subsystem / boundary detection | Categorical decomposition | Uses graph community structure, optional directory priors and stability across parameter settings. |

**Use the descriptive names in new prose and interfaces.** Do not infer a
stronger property because an existing filename, type or field retains its old
name. Historical reports keep their original identifiers so their evidence can
still be located.

## Public names and compatibility

The package, executable and MCP namespace remain `ctkr` for compatibility. They
identify the structural-analysis implementation, not a claim that every command
computes a categorical construction.

| Preferred entry point | Supported legacy alias |
| --- | --- |
| `ctkr structural-profiles` | `ctkr hom-profiles` |
| `ctkr composition-patterns` | `ctkr operads` |
| MCP `ctkr.similar_roles` | `ctkr.role_equivalent` |
| MCP `ctkr.structural_alignment` | `ctkr.functor_between` |
| MCP `ctkr.composition_patterns` | `ctkr.composition_rules` |

Aliases use the same inputs, outputs and implementation. The new names do not
silently migrate artifacts or strengthen their semantics. Existing artifacts
such as `hom_profiles.parquet`, `presentations.parquet`, `functors.parquet` and
`operads.parquet`, their schemas, and legacy fields/enums remain readable.
For example, `view="orbit"` means exact-profile grouping, and a legacy
`non_operadic` row is a pattern diagnostic. Internal symbols and historical test
names may retain these terms; changing a wire format requires a separate,
versioned migration rather than a global text replacement.

## Important limits

- Equal profiles need not identify equivalent graph positions. Directed cycles
  of length three and four with uniform edge/node kinds produce the same current
  depth-1 and depth-2 signatures. Their nodes cannot share an automorphism orbit
  across the two differently sized components.
- Neighbor means are not an injective multiset encoding. Describe depth 2 as
  neighbor aggregation, or WL-inspired, not exact Weisfeiler–Leman refinement.
- Preserved indexed edges are not preserved program behavior. Dynamic dispatch,
  dependency injection, missing extraction lanes and changed execution semantics
  can all break that inference.
- A call/reference path is not necessarily an executable trace or an ordering
  contract. Repeated paths are evidence of indexed structure, not proof of
  associativity, closure or behavioral protocols.
- A cycle does not violate a generic category or operad axiom. A missing mined
  composite may come from role grouping, support thresholds or truncation.
- The current port composition check tests role-pair witnesses independently.
  It does not ensure a common intermediate instance along a whole path or a
  common target for all fan-in inputs. Treat that score as a weaker structural
  diagnostic, not a complete path-realizability certificate.

## What earns a place in the normal workflow

Start with a complete useful cycle: ask a real question, retrieve source-backed
structure, use it to make a change or decision, and verify the result. Repeat it
until the tool has habitual use. Examples: inspect callers before an API change;
find a boundary to scope a task; inspect a proposed mapping and its missing
edges; check behavior against independently observed fixtures.

Compare added analysis with the same-data, same-budget graph/search baseline.
Measure useful findings, missed cases, false suggestions and total task effort.
Keep uncertainty and coverage visible. Feature tests establish implementation
behavior; they do not by themselves establish user value.

Category-theory experiments stay optional and must not become a prerequisite
for this workflow. See [the research track](category-theory-research.md) for the
mathematical inspiration and the obligations stronger claims would require.
