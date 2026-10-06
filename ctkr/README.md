# Structural analysis (`ctkr`)

Optional Python batch analysis over the MetaCoding code graph. The Bun root
owns indexing and MCP serving; this sub-project produces derived artifacts for
structural profiles, subsystem boundaries, roles, composition patterns, motifs,
embeddings, centrality, topology, and optional LLM labels.

Start with graph queries and a real coding task. Use these analyses when they
help the full index → inspect → change → test → re-index → verify cycle.
Compare their findings with source/text and graph-only baselines before making
them routine. Category theory remains an optional research track, not a required
layer or an implied mathematical guarantee.

## Quick start

From `MetaCoding/ctkr/`:

```bash
uv sync
uv run ctkr --help
uv run ctkr info
uv run pytest
```

Python is pinned in `.python-version`. Python and Bun share a repository but
have separate dependency graphs. See each command's `--help` for its inputs and
optional dependencies; not every analysis is available from a base install.

### A small structural workflow

First index a project with the root `metacoding` CLI. Use the resolved data
directory printed by indexing; it may be an XDG path rather than `.metacoding/`.
Pass it explicitly to Python (Python's fallback only searches ancestor
`.metacoding/` directories):

```bash
uv run ctkr structural-profiles --data-dir /path/to/data-dir
uv run ctkr subsystems --data-dir /path/to/data-dir
uv run ctkr interfaces --data-dir /path/to/data-dir
uv run ctkr roles --data-dir /path/to/data-dir
uv run ctkr composition-patterns --data-dir /path/to/data-dir
```

These commands build offline artifacts; they do not modify the source program.
Inspect the index's coverage and health before analysis. Regenerate relevant
artifacts after graph changes. For MCP reads, set `METACODING_CTKR_DATA_DIR` to
that same **data directory**, not its `ctkr/` child, before starting the server.
Use `describe_api` to inspect tool schemas and health/refusal envelopes.

Optional `label-motifs` and `label-roles` calls use a configured LLM provider.
They can send source context off machine; inspect their flags and provider
settings before running them. A generated label is an interpretation to review.

## Names and limits

Preferred commands are `structural-profiles` and `composition-patterns`.
`hom-profiles` and `operads` remain aliases with the same behavior. Other command
names are unchanged. Preferred MCP names are `ctkr.similar_roles`,
`ctkr.structural_alignment`, and `ctkr.composition_patterns`; the former names
remain aliases. See the complete
[names and compatibility contract](../docs/design/structural-analysis-terminology.md).

- Structural profiles are lossy typed-edge summaries, not full hom-functors.
- An exact-profile class (`view="orbit"` on the wire) is not an exact
  automorphism orbit. Equal profiles do not prove equivalent graph positions.
- Approximate structural alignment proposes partial mappings, not categorical
  or behavioral equivalence. Inspect ambiguity as well as coverage/fidelity.
- Composition patterns are observed role paths and fan-in, not verified operad
  laws or execution-order contracts. Legacy diagnostic names retain their IDs.

## Artifacts

Artifacts live under `<data_dir>/ctkr/`. Existing names such as
`hom_profiles.parquet`, `presentations.parquet`, and `operads.parquet` stay
unchanged. This naming update requires no schema or data migration.
See [artifact contracts](../docs/design/ctkr-artifacts.md) and the
[current structural-analysis design](../docs/design/ctkr.md).

Artifacts are batch results, not a live view of an edited worktree. The MCP
fitness gate checks graph health and generation timing, but this does not
provide complete per-run provenance or guarantee extraction completeness.

## Adding a command

`ctkr.cli` discovers modules under `ctkr/commands/`. Each command module exports
`register(subparsers)` and `run(args)`, with `run` returning an exit code.
`info.py` is a small template. Keep optional-heavy imports inside `run()` and
declare extras in `pyproject.toml` so command discovery remains lightweight.

## Research

See [category theory: inspiration and experiments](../docs/design/category-theory-research.md)
for the deeper questions and the evidence stronger claims would require. The
[historical pipeline plan](../docs/design/ct-pipeline.md) preserves earlier
proposals; it is not the current delivery order or a shipped-feature checklist.
