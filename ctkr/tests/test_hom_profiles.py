"""Tests for ctkr.hom_profiles — per-symbol typed-edge profile vectors."""

from __future__ import annotations

import json
from pathlib import Path

import networkx as nx
import polars as pl

from ctkr.graph_loader import EDGE_KINDS
from ctkr.hom_profiles import (
    DIM_IDX,
    DIMS,
    NDIM,
    compute_hom_profiles,
    write_hom_profiles,
    write_manifest,
)
from ctkr.schema import (
    HOM_PROFILES_COLUMNS,
    SCHEMA_VERSION,
    ArtifactManifest,
    HomProfileRow,
)


def _toy_graph() -> nx.MultiDiGraph:
    """A graph mixing CONTAINS, CALLS, and a file→method CONTAINS edge.

    Layout::

        file:f1 ──CONTAINS──▶ method:m_a
        method:m_a ──CALLS──▶ method:m_b
        method:m_a ──CONTAINS──▶ method:m_b   (extra parallel edge of a different kind)
        method:m_b ──CALLS──▶ method:m_a
    """
    g = nx.MultiDiGraph()
    g.add_node("f1", repo="r", qualified_name="r.f1", kind="file")
    g.add_node("m_a", repo="r", qualified_name="r.f1.m_a", kind="method")
    g.add_node("m_b", repo="r", qualified_name="r.f1.m_b", kind="method")

    g.add_edge("f1", "m_a", key="CONTAINS", kind="CONTAINS")
    g.add_edge("m_a", "m_b", key="CALLS", kind="CALLS")
    g.add_edge("m_a", "m_b", key="CONTAINS", kind="CONTAINS")
    g.add_edge("m_b", "m_a", key="CALLS", kind="CALLS")
    return g


def test_ndim_matches_edge_kinds() -> None:
    assert NDIM == 2 * len(EDGE_KINDS)
    # First two dims belong to the first edge kind, in/out order.
    assert DIMS[0] == (EDGE_KINDS[0], "in")
    assert DIMS[1] == (EDGE_KINDS[0], "out")


def test_raw_counts_on_known_graph() -> None:
    g = _toy_graph()
    df, stats = compute_hom_profiles(g)

    assert df.height == 3
    assert stats.n_nodes_emitted == 3
    assert stats.n_edges == 4
    assert stats.profile_vec_dim == NDIM
    assert stats.kinds_filter == ()

    rows = {r["symbol_id"]: r for r in df.iter_rows(named=True)}
    contains_in = DIM_IDX[("CONTAINS", "in")]
    contains_out = DIM_IDX[("CONTAINS", "out")]
    calls_in = DIM_IDX[("CALLS", "in")]
    calls_out = DIM_IDX[("CALLS", "out")]

    # f1 only has a CONTAINS:out → m_a edge.
    f1_vec = rows["f1"]["profile_vec"]
    assert f1_vec[contains_out] == 1
    assert f1_vec[contains_in] == 0
    assert f1_vec[calls_in] == 0
    assert f1_vec[calls_out] == 0

    # m_a: CONTAINS:in from f1, CONTAINS:out to m_b, CALLS:out to m_b, CALLS:in from m_b.
    m_a_vec = rows["m_a"]["profile_vec"]
    assert m_a_vec[contains_in] == 1
    assert m_a_vec[contains_out] == 1
    assert m_a_vec[calls_in] == 1
    assert m_a_vec[calls_out] == 1

    # m_b: CONTAINS:in from m_a, CALLS:in from m_a, CALLS:out to m_a.
    m_b_vec = rows["m_b"]["profile_vec"]
    assert m_b_vec[contains_in] == 1
    assert m_b_vec[contains_out] == 0
    assert m_b_vec[calls_in] == 1
    assert m_b_vec[calls_out] == 1


