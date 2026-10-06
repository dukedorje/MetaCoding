# Changelog

## Unreleased

### Descriptive structural-analysis names
- Preferred CLI names: `structural-profiles` and `composition-patterns`; old
  `hom-profiles` and `operads` commands remain aliases with the same artifacts.
- Preferred MCP names: `ctkr.similar_roles`, `ctkr.structural_alignment`, and
  `ctkr.composition_patterns`; all three legacy names remain supported.
- Current docs, help and algorithm descriptions separate implemented graph
  heuristics from category-theory inspiration. Exact-profile classes are not
  automorphism orbits; approximate mappings do not prove behavioral equivalence.
- Port reports now describe their independent role-pair witness check honestly.
  Scoring is unchanged; connected path/common fan-in witnesses are not checked.
- Category theory is documented as optional research after repeated useful
  graph/search workflows. Package names and artifact/schema identifiers remain
  unchanged; no data migration is required.

### Index / serve reliability
- **`metacoding index` fails loudly on an unproductive run (MetaCoding-0sd).** A run
  used to exit 0 while writing a completely empty graph — `index <ory/fosite> --scip`
  picked scip-typescript (fosite is Go but ships `package.json`), the indexer died with
  "no files got indexed", the failure was caught and logged, and the run reported
  success. The new gate (`src/cli/index-gate.ts`) measures the STORE after the run and
  refuses the run when a lane died, when no file was scanned, when no symbols landed,
  when SCIP was requested but no relational edges exist, or when less than
  `--min-coverage` (default 10%) of the repo's source files were covered. `index-all`
  now exits non-zero when any repo fails. Escape hatch: `--allow-empty-index`.

Six weeks of work: PHP support across the pipeline, an expanded structural-analysis
toolset (subsystems, roles, composition patterns, approximate mappings and port
diagnostics), a value-equivalence oracle for cross-framework porting, and
index/serve reliability fixes.

### Language support
- PHP tree-sitter extraction lane: symbols, containment, tokens (MetaCoding-8sh)
- High-fidelity PHP SCIP lane via `scip-php`, plus CLI support for pre-built PHP SCIP
  indexes (`--load-scip`)
- PHP LSP (language server) support
- PHP inheritance edges (`EXTENDS`/`IMPLEMENTS`/`USES_TRAIT`) and a tree-sitter
  field-access heuristic lane with edge provenance
- Drupal-aware extraction: declarative-config intention lane, Drupal PHP file
  extension detection (`.module`/`.install`/`.theme`/`.profile`/`.engine`)

### Structural analysis (legacy `ctkr` namespace)
- Pipeline stages: subsystem partitioning (Stage A), boundary/interface extraction
  (Stage B), role inventory and composition-pattern mining (Stage C), and spec-deck
  NL rendering (Stage D/E), with read-side MCP tools over derived artifacts
- Approximate structural alignment: search, eval harness and artifact emission
  (`functors.parquet`); structural profiles include opt-in typed-neighbor means
  and per-edge-kind weighting; preferred MCP tool `ctkr.structural_alignment`
- Port structural diagnostics with cross-language normalization; heuristic scores
  supplement, not replace, independent behavioral checks
- Glossary tooling: `propose-terms`, `glossary-gaps` vocabulary diff, glossary binding
  gate with spec-driven term codegen, term-incidence graph, role-gaps sweep
- Lexicon-bind: multiple wave-1/wave-2 term bindings across log-family features
  (birth_mother, lot_number, delete_quantity, material_quantity, equipment_used, and
  others)
- CTKR Observatory: live visualization of islands, entropy, twins, and the port
  bipartite graph
- Entropy/marginal-entropy harness with `--kind-weight` support

### Port-loop / value-equivalence oracle
- Value-equivalence oracle: glossary, fixtures, farmOS driver, recorder, runner, CLI
- Intention harvest (mechanical + LLM-assisted), calibration pipeline
  (`calibration.parquet`, ingest CLI, dial sweep), target-conditioned port briefs
- Kernel evolution v1 → v1.3: frozen shared-decision elements, fold library
  (`FoldReduce`, `GSet`, `GuardedFirstWrite`), status split, staleness pin
- Trust model refactor: authority / no-pen / no-answer; epistemology charter replacing
  the "courtroom" model with dialectic
- `metacoding doctor`: reports active lanes and tooling gaps

### Index / serve reliability
- Read-only opens now coexist with a running index (epic MetaCoding-gh0)
- `serve` reopens on refresh — picks up a reindex without restart
- Index-state observability: distinguish "not indexed" from "no results"
- `serve` exits on client disconnect so the LSP child can't orphan
- Watch-mode resolver hydration scoped to needed names (perf)
- `--per-commit-identity` re-reads HEAD per watch event

### Fixes
- SCIP no longer clobbers tree-sitter structural fields on field-level merge
- Namespace-qualified `CONSTRUCTS` edges + denylist
- `ANNOTATES` emission for imported/unresolved decorators; new `RAISES` edge kind
- `CALLS` edges now derived from callable `REFERENCES` in the PHP SCIP lane
- Declared `scipy` as a runtime dependency (networkx pagerank/eigenvector requires it)
- `DataFieldCard.type` populated for scalar fields; worktree path normalization

## 0.1.4 (2026-06-09)

Previous release.
