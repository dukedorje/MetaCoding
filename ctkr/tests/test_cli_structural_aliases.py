"""Preferred CLI names keep legacy options, dispatch, and artifact contracts."""
from __future__ import annotations

import json
import networkx as nx
import polars as pl
import pytest

from ctkr.cli import _build_parser, main
from ctkr.commands import hom_profiles, operads


@pytest.mark.parametrize("preferred,legacy,options", [
    ("structural-profiles", "hom-profiles", ["--depth", "2", "--kind-weight", "CALLS=0.5", "--kinds-filter", "file"]),
    ("composition-patterns", "operads", ["--view", "orbit", "--min-support", "1", "--max-nodes", "3"]),
])
def test_aliases_share_parser_and_dispatch(preferred, legacy, options):
    parser = _build_parser()
    new = vars(parser.parse_args([preferred, *options]))
    old = vars(parser.parse_args([legacy, *options]))
    assert new.pop("command") == preferred
    assert old.pop("command") == legacy
    assert new == old


@pytest.mark.parametrize("command", ["structural-profiles", "hom-profiles", "composition-patterns", "operads"])
def test_help_documents_compatibility(command, capsys):
    with pytest.raises(SystemExit) as exc:
        main([command, "--help"])
    assert exc.value.code == 0
    text = " ".join(capsys.readouterr().out.split())
    assert "alias" in text
    assert "unchanged" in text
    if command in ("structural-profiles", "hom-profiles"):
        assert "WL-inspired neighbor-mean expansion" in text
        assert "not exact Weisfeiler-Leman" in text


def graph():
    g = nx.MultiDiGraph()
    for node in ("a", "b", "c"):
        g.add_node(node, repo="R", qualified_name=f"R.{node}", kind="function", file="mod.py")
    g.add_edge("a", "b", key="CALLS", kind="CALLS")
    g.add_edge("b", "c", key="CALLS", kind="CALLS")
    return g


def test_structural_profiles_alias_writes_identical_legacy_schema(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(hom_profiles, "load_graph", lambda _: graph())
    outputs = []
    manifests = []
    for command in ("structural-profiles", "hom-profiles"):
        root = tmp_path / command
        root.mkdir()
        assert main([command, "--data-dir", str(root), "--depth", "2", "--kind-weight", "CALLS=0.5", "--json"]) == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["rows"] == 3
        output = root / "ctkr" / "hom_profiles.parquet"
        assert payload["output"] == str(output)
        outputs.append(pl.read_parquet(output))
        manifests.append(json.loads((root / "ctkr" / "manifest.json").read_text()))
    assert outputs[0].equals(outputs[1])
    for key in ("hom_profiles", "n_hom_profiles", "profile_vec_dim", "profile_depth", "kind_weights"):
        assert manifests[0][key] == manifests[1][key]


def test_composition_patterns_alias_writes_identical_legacy_artifact(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(operads, "load_graph", lambda _: graph())
    stamp = "2026-01-01T00:00:00Z"
    artifacts = []
    for command in ("composition-patterns", "operads"):
        root = tmp_path / command
        folder = root / "ctkr"
        folder.mkdir(parents=True)
        pl.DataFrame([{
            "subsystem_id": "ss:A", "symbol_id": node, "repo": "R",
            "qualified_name": f"R.{node}", "boundary_confidence": 1.0,
            "placement": "structural", "schema_version": 1,
        } for node in ("a", "b", "c")]).write_parquet(folder / "subsystem_members.parquet")
        pl.DataFrame([{
            "subsystem_id": "ss:A", "repo": "R", "role_id": f"role:{node}",
            "view": "orbit", "granularity": "exact", "cardinality": 1,
            "members": [node], "exemplar_symbol_id": node,
            "exemplar_qualified_name": f"R.{node}", "profile_centroid": [0.0],
            "profile_depth": 1, "interface_participation": ["provides"] if node == "a" else [],
            "persistence": 1.0, "config": "{}", "generated_at": stamp, "schema_version": 1,
        } for node in ("a", "b", "c")]).write_parquet(folder / "presentations.parquet")
        assert main([command, "--data-dir", str(root), "--view", "orbit", "--min-support", "1", "--generated-at", stamp, "--json"]) == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["n_operations"] > 0
        output = folder / "operads.parquet"
        artifacts.append(output.read_bytes())
        df = pl.read_parquet(output)
        assert df["view"].unique().to_list() == ["orbit"]
        assert "law_violations" in df.columns  # compatibility schema, not a theorem
        assert json.loads((folder / "manifest.json").read_text())["operads"] is True
    assert artifacts[0] == artifacts[1]