def test_kinds_filter_drops_rows_but_preserves_neighbor_counts() -> None:
    """Filtering 'file' must NOT zero out the file→method CONTAINS edge."""
    g = _toy_graph()
    df, stats = compute_hom_profiles(g, kinds_filter={"file"})

    assert df.height == 2
    assert stats.kinds_filter == ("file",)
    ids = set(df["symbol_id"].to_list())
    assert ids == {"m_a", "m_b"}

    contains_in = DIM_IDX[("CONTAINS", "in")]
    m_a_row = next(r for r in df.iter_rows(named=True) if r["symbol_id"] == "m_a")
    # The CONTAINS:in count on m_a must still reflect the file→m_a edge.
    assert m_a_row["profile_vec"][contains_in] == 1


def test_kind_weights_default_unchanged() -> None:
    """No weights (and all-1.0 weights) must reproduce the raw-count path."""
    g = _toy_graph()
    df_base, stats_base = compute_hom_profiles(g)
    df_none, _ = compute_hom_profiles(g, kind_weights=None)
    df_ones, stats_ones = compute_hom_profiles(
        g, kind_weights={"CONTAINS": 1.0, "CALLS": 1.0}
    )

    assert df_base.equals(df_none)
    assert df_base.equals(df_ones)
    # An all-1.0 mapping is a no-op → stays on the integer/raw path.
    assert stats_base.weighted is False
    assert stats_ones.weighted is False
    assert stats_ones.kind_weights == ()
    assert df_base.schema["profile_vec"] == pl.List(pl.UInt32)


def test_kind_weight_zero_zeroes_dimension() -> None:
    """A weight of 0.0 must zero every dimension of that edge kind."""
    g = _toy_graph()
    df, stats = compute_hom_profiles(g, kind_weights={"CONTAINS": 0.0})

    assert stats.weighted is True
    assert stats.kind_weights == (("CONTAINS", 0.0),)
    # Weighted output is a Float64 variant, not raw UInt32.
    assert df.schema["profile_vec"] == pl.List(pl.Float64)

    contains_in = DIM_IDX[("CONTAINS", "in")]
    contains_out = DIM_IDX[("CONTAINS", "out")]
    calls_in = DIM_IDX[("CALLS", "in")]
    calls_out = DIM_IDX[("CALLS", "out")]
    rows = {r["symbol_id"]: r for r in df.iter_rows(named=True)}

    # Every CONTAINS dim is zeroed everywhere; CALLS dims are untouched.
    for vec in (rows["f1"], rows["m_a"], rows["m_b"]):
        assert vec["profile_vec"][contains_in] == 0.0
        assert vec["profile_vec"][contains_out] == 0.0
    # m_a keeps its CALLS counts (1 in, 1 out) unchanged.
    assert rows["m_a"]["profile_vec"][calls_in] == 1.0
    assert rows["m_a"]["profile_vec"][calls_out] == 1.0


def test_kind_weight_fractional_scales_correctly() -> None:
    """A fractional weight must scale exactly and leave other kinds alone."""
    g = _toy_graph()
    df_base, _ = compute_hom_profiles(g)
    df, stats = compute_hom_profiles(g, kind_weights={"CONTAINS": 0.25})

    assert stats.weighted is True
    assert stats.kind_weights == (("CONTAINS", 0.25),)

    contains_in = DIM_IDX[("CONTAINS", "in")]
    contains_out = DIM_IDX[("CONTAINS", "out")]
    calls_in = DIM_IDX[("CALLS", "in")]
    calls_out = DIM_IDX[("CALLS", "out")]

    base = {r["symbol_id"]: r["profile_vec"] for r in df_base.iter_rows(named=True)}
    weighted = {r["symbol_id"]: r["profile_vec"] for r in df.iter_rows(named=True)}

    for sid in ("f1", "m_a", "m_b"):
        assert weighted[sid][contains_in] == base[sid][contains_in] * 0.25
        assert weighted[sid][contains_out] == base[sid][contains_out] * 0.25
        # Non-weighted kinds are byte-identical to the raw counts.
        assert weighted[sid][calls_in] == base[sid][calls_in]
        assert weighted[sid][calls_out] == base[sid][calls_out]


