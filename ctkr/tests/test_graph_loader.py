"""Tests for the JSONL → NetworkX graph loader.

Uses a small synthetic export so this passes without needing the real
~300k-symbol MetaCoding graph. A separate `test_graph_loader_real.py`
exercises the live data when it's available; we don't fail the suite
when it isn't.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

from ctkr.graph_loader import (
    CODE_DOMAIN,
    EDGE_KINDS,
    INFORMATION_DOMAIN,
    DomainProfile,
    graph_stats,
    load_domain_profile,
    load_graph,
    resolve_paths,
    search_tokens,
)


@pytest.fixture
def synth_export(tmp_path: Path) -> Path:
    """Create a tiny synthetic export: 4 symbols, 4 typed edges."""
    nodes = [
        {
            "id": "n1",
            "kind": "class",
            "language": "ts",
            "repo": "cline",
            "qualified_name": "ToolRegistry",
            "short_name": "ToolRegistry",
            "file": "src/registry.ts",
            "line": 10,
            "col": 0,
            "end_line": 30,
            "end_col": 0,
            "signature": None,
            "visibility": "public",
            "is_abstract": False,
            "is_static": False,
            "ast_hash": "abc",
            "branch": "main",
            "source": "scip",
        },
        {
            "id": "n2",
            "kind": "method",
            "language": "ts",
            "repo": "cline",
            "qualified_name": "ToolRegistry.register",
            "short_name": "register",
            "file": "src/registry.ts",
            "line": 15,
            "col": 2,
            "end_line": 18,
            "end_col": 2,
            "signature": "(name: string, fn: Function) => void",
            "visibility": "public",
            "is_abstract": False,
            "is_static": False,
            "ast_hash": "def",
            "branch": "main",
            "source": "scip",
        },
        {
            "id": "n3",
            "kind": "class",
            "language": "py",
            "repo": "crewAI",
            "qualified_name": "crewai.tools.Tool",
            "short_name": "Tool",
            "file": "src/tools/tool.py",
            "line": 5,
            "col": 0,
            "end_line": 25,
            "end_col": 0,
            "signature": None,
            "visibility": "public",
            "is_abstract": False,
            "is_static": False,
            "ast_hash": "ghi",
            "branch": "main",
            "source": "scip",
        },
        {
            "id": "n4",
            "kind": "method",
            "language": "py",
            "repo": "crewAI",
            "qualified_name": "crewai.tools.Tool.execute",
            "short_name": "execute",
            "file": "src/tools/tool.py",
            "line": 12,
            "col": 4,
            "end_line": 18,
            "end_col": 4,
            "signature": "(self, *args, **kwargs)",
            "visibility": "public",
            "is_abstract": False,
            "is_static": False,
            "ast_hash": "jkl",
            "branch": "main",
            "source": "scip",
        },
    ]
    edges = [
        {"src_id": "n1", "dst_id": "n2", "kind": "CONTAINS"},
        {"src_id": "n3", "dst_id": "n4", "kind": "CONTAINS"},
        {"src_id": "n2", "dst_id": "n4", "kind": "CALLS", "count": 3},
        {"src_id": "n2", "dst_id": "n4", "kind": "REFERENCES", "count": 1},
    ]

    out = tmp_path / "export"
    out.mkdir()
    with (out / "nodes.jsonl").open("w") as f:
        for n in nodes:
            f.write(json.dumps(n) + "\n")
    with (out / "edges.jsonl").open("w") as f:
        for e in edges:
            f.write(json.dumps(e) + "\n")
    return out


def test_edge_kinds_match_ts_definition() -> None:
    # 15 edge kinds in MetaCoding's src/store/types.ts EdgeKind union
    # (10 original + 4 behavior-capturing edges from MetaCoding-e54
    #  + 1 exception-flow edge RAISES from MetaCoding-ijo).
    assert len(EDGE_KINDS) == 15
    assert "CALLS" in EDGE_KINDS
    assert "IMPLEMENTS" in EDGE_KINDS
    assert "IMPORTS" in EDGE_KINDS
    assert "READS_FIELD" in EDGE_KINDS
    assert "WRITES_FIELD" in EDGE_KINDS
    assert "RETURNS_TYPE" in EDGE_KINDS
    assert "CONSTRUCTS" in EDGE_KINDS
    assert "RAISES" in EDGE_KINDS


def test_resolve_paths_direct(synth_export: Path) -> None:
    paths = resolve_paths(synth_export)
    assert paths.nodes.name == "nodes.jsonl"
    assert paths.edges.name == "edges.jsonl"


def test_resolve_paths_under_ctkr_export(tmp_path: Path, synth_export: Path) -> None:
    """If the caller passes `.metacoding/`, the loader looks under
    `ctkr/export/`."""
    fake_meta = tmp_path / "fake-metacoding"
    (fake_meta / "ctkr").mkdir(parents=True)
    # Move the synth export into the expected location.
    (fake_meta / "ctkr" / "export").symlink_to(synth_export)
    paths = resolve_paths(fake_meta)
    assert "ctkr/export" in str(paths.nodes)


def test_resolve_paths_missing_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        resolve_paths(tmp_path)


def test_load_graph_basic(synth_export: Path) -> None:
    g = load_graph(synth_export)
    assert g.number_of_nodes() == 4
    # 4 edges across 2 (n1→n2 CONTAINS, n3→n4 CONTAINS) + 2 parallel (n2→n4 CALLS+REFERENCES)
    assert g.number_of_edges() == 4


def test_load_graph_node_attrs(synth_export: Path) -> None:
    g = load_graph(synth_export)
    assert g.nodes["n1"]["repo"] == "cline"
    assert g.nodes["n1"]["qualified_name"] == "ToolRegistry"
    assert g.nodes["n1"]["file_path"] == "src/registry.ts"
    assert g.nodes["n1"]["file"] == "src/registry.ts"  # both work


def test_load_graph_edge_kinds_present(synth_export: Path) -> None:
    g = load_graph(synth_export)
    kinds = {k for _, _, k in g.edges(keys=True)}
    assert kinds == {"CONTAINS", "CALLS", "REFERENCES"}


def test_load_graph_edge_count_attr(synth_export: Path) -> None:
    g = load_graph(synth_export)
    # Multi-edges keyed by kind: n2 → n4 has two parallel edges.
    calls_attr = g.get_edge_data("n2", "n4", key="CALLS")
    refs_attr = g.get_edge_data("n2", "n4", key="REFERENCES")
    assert calls_attr["count"] == 3
    assert refs_attr["count"] == 1


def test_load_graph_repo_filter(synth_export: Path) -> None:
    g = load_graph(synth_export, repo_filter=["cline"])
    assert g.number_of_nodes() == 2
    # Edges crossing the dropped repo also vanish.
    kinds = {k for _, _, k in g.edges(keys=True)}
    assert "CALLS" not in kinds  # n2→n4 was cross-repo via the synth setup


def test_load_graph_edge_kind_filter(synth_export: Path) -> None:
    g = load_graph(synth_export, edge_kind_filter=["CONTAINS"])
    kinds = {k for _, _, k in g.edges(keys=True)}
    assert kinds == {"CONTAINS"}


def test_load_domain_profile_absent_is_code_domain(tmp_path: Path) -> None:
    assert load_domain_profile(None) is CODE_DOMAIN
    assert load_domain_profile(tmp_path / "missing.json") is CODE_DOMAIN
    manifest = tmp_path / "manifest.json"
    manifest.write_text("{}", encoding="utf-8")
    assert load_domain_profile(manifest) is CODE_DOMAIN


def test_load_domain_profile_information_block(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "domain": {
                    "name": "information",
                    "edge_kinds": ["MENTIONS", "WORKS_AT"],
                    "counted_edge_kinds": ["MENTIONS"],
                    "anchor_node_kinds": ["page", "entity.person"],
                    "partition_key": "source",
                    "bridge_key": "title",
                    "scaffold_edge_kinds": ["CONTAINS", "TAGGED"],
                }
            }
        ),
        encoding="utf-8",
    )
    profile = load_domain_profile(manifest)
    assert profile.name == "information"
    assert profile.edge_kinds == ("MENTIONS", "WORKS_AT")
    assert profile.partition_key == "source"
    assert profile.bridge_key == "title"
    assert "TAGGED" in profile.scaffold_edge_kinds
    assert INFORMATION_DOMAIN.partition_key == "source"


def test_load_graph_aliases_partition_and_bridge(tmp_path: Path) -> None:
    out = tmp_path / "export"
    out.mkdir()
    nodes = [
        {
            "id": "p1",
            "kind": "entity.person",
            "source": "wiki",
            "title": "Garry Tan",
            "qualified_name": "people/garry-tan",
        },
        {
            "id": "c1",
            "kind": "entity.org",
            "source": "wiki",
            "title": "Y Combinator",
            "qualified_name": "companies/y-combinator",
        },
    ]
    edges = [
        {
            "src_id": "p1",
            "dst_id": "c1",
            "kind": "WORKS_AT",
            "valid_from": "2015-01-01",
            "valid_to": None,
            "confidence": 0.9,
        }
    ]
    (out / "nodes.jsonl").write_text("".join(json.dumps(n) + "\n" for n in nodes), encoding="utf-8")
    (out / "edges.jsonl").write_text("".join(json.dumps(e) + "\n" for e in edges), encoding="utf-8")
    (out / "manifest.json").write_text(
        json.dumps(
            {
                "domain": {
                    "name": "information",
                    "partition_key": "source",
                    "bridge_key": "title",
                }
            }
        ),
        encoding="utf-8",
    )
    g = load_graph(out)
    assert g.graph["domain_profile"].name == "information"
    assert g.nodes["p1"]["repo"] == "wiki"
    assert g.nodes["p1"]["short_name"] == "Garry Tan"
    edge = g.edges["p1", "c1", "WORKS_AT"]
    assert edge["valid_from"] == "2015-01-01"
    assert edge["confidence"] == 0.9
    assert "valid_to" not in edge  # None is dropped
    s = graph_stats(g)
    assert s["n_repos"] == 1
    assert s["repos"]["wiki"] == 2


def test_load_graph_explicit_profile_overrides_manifest(tmp_path: Path) -> None:
    out = tmp_path / "export"
    out.mkdir()
    (out / "nodes.jsonl").write_text(
        json.dumps({"id": "n", "kind": "page", "source": "inbox", "title": "x"}) + "\n",
        encoding="utf-8",
    )
    (out / "edges.jsonl").write_text("", encoding="utf-8")
    (out / "manifest.json").write_text(
        json.dumps({"domain": {"name": "information", "partition_key": "source"}}),
        encoding="utf-8",
    )
    g = load_graph(out, profile=DomainProfile(name="forced", partition_key="repo"))
    assert g.graph["domain_profile"].name == "forced"
    assert "repo" not in g.nodes["n"]


def test_graph_stats(synth_export: Path) -> None:
    g = load_graph(synth_export)
    s = graph_stats(g)
    assert s["n_nodes"] == 4
    assert s["n_edges"] == 4
    assert s["edge_kinds"]["CONTAINS"] == 2
    assert s["edge_kinds"]["CALLS"] == 1
    assert s["edge_kinds"]["REFERENCES"] == 1
    assert s["n_repos"] == 2
    assert s["repos"]["cline"] == 2
    assert s["repos"]["crewAI"] == 2


def test_search_tokens_smoke(tmp_path: Path) -> None:
    """search_tokens hits an FTS5 trigram virtual table directly. We
    build a tiny synthetic one to keep the test self-contained."""
    db_path = tmp_path / "tokens.fts.sqlite"
    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE VIRTUAL TABLE tokens USING fts5("
        "text, kind UNINDEXED, repo UNINDEXED, file UNINDEXED, "
        "line UNINDEXED, col UNINDEXED, symbol_id UNINDEXED, tokenize='trigram')"
    )
    conn.executemany(
        "INSERT INTO tokens(text, kind, repo, file, line, col, symbol_id) VALUES (?,?,?,?,?,?,?)",
        [
            ("RateLimiter", "identifier", "cline", "src/limiter.ts", 5, 0, "s1"),
            ("rate_limit", "identifier", "crewAI", "src/utils.py", 10, 0, "s2"),
            ("unrelated", "identifier", "cline", "src/other.ts", 1, 0, "s3"),
        ],
    )
    conn.commit()
    conn.close()

    df = search_tokens(db_path, "rate")
    assert df.height == 2

    df_repo = search_tokens(db_path, "rate", repo="cline")
    assert df_repo.height == 1
    assert df_repo["repo"][0] == "cline"


def _orchestrators_metacoding_dir() -> Path:
    """Resolve ``$ORCHESTRATORS_ROOT/.metacoding`` with a backwards-compat
    fallback to ``~/projects/Orchestrators/.metacoding`` for the original
    dev's machine. Reads each invocation so the env var can change between
    test runs without re-importing the module."""

    root = os.environ.get("ORCHESTRATORS_ROOT", str(Path.home() / "projects" / "Orchestrators"))
    return Path(root) / ".metacoding"


@pytest.mark.skipif(
    not (_orchestrators_metacoding_dir() / "ctkr" / "export" / "nodes.jsonl").exists(),
    reason=(
        "real MetaCoding export not present; run `metacoding export` first or "
        "set ORCHESTRATORS_ROOT to point at a different corpus."
    ),
)
def test_load_real_metacoding_export() -> None:
    """Acceptance test against the live MetaCoding corpus, when present.

    Skips gracefully when the export hasn't been run yet — useful for CI
    that doesn't have the indexed data. When it IS present, sanity-checks
    the loaded graph against the expected ~300k-symbol shape.
    """
    g = load_graph(_orchestrators_metacoding_dir())
    s = graph_stats(g)
    assert s["n_nodes"] > 10_000  # the MetaCoding inspection reported ~300k
    assert s["n_repos"] > 5
    assert "CALLS" in s["edge_kinds"] or "CONTAINS" in s["edge_kinds"]


def test_information_name_defaults_and_explicit_empty_fields(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"domain": {"name": "information"}}))
    assert load_domain_profile(manifest) == INFORMATION_DOMAIN
    manifest.write_text(
        json.dumps(
            {"domain": {"name": "information", "scaffold_edge_kinds": [], "extra_edge_attrs": []}}
        )
    )
    profile = load_domain_profile(manifest)
    assert profile.scaffold_edge_kinds == frozenset()
    assert profile.extra_edge_attrs == ()


@pytest.mark.parametrize(
    "block",
    [
        "information",
        {"edge_kinds": "MENTIONS"},
        {"edge_kinds": ["X", "X"]},
        {"partition_key": 3},
        {"anchor_node_kinds": [None]},
        {"extra_edge_attrs": ["kind"]},
        {"name": 3},
    ],
)
def test_malformed_profiles_fail_instead_of_silent_code_fallback(tmp_path, block):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"domain": block}))
    with pytest.raises(ValueError):
        load_domain_profile(manifest)


def test_aliases_preserve_existing_attributes_and_support_filter(synth_export):
    profile = DomainProfile(name="custom", partition_key="source", bridge_key="qualified_name")
    loaded = load_graph(synth_export, profile=profile, repo_filter=["cline"])
    assert set(loaded) == {"n1", "n2"}
    assert loaded.nodes["n2"]["short_name"] == "register"
    assert loaded.nodes["n2"]["repo"] == "cline"
