# Decomposition loop

**Status:** Operating method. Written 2026-11-04 from the farmOS port measurements and the NAOMS Rust rewrite.
**Companions:** [`decomposition-schema.md`](./decomposition-schema.md), [`ct-subsystem-extraction.md`](./ct-subsystem-extraction.md), [`ct-intention-extraction.md`](./ct-intention-extraction.md), [`spec-anchored-porting.md`](./spec-anchored-porting.md), [`where-the-techniques-shine.md`](./where-the-techniques-shine.md), [`epistemology-charter.md`](./epistemology-charter.md).
**Research notes for outside techniques:** [`../research/port-technique-reports-2026-11-04.md`](../research/port-technique-reports-2026-11-04.md).
**First NAOMS pass:** [Pass 0](#pass-0--naoms-2026-11-04) at the bottom of this file.

The method is a spec desk in front of a clean room. MetaCoding carves a source tree into the seven documents of the decomposition schema. The desk writes WHAT and WHY into the target spec. The room implements from that spec and does not read the source tree.

Category theory stays a research lens. Profiles are edge-count vectors. Alignments are partial maps. Communities are not colimits. The product names are enough to run a port.

## Roles

| Role | Reads | Writes |
|---|---|---|
| Graph | The indexed source, with extractor and health attached to every claim | Ladybug nodes and edges for the seven documents, plus effect metadata |
| Spec desk | The seven documents, observed fixtures, and external specs (RFCs) where they exist | Target `spec/`: invariants, acceptance tests, surface blocks, port decisions |
| Clean room | The target spec only | The target implementation and the tests that cite acceptance ids |
| Reader | One unsaturated pass, and only at an irreversible act | One pith question, or an accept / send-back on a kernel or instrument change |

`/prd` and `/sprint-plan` start after a feature is named and its scenarios exist. They do not discover the inventory of a large tree. The intention loop (`intend` → `steer` → `change` → `act` → `fold`) runs inside the target repo against the spec. `advise` is the one-reader check. A full Elenchus waits for a kernel freeze, an oracle re-baseline, or a wave seal, and its product is one question.

## What the graph is for

On farmOS the graph earned its keep outside the build: scoping islands, finding what to fixture, ranking decisions by blast radius, and auditing divergence. Generated briefs and interactive queries during the build added about nothing, because behavior lives in bodies and in dependency injection. The acceptance signal was fixtures observed from a running system.

Islands are structural scope. The rule that discriminates a feature may be authored in a neighboring module and wired through a registry. Mine the modules that write the behavior, including boundary modules.

## Loop

Each pass records the source revision, the extractor, index health, and which claims are refused because the extractor cannot see them. A missing edge is an extractor gap, not evidence of absence.

1. **Carve, without names.** Louvain across a resolution sweep on typed edges, with a low-weight directory prior. Keep pairs that stay together. Flag symbols whose assignment flips. Compare the cut to declared packages and to the target crate list. Three piles: a clean island (high persistence, one job), a paper module (the directory and the island disagree), a repeated shape (same structural profile twice: one schema, two instances).
2. **Name features downstream of the cut.** A feature is a persistent island plus the behavior its tests and boundary names assert. Harvest tests, public signatures, error strings, routes and tool names, then constants. Comments and design notes are vocabulary and non-goals. Intention never moves a symbol back across the cut.
3. **Hydrate behavior before prose.** The first artifact for an island is a fixture pack from the running system or an existing test. Where the target already runs, the fixture is differential, and some cases are held out from the implementer.
4. **Spec one slice.** One invariant is one sentence that is true or false at a named boundary, with a why. One acceptance test cites it. The surface block lists every signature the test may call. A linter rejects source paths and source identifiers. Shared seams (tool registry, identity, store, wire protocols) are specced once, before the features that use them. Protocols with an external spec use the spec text as the oracle.
5. **Implement on the cheap tier.** Test team and build team, questions out as spec defects. A feature port ships with a fixture that fails before the fix and passes after. Instrument changes (the judge, the linter, the vector format, the kernel) get a fresh reader.
6. **Check behavior.** Structural fidelity on a cross-language rewrite is a divergence ledger. What binds is acceptance coverage, held-out differentials, unpredicted waivers, and stale waivers. After the target crate exists, an alignment between island and crate shows what survived. What survived corrects the inventory.

The seven documents are the conceptual division of the raw tree. A pass is complete for a slice when each document is populated or explicitly empty with a reviewed reason.

| Document | Question | Filter that makes it useful | Ladybug home |
|---|---|---|---|
| D1 Feature Inventory | What must the port still do? | Declarative keys first (manifest, tool registry, crate, route table). Structural exports second. Model labels last, and only on a frozen cut. `source_basis` is `declarative`, `structural`, or `label`. | `Feature` node, `REALIZES` → `Subsystem` / `Symbol` |
| D2 Domain Glossary | What does this domain call its things? | Intent-bearing terms only: type names, field names, public signatures, enum and config keys. Drop framework affixes and one-off locals. One corpus row per term, with the surface spellings kept. | `Term` node, `USES_TERM` from `Feature` and `DataShape` |
| D3 Data Shapes | What crosses a boundary, which way? | Boundary shapes enter the contract. Internal shapes are marked restructurable. Each row has a flow: read, write, or both. A thin section with an extractor gap stays marked as a gap. | `DataShape` + `Field` nodes, `CROSSES` with `direction` |
| D4 Behavioral Scenarios | What value is delivered? | Test names and assertion messages only. Glossary words. No table, column, or storage primitive. Every scenario cites a test symbol. A held-out flag stays off the build packet. | `Scenario` node, `ACCEPTS` from `Feature`, `CITES` → test `Symbol` |
| D5 Invariant Register | What must always hold? | One sentence, true or false at a named boundary, with a witness. Tag consistency-model sensitivity (unique, revision-lock, access-check, clock, entropy). Join to the field it constrains. | `Invariant` node, `ENFORCES` → `Symbol` or `Field`, `WITNESS` → `Scenario` |
| D6 Seam Map | What are the real boundaries? | Crossing edges only. Persistence of the cut. The disagreement with declared directories is the finding. Contracts that many features share are seams, specced once. | `Subsystem` node, `SEAM` between subsystems with edge-kind counts |
| D7 Warnings | Where is the obvious reading wrong? | Low boundary confidence, behavior authored outside the island, extractor gaps, name/structure conflicts, paper modules, mega-islands, spec claims with no code, code with no spec. | `Warning` node, `ABOUT` → any of the above |

Feature and subsystem are many-to-many. A feature smeared across many subsystems is a cross-cutting concern. A subsystem that serves one feature is a clean first port.

## Representation

Ladybug is the query store. Parquet and JSONL stay batch interchange for the Python miners. Agents traverse with Cypher. Typed MCP tools are views over this graph, not a second model.

Effects are metadata on the traversal, not a new prose document. A call edge does not say whether the callee writes state, talks to the network, reads the clock, or throws. Those are `EFFECT` edges from a `Symbol` to an `Effect` node.

```cypher
CREATE NODE TABLE Effect (
  id         STRING PRIMARY KEY,  -- blake3(kind, api, authority, location)
  kind       STRING,              -- read | write | net | io | process | crypto | clock | random | throw | ui
  api        STRING,              -- canonical callee or field, e.g. fetch, fs.write, Date.now
  authority  STRING,              -- scip | treesitter-name | semantic | joern | runtime
  confidence STRING,              -- resolved | candidate | unknown
  conditional BOOLEAN
);

CREATE REL TABLE EFFECT FROM Symbol TO Effect (
  file STRING, line INT, evidence_id STRING
);
```

Authority is part of the edge. A SCIP `WRITES_FIELD` is `authority=scip`, `kind=write`, `confidence=resolved`. A tree-sitter match on the name `fetch` is `authority=treesitter-name`, `kind=net`, `confidence=candidate`. A missing semantic graph is reported as coverage unknown. It is not an empty effect set.

`READS_FIELD`, `WRITES_FIELD`, `RAISES`, and `CONSTRUCTS` stay as they are. `EFFECT` is the rollup a feature trace follows when it asks "what does this island do to the world?" Joern `FLOWS_TO` remains on demand for a slice, written back with `authority=joern`.

REA's JavaScript semantic relations (see the research note) are the model for a future semantic lane: a second graph, same artifact digest, static-inference authority, unknowns kept. That lane may emit `EFFECT` rows. It does not replace the structural partition, and it does not enter the clean room.

### Feature trace

Given a D1 feature, the trace is a Cypher walk, not a summary:

- seed: the feature's declarative exports, else its boundary symbols
- walk `CALLS`, `IMPORTS`, `READS_FIELD`, `WRITES_FIELD`, `EFFECT`, `RAISES`
- stop at the seam, and record the seam crossing instead of pulling the neighbor island in
- if a registry or injection edge is the only link, follow it and raise a D7 warning that the author lives outside the island
- return symbols, effects, cited tests, and the coverage declaration (which edge kinds were present in the index)

The trace hydrates D3, D4, and D5 for that feature. It does not rewrite D6.

## What this pass refuses

- A categorical layer before one island has been carved, fixtured, specced, and differentially checked.
- A subsystem card handed to a builder who can still see the source tree.
- A review panel per feature. One reader, and only for the kernel and the instruments.
- Design notes as ground truth. The crate list as the feature list. Both are claims. The disagreement is the result.
- Whole-repo `scip-typescript --infer-tsconfig` on NAOMS. It OOM'd. Slice SCIP outside the repo.

## Pass 0 — NAOMS, 2026-11-04

Source trees: `/Users/dukejones/work/NAOMS/naoms` (TypeScript product) and `/Users/dukejones/work/NAOMS/naoms-rust` (clean-room spec and Rust workspace). This pass did not read Ladybug. `stat` on `~/.local/share/metacoding/naoms/graph.lbug` over the `locallocks` NFS mount timed out. No `graph.lbug.shadow`. No SCIP loader process. `/tmp/naoms-scip/load.log` last wrote at 10:25 local time and ended on a completed slice (`symbolsNew` 6665, `edgesNew` 7185, `edgesDropped` 14). The MCP server whose cwd is `/Users/dukejones/work/NAOMS` is `metacoding serve` with no `--data-dir`, so it is not the named `naoms` store. A Cypher count against that server returned no rows. Claims below are from the working trees. They are a directory prior, not a structural partition.

### Fitness

| Fact | Value |
|---|---|
| TypeScript packages under `naoms/src/packages` | 133 directories. Largest: `sdk` 3448, `agents` 1451, `pkg-manager` 1130, `repo-pipelines` 1080, `photos` 889, `chat` 865, `calling` 827, `hives` 792, `memories` 708, `plan` 687 |
| TypeScript core under `naoms/src/core` | 56 directories. Largest: `chain` 2884, `transport` 2482, then `boot` 864, `graph` 506. This is the mega-island candidate. Do not brief it as features. |
| Clients | `browser` 1567, `android` 571, `ios` 542, `tui` 372 |
| Product tests | `naoms/tests` 6723 files |
| Rust workspace | 46 crates. `daemon` 134 Rust files, `testkit` 65, `crypto` 60, `secure` 58, `ceremony` 53. Most `mod-*` crates are 10–40 files. |
| Spec | 28 module docs, 28 crate docs, 58 claim docs. Unique `INV-*` ids 7711. Unique `AT-*` ids 10962. Module docs alone are 29006 lines. |
| Declarative registry seen | `naoms/src/core/feature-registry` (`index.ts`, `local-origin.ts`). Not yet harvested. |
| Graph | Unreachable this pass. Field read/write effects and cross-file calls are not claimed. |

The spec desk has already written a product partition (`spec/modules/mod-*.md`) and a kernel partition (`spec/crates/*.md`). The invariant and acceptance mass is far past a value oracle. Pass 1 treats that mass as a claim to filter, not as the acceptance spine. Scenarios that enter the room are the ones with an observed witness.

### D1 — declared features versus code

Rust `mod-*` crates (20): agents, ai, bridges, calling, chat, ci, contacts, content, devices, discovery, files, hives, identity, integrations, memories, packages, places, quality, repo, roadmap.

Spec modules with no Rust crate: `mod-calendar`, `mod-canvas`, `mod-fleet`, `mod-sdk`, `mod-tasks`, `mod-tui`, `mod-wallet`, plus `mod-agents-taskcore` as a second agents doc. These are product claims. They stay D1 rows with `source_basis=declarative` and a D7 warning until a crate or a traced island exists.

Large TypeScript packages with no `mod-*` crate and no spec module of the same name, so they are not in the current product partition: `photos` (889), `plan` (687), `token` (640), `plugins` (621), `packs` (620), `messaging-adapters` (567), `vault` (473), `models` (484), `coding-agent-policies` (416), `kronos` (361), `cache-server` (354), `eval` (332), `concierge-router` (315). `plan` may be `mod-tasks`. That mapping is a hypothesis, not a join. `calendar` is specced and has a TypeScript package (546) and no crate.

Name overlap is not structure. `ai` substring-matches six packages. `ci` matches seven. `bridges`, `integrations`, `packages`, and `quality` match no package directory. Those four are either kernel-shaped, renamed, or spec-only.

### D6 — seams to spec once, from the crate list alone

Already separated as `spec/crates` rather than features: `types`, `crypto`, `secure`, `chain`, `ceremony`, `store`, `mls`, `keyholder`, `mailbox`, `net` and the `net-*` transports, `graph`, `api`, `daemon`, `auth`, `pkg`, `infer`, `plugin-host`. On the TypeScript side the same mass sits in `src/core/chain` and `src/core/transport`. That pair is the core blob. The seam contract is the daemon surface, the store, identity and keys, and the wire protocols. Features do not get their own copy.

`feature-registry` is the NAOMS analogue of the farmOS plugin-type seam: a small directory that can pull behavior out of an island. Pass 1 traces it before trusting package membership.

### D7 — warnings this pass is willing to state

- The graph file did not open. Any island talk before a successful read is directory folklore.
- 7711 invariants and 10962 acceptance tests cannot all be the oracle. The next pass ranks them by whether a test in `naoms/tests` or a vector under `spec/vectors` actually witnesses them.
- `src/core/chain` and `src/core/transport` are the monolith. Port them as seams, not as a feature fan-out.
- Spec modules without crates, and large packages without spec modules, are the disagreement audit at directory resolution. The structural audit is still owed.
- The MCP server for this workspace does not point at `~/.local/share/metacoding/naoms`. A later session that queries "the" graph and gets nothing is on the empty default store.

### Next pass, when the graph file stats

One island. Prefer a name that already matches on both sides and is not the blob: `contacts`, `hives`, `roadmap`, `calling`, or `chat`. Rust side is small (11–23 files). TypeScript side is hundreds to about a thousand. The deliverable is the seven documents for that island, with `EFFECT` rows only where SCIP or a semantic lane actually produced them, plus a short fixture list drawn from existing tests. The spec section for that module gets a keep/drop against the existing `INV-*` / `AT-*` mass. The room does not start in that pass.