def test_weighted_write_preserves_floats_and_manifest_records_weights(
    tmp_path: Path,
) -> None:
    """Weighted parquet stays Float64 (not truncated to UInt32) and the
    manifest records the weights so the artifact is self-describing."""
    g = _toy_graph()
    df, stats = compute_hom_profiles(g, kind_weights={"CONTAINS": 0.25})
    out = tmp_path / "hom_profiles.parquet"
    write_hom_profiles(df, out, weighted=stats.weighted)

    back = pl.read_parquet(out)
    assert back.schema["profile_vec"] == pl.List(pl.Float64)
    contains_out = DIM_IDX[("CONTAINS", "out")]
    f1 = next(r for r in back.iter_rows(named=True) if r["symbol_id"] == "f1")
    # f1 had CONTAINS:out == 1 → 0.25 after weighting; would be 0 if truncated.
    assert f1["profile_vec"][contains_out] == 0.25

    path = write_manifest(
        tmp_path,
        hom_profiles=True,
        n_hom_profiles=df.height,
        profile_vec_dim=NDIM,
        kind_weights=dict(stats.kind_weights),
    )
    m = ArtifactManifest.model_validate_json(path.read_text())
    assert m.kind_weights == {"CONTAINS": 0.25}


def test_output_is_deterministic() -> None:
    g = _toy_graph()
    df1, _ = compute_hom_profiles(g)
    df2, _ = compute_hom_profiles(g)
    assert df1.equals(df2)
    # Lexicographic ordering — f1 < m_a < m_b.
    assert df1["symbol_id"].to_list() == ["f1", "m_a", "m_b"]


def test_empty_kinds_filter_keeps_all() -> None:
    g = _toy_graph()
    df_none, _ = compute_hom_profiles(g, kinds_filter=None)
    df_empty, _ = compute_hom_profiles(g, kinds_filter=set())
    assert df_none.equals(df_empty)


def test_write_hom_profiles_roundtrip(tmp_path: Path) -> None:
    g = _toy_graph()
    df, _ = compute_hom_profiles(g)
    out = tmp_path / "hom_profiles.parquet"
    write_hom_profiles(df, out)

    back = pl.read_parquet(out)
    assert back.columns == list(HOM_PROFILES_COLUMNS)
    assert back.height == 3
    # UInt32 list dtype survives the round trip.
    assert back.schema["profile_vec"] == pl.List(pl.UInt32)
    for d in back.to_dicts():
        HomProfileRow.model_validate(d)


def test_write_hom_profiles_forces_uint32_on_disk(tmp_path: Path) -> None:
    """Maximal-precision contract: profile_vec is integer on disk regardless
    of in-memory dtype. A caller who happens to hand us a Float column still
    gets UInt32 in the parquet — no silent float-leakage downstream."""
    df = pl.DataFrame(
        {
            "symbol_id": ["s"],
            "repo": ["r"],
            "qualified_name": ["q"],
            "profile_vec": pl.Series(
                "profile_vec", [[1.0, 2.0]], dtype=pl.List(pl.Float64)
            ),
            "schema_version": [SCHEMA_VERSION],
        }
    )
    out = tmp_path / "from_float.parquet"
    write_hom_profiles(df, out)

    back = pl.read_parquet(out)
    assert back.schema["profile_vec"] == pl.List(pl.UInt32)
    assert back["profile_vec"][0].to_list() == [1, 2]


def test_write_manifest_creates_fresh(tmp_path: Path) -> None:
    path = write_manifest(
        tmp_path,
        hom_profiles=True,
        n_hom_profiles=42,
        profile_vec_dim=NDIM,
    )
    assert path == (tmp_path / "ctkr" / "manifest.json").resolve()
    data = json.loads(path.read_text())
    assert data["hom_profiles"] is True
    assert data["n_hom_profiles"] == 42
    assert data["profile_vec_dim"] == NDIM
    m = ArtifactManifest.model_validate(data)
    assert m.hom_profiles is True


