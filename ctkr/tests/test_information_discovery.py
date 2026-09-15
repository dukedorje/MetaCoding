"""Property tests for conservative information discovery; no live services."""

from __future__ import annotations

import json
from pathlib import Path

import networkx as nx
import pytest

from ctkr.graph_loader import INFORMATION_DOMAIN, load_graph
from ctkr.information_discovery import discover, main


def graph() -> nx.MultiDiGraph:
    g = nx.MultiDiGraph()
    g.graph["domain_profile"] = INFORMATION_DOMAIN
    for n in ("a", "b", "c", "d"):
        g.add_node(n, kind="page", title="same words do not matter")
    for n in ("x", "y"):
        g.add_node(n, kind="entity.person")
    for n in ("a", "b"):
        for neighbor in ("x", "y"):
            g.add_edge(
                n,
                neighbor,
                key="MENTIONS",
                kind="MENTIONS",
                provenance={"file": f"{n}.md"},
                confidence=0.8,
            )
    return g


def test_raw_witnesses_and_rank():
    g = graph()
    result = discover(g)
    assert result["n_candidates_total"] == 2  # page pair and the co-mentioned entity pair
    candidate = next(c for c in result["candidates"] if c["left"] == "a")
    assert (candidate["left"], candidate["right"]) == ("a", "b")
    assert candidate["score"] == 0.5
    assert candidate["id"].startswith("ctkr-i-")
    assert all(c.isalnum() or c in "_-" for c in candidate["id"])
    assert {f["neighbor"] for f in candidate["shared_features"]} == {"x", "y"}
    assert len(candidate["evidence"]) == 4
    for edge in candidate["evidence"]:
        assert edge["provenance"] == {"file": f"{edge['src_id']}.md"}
        assert g.has_edge(edge["src_id"], edge["dst_id"], edge["kind"])


def test_topology_not_names_and_deterministic_order():
    g = graph()
    expected = discover(g)
    reversed_graph = nx.MultiDiGraph()
    reversed_graph.graph.update(g.graph)
    reversed_graph.add_nodes_from(reversed(list(g.nodes(data=True))))
    reversed_graph.add_edges_from(reversed(list(g.edges(keys=True, data=True))))
    assert discover(reversed_graph) == expected
    for n in g:
        g.nodes[n]["title"] = n + " unrelated different text"
    assert discover(g) == expected
    assert discover(g, limit=1)["candidates"] == expected["candidates"][:1]
    assert discover(g, limit=0)["candidates"] == []


@pytest.mark.parametrize("reverse", [False, True])
def test_existing_links_block_even_when_derived(reverse):
    g = graph()
    a, b = ("b", "a") if reverse else ("a", "b")
    g.add_edge(a, b, kind="LINKS_TO", derived=True)
    assert not any(c["left"] == "a" for c in discover(g)["candidates"])


def test_two_distinct_neighbors_not_parallel_edge_count():
    g = graph()
    g.remove_node("y")
    for n in ("a", "b"):
        g.add_edge(n, "x", key="ABOUT", kind="ABOUT")
    assert discover(g)["candidates"] == []


@pytest.mark.parametrize("mutation", ["direction", "type", "scaffold", "generated"])
def test_mismatched_or_untrusted_edges_are_not_evidence(mutation):
    g = graph()
    g.remove_edge("b", "y", "MENTIONS")
    if mutation == "direction":
        g.add_edge("y", "b", key="MENTIONS", kind="MENTIONS")
    elif mutation == "type":
        g.add_edge("b", "y", key="ABOUT", kind="ABOUT")
    elif mutation == "scaffold":
        g.add_edge("b", "y", key="CONTAINS", kind="CONTAINS")
    else:
        g.add_edge("b", "y", key="MENTIONS", kind="MENTIONS", generated_by="cartographer")
    assert discover(g)["candidates"] == []