def test_write_manifest_merges_without_clobbering(tmp_path: Path) -> None:
    """An existing manifest's unrelated presence flags must survive a merge."""
    ctkr_dir = tmp_path / "ctkr"
    ctkr_dir.mkdir()
    existing = ArtifactManifest(
        generated_at="2026-05-11T00:00:00Z",
        metacoding_data_dir=str(tmp_path),
        embeddings=True,
        n_symbols=300_000,
        embedding_dim=128,
    )
    (ctkr_dir / "manifest.json").write_text(existing.model_dump_json(indent=2))

    write_manifest(
        tmp_path,
        hom_profiles=True,
        n_hom_profiles=7,
        profile_vec_dim=NDIM,
    )

    merged = ArtifactManifest.model_validate_json(
        (ctkr_dir / "manifest.json").read_text()
    )
    assert merged.embeddings is True
    assert merged.n_symbols == 300_000
    assert merged.embedding_dim == 128
    assert merged.hom_profiles is True
    assert merged.n_hom_profiles == 7
    assert merged.profile_vec_dim == NDIM


def test_write_manifest_preserves_unknown_fields(tmp_path: Path) -> None:
    """A manifest written by a future schema version must round-trip
    through this version's write_manifest without losing fields."""
    ctkr_dir = tmp_path / "ctkr"
    ctkr_dir.mkdir()
    future_manifest = {
        "schema_version": 1,
        "generated_at": "2027-01-01T00:00:00Z",
        "metacoding_data_dir": str(tmp_path),
        "embeddings": True,
        "future_artifact": True,
        "n_future": 42,
        "future_meta": {"x": 1, "y": [1, 2, 3]},
    }
    (ctkr_dir / "manifest.json").write_text(json.dumps(future_manifest))

    write_manifest(
        tmp_path,
        hom_profiles=True,
        n_hom_profiles=7,
        profile_vec_dim=NDIM,
    )

    on_disk = json.loads((ctkr_dir / "manifest.json").read_text())
    assert on_disk["future_artifact"] is True
    assert on_disk["n_future"] == 42
    assert on_disk["future_meta"] == {"x": 1, "y": [1, 2, 3]}
    assert on_disk["hom_profiles"] is True
    assert on_disk["n_hom_profiles"] == 7


def _one_hop_identical_pair_graph() -> nx.MultiDiGraph:
    """Two methods that are byte-identical at 1 hop but differ at 2 hops.

    ``u`` and ``v`` each have exactly one ``CALLS:out`` edge → identical
    1-hop profiles. But ``u`` calls ``a`` (which itself calls ``c``, so
    ``a`` has ``CALLS:out=1``) while ``v`` calls ``b`` (a sink, ``CALLS:out=0``).
    Neighbor aggregation splits ``u`` from ``v`` via the ``(CALLS,out)``
    neighbor-mean block. This fixture demonstrates one resolvable profile tie,
    not an exact WL or automorphism-orbit computation.
    """
    g = nx.MultiDiGraph()
    for n in ("u", "v", "a", "b", "c"):
        g.add_node(n, repo="r", qualified_name=f"r.{n}", kind="method")
    g.add_edge("u", "a", key="CALLS", kind="CALLS")
    g.add_edge("v", "b", key="CALLS", kind="CALLS")
    g.add_edge("a", "c", key="CALLS", kind="CALLS")
    return g


def test_depth_default_is_one_and_unchanged() -> None:
    """depth=1 (default and explicit) reproduces the raw-count artifact."""
    g = _toy_graph()
    df_default, stats_default = compute_hom_profiles(g)
    df_one, stats_one = compute_hom_profiles(g, depth=1)

    assert stats_default.depth == 1
    assert stats_one.depth == 1
    assert stats_default.profile_vec_dim == NDIM
    assert df_default.equals(df_one)
    # Raw UInt32 path preserved.
    assert df_default.schema["profile_vec"] == pl.List(pl.UInt32)


def test_depth2_dim_and_dtype() -> None:
    g = _toy_graph()
    df, stats = compute_hom_profiles(g, depth=2)

    assert stats.depth == 2
    assert stats.profile_vec_dim == NDIM + NDIM * NDIM
    # Block means are fractional → a Float64 variant, never raw counts.
    assert df.schema["profile_vec"] == pl.List(pl.Float64)
    for row in df.iter_rows(named=True):
        assert len(row["profile_vec"]) == NDIM + NDIM * NDIM


def test_depth2_self_prefix_equals_one_hop() -> None:
    """The first NDIM dims of every depth-2 vector are the symbol's 1-hop
    profile verbatim (as floats)."""
    g = _toy_graph()
    df1, _ = compute_hom_profiles(g)
    df2, _ = compute_hom_profiles(g, depth=2)
    one = {r["symbol_id"]: r["profile_vec"] for r in df1.iter_rows(named=True)}
    two = {r["symbol_id"]: r["profile_vec"] for r in df2.iter_rows(named=True)}
    for sid, v1 in one.items():
        assert two[sid][:NDIM] == [float(x) for x in v1]


def test_depth2_splits_this_one_hop_profile_tie() -> None:
    """This pair has distinct neighbor means; other profile ties can remain."""
    g = _one_hop_identical_pair_graph()
    df1, _ = compute_hom_profiles(g, depth=1)
    df2, _ = compute_hom_profiles(g, depth=2)

    one = {r["symbol_id"]: r["profile_vec"] for r in df1.iter_rows(named=True)}
    two = {r["symbol_id"]: r["profile_vec"] for r in df2.iter_rows(named=True)}

    # Precondition: u and v are byte-identical at 1 hop.
    assert one["u"] == one["v"]
    # Depth 2 breaks the tie.
    assert two["u"] != two["v"]

    # Concretely: u's (CALLS,out) block mean = profile of a (CALLS:out=1),
    # v's = profile of b (CALLS:out=0). Check that exact dimension.
    calls_out = DIM_IDX[("CALLS", "out")]
    block_base = NDIM + calls_out * NDIM
    assert two["u"][block_base + calls_out] == 1.0  # a calls c
    assert two["v"][block_base + calls_out] == 0.0  # b is a sink


def test_depth2_block_mean_averages_multiple_neighbors() -> None:
    """A block with N neighbors emits the MEAN of their 1-hop profiles."""
    g = nx.MultiDiGraph()
    for n in ("s", "x", "y"):
        g.add_node(n, repo="r", qualified_name=f"r.{n}", kind="method")
    # s calls x and y. x has one further out-call (to y); y is a sink.
    g.add_edge("s", "x", key="CALLS", kind="CALLS")
    g.add_edge("s", "y", key="CALLS", kind="CALLS")
    g.add_edge("x", "y", key="CALLS", kind="CALLS")

    df, _ = compute_hom_profiles(g, depth=2)
    rows = {r["symbol_id"]: r["profile_vec"] for r in df.iter_rows(named=True)}
    calls_out = DIM_IDX[("CALLS", "out")]
    block_base = NDIM + calls_out * NDIM
    # neighbors of s via (CALLS,out) = {x, y}; x has CALLS:out=1, y has 0.
    # mean = 0.5.
    assert rows["s"][block_base + calls_out] == 0.5