@pytest.mark.parametrize(
    "attrs",
    [
        {"generated": True},
        {"derived": True},
        {"generated_by": "archivist-cartographer-v1"},
        {"qualified_name": "notes/suggested-link-abc"},
        {"file": "/vault/notes/constitution.md"},
        {"qualified_name": "notes/recipes"},
        {"administrative": True},
        {"tags": ["ctkr-generated"]},
    ],
)
def test_excluded_nodes_cannot_be_endpoints_or_witnesses(attrs):
    g = graph()
    g.nodes["a"].update(attrs)
    assert discover(g)["candidates"] == []
    g = graph()
    g.nodes["x"].update(attrs)
    assert discover(g)["candidates"] == []


def test_generated_edge_provenance_and_metadata_survive_loader(tmp_path):
    g = graph()
    write_export(tmp_path, g)
    edges = [json.loads(line) for line in (tmp_path / "edges.jsonl").read_text().splitlines()]
    edges[0]["generated_by"] = "archivist-cartographer-v1"
    (tmp_path / "edges.jsonl").write_text("".join(json.dumps(e) + "\n" for e in edges))
    loaded = load_graph(tmp_path)
    assert discover(loaded)["candidates"] == []


def write_export(out: Path, g: nx.MultiDiGraph):
    (out / "manifest.json").write_text(json.dumps({"domain": {"name": "information"}}))
    (out / "nodes.jsonl").write_text(
        "".join(json.dumps({"id": n, **a}) + "\n" for n, a in g.nodes(data=True))
    )
    (out / "edges.jsonl").write_text(
        "".join(
            json.dumps({"src_id": s, "dst_id": d, **a}) + "\n" for s, d, a in g.edges(data=True)
        )
    )


def test_cli_empty_errors_and_input_protection(tmp_path):
    write_export(tmp_path, graph())
    out = tmp_path / "proposals.json"
    assert main(["--data-dir", str(tmp_path), "--out", str(out), "--limit", "1"]) == 0
    result = json.loads(out.read_text())
    assert len(result["candidates"]) == 1
    before = (tmp_path / "nodes.jsonl").read_bytes()
    with pytest.raises(SystemExit):
        main(["--data-dir", str(tmp_path), "--out", str(tmp_path / "nodes.jsonl")])
    assert (tmp_path / "nodes.jsonl").read_bytes() == before
    hardlink = tmp_path / "hardlink.json"
    hardlink.hardlink_to(tmp_path / "nodes.jsonl")
    with pytest.raises(SystemExit):
        main(["--data-dir", str(tmp_path), "--out", str(hardlink)])
    assert hardlink.read_bytes() == before
    with pytest.raises(SystemExit):
        main(["--data-dir", str(tmp_path), "--out", str(out), "--limit", "-1"])
    assert discover(nx.MultiDiGraph())["candidates"] == []


def test_hub_support_is_less_than_rare_support():
    g = graph()
    baseline = discover(g)["candidates"][0]["score"]
    for neighbor in ("x", "y"):
        g.add_edge("c", neighbor, key="MENTIONS", kind="MENTIONS")
    candidate = next(c for c in discover(g)["candidates"] if c["left"] == "a")
    assert 0 < candidate["score"] < baseline


def test_duplicate_raw_witnesses_fail_closed_in_both_orders(tmp_path):
    g = graph()
    g.add_edge("a", "x", key="second", kind="MENTIONS", provenance="other")
    with pytest.raises(ValueError, match="duplicate typed edge"):
        discover(g)
    g = graph()
    write_export(tmp_path, g)
    path = tmp_path / "edges.jsonl"
    rows = path.read_text().splitlines()
    duplicate = json.loads(rows[0])
    duplicate["generated_by"] = "archivist-cartographer-v1"
    for records in ([json.dumps(duplicate), *rows], [*rows, json.dumps(duplicate)]):
        path.write_text("\n".join(records) + "\n")
        with pytest.raises(ValueError, match="Duplicate information edge"):
            load_graph(tmp_path)


def test_mixed_case_admin_note_is_excluded():
    g = graph()
    g.nodes["a"]["file"] = "/vault/Notes/Constitution.md"
    assert discover(g)["candidates"] == []