def test_depth2_neighbor_mean_includes_excluded_kinds() -> None:
    """o7k invariant at depth 2: an excluded-kind neighbor still contributes
    its real 1-hop profile to the emitting symbol's block mean."""
    g = _toy_graph()  # f1 (file) --CONTAINS--> m_a
    df, _ = compute_hom_profiles(g, kinds_filter={"file"}, depth=2)
    rows = {r["symbol_id"]: r["profile_vec"] for r in df.iter_rows(named=True)}
    assert set(rows) == {"m_a", "m_b"}  # file row dropped

    contains_in = DIM_IDX[("CONTAINS", "in")]
    contains_out = DIM_IDX[("CONTAINS", "out")]
    # m_a reaches f1 via (CONTAINS,in); f1's 1-hop profile has CONTAINS:out=1.
    block_base = NDIM + contains_in * NDIM
    # neighbors of m_a via (CONTAINS,in) = {f1} only (single neighbor → mean=f1).
    assert rows["m_a"][block_base + contains_out] == 1.0


def test_depth2_deterministic() -> None:
    g = _one_hop_identical_pair_graph()
    df1, _ = compute_hom_profiles(g, depth=2)
    df2, _ = compute_hom_profiles(g, depth=2)
    assert df1.equals(df2)


def test_invalid_depth_raises() -> None:
    g = _toy_graph()
    for bad in (0, 3, -1):
        try:
            compute_hom_profiles(g, depth=bad)
        except ValueError:
            pass
        else:  # pragma: no cover
            raise AssertionError(f"depth={bad} should raise ValueError")


def test_depth2_write_roundtrip_and_manifest(tmp_path: Path) -> None:
    g = _toy_graph()
    df, stats = compute_hom_profiles(g, depth=2)
    out = tmp_path / "hom_profiles.parquet"
    write_hom_profiles(df, out, weighted=True)  # depth-2 is a Float64 variant

    back = pl.read_parquet(out)
    assert back.schema["profile_vec"] == pl.List(pl.Float64)
    assert len(back["profile_vec"][0].to_list()) == NDIM + NDIM * NDIM

    path = write_manifest(
        tmp_path,
        hom_profiles=True,
        n_hom_profiles=df.height,
        profile_vec_dim=stats.profile_vec_dim,
        profile_depth=stats.depth,
    )
    m = ArtifactManifest.model_validate_json(path.read_text())
    assert m.profile_depth == 2
    assert m.profile_vec_dim == NDIM + NDIM * NDIM


def test_write_manifest_default_depth_is_one(tmp_path: Path) -> None:
    path = write_manifest(
        tmp_path, hom_profiles=True, n_hom_profiles=1, profile_vec_dim=NDIM
    )
    m = ArtifactManifest.model_validate_json(path.read_text())
    assert m.profile_depth == 1


def test_write_manifest_overwrites_malformed(tmp_path: Path) -> None:
    ctkr_dir = tmp_path / "ctkr"
    ctkr_dir.mkdir()
    (ctkr_dir / "manifest.json").write_text("{not json")

    write_manifest(
        tmp_path,
        hom_profiles=True,
        n_hom_profiles=1,
        profile_vec_dim=NDIM,
    )
    merged = ArtifactManifest.model_validate_json(
        (ctkr_dir / "manifest.json").read_text()
    )
    assert merged.hom_profiles is True


def test_equal_profiles_do_not_establish_automorphism_orbits() -> None:
    """The documented 3-cycle/4-cycle collision at both supported depths.

    An automorphism cannot exchange their differently sized connected
    components. Identical vectors therefore certify profile equality only.
    """
    graph = nx.MultiDiGraph()
    for prefix, size in (("triangle", 3), ("square", 4)):
        for i in range(size):
            node = f"{prefix}{i}"
            graph.add_node(node, repo="r", qualified_name=node, kind="function")
            graph.add_edge(
                node, f"{prefix}{(i + 1) % size}", key="CALLS", kind="CALLS"
            )
    assert sorted(len(c) for c in nx.weakly_connected_components(graph)) == [3, 4]
    for depth in (1, 2):
        frame, _ = compute_hom_profiles(graph, depth=depth)
        profiles = {tuple(v) for v in frame["profile_vec"].to_list()}
        assert frame.height == 7
        assert len(profiles) == 1
