"""``ctkr structural-profiles`` — emit legacy ``hom_profiles.parquet``.

``hom-profiles`` remains a compatibility command alias. These typed-edge
profiles measure structural similarity, not categorical or behavioral equivalence.

Computes per-symbol typed-edge profile vectors and writes them as a
parquet table at maximal precision (raw UInt32 counts, no quantisation).
See :mod:`ctkr.hom_profiles` for the algorithm; this module is a thin
CLI wrapper.

The ``--kinds-filter`` flag implements the resolution to MetaCoding-o7k
(closed 2026-06-02 → option A): exclude listed ``Symbol.kind`` values
from the output without rebalancing edge counts on the surviving
endpoints. Common usage: ``--kinds-filter file`` to drop file-node
rows whose hom-profiles are dominated by ``CONTAINS:in=1.0``.

The ``--kind-weight KIND=W`` flag (repeatable, MetaCoding-23q.1
weighting variant) scales an edge kind's profile dimensions by a float
before write — e.g. ``--kind-weight CONTAINS=0.25`` to down-weight the
directory/containment scaffolding so role discrimination emphasizes
typed-edge structure rather than the folder tree, not behavioral equivalence. Weighting turns the vector into
a Float64 variant (no longer raw UInt32 counts); the weights are
recorded in the manifest's ``kind_weights`` field.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from ctkr.commands._common import add_common_flags, resolve_data_dir
from ctkr.graph_loader import EDGE_KINDS, load_graph
from ctkr.hom_profiles import (
    compute_hom_profiles,
    write_hom_profiles,
    write_manifest,
)


def _parse_kind_weights(
    raw: list[str] | None,
) -> dict[str, float]:
    """Parse repeated ``KIND=W`` flags into a ``{kind: weight}`` dict.

    Raises ``ValueError`` on malformed entries, non-float weights,
    negative weights, or unknown edge kinds (typo protection — an
    unrecognised kind would silently no-op otherwise).
    """
    weights: dict[str, float] = {}
    for item in raw or []:
        if "=" not in item:
            raise ValueError(
                f"--kind-weight expects KIND=W, got {item!r} (no '=')."
            )
        kind, _, val = item.partition("=")
        kind = kind.strip()
        try:
            weight = float(val.strip())
        except ValueError as exc:
            raise ValueError(
                f"--kind-weight weight for {kind!r} is not a float: {val!r}."
            ) from exc
        if weight < 0.0:
            raise ValueError(
                f"--kind-weight for {kind!r} must be >= 0, got {weight}."
            )
        if kind not in EDGE_KINDS:
            raise ValueError(
                f"--kind-weight kind {kind!r} is not a known edge kind. "
                f"Valid kinds: {', '.join(EDGE_KINDS)}."
            )
        weights[kind] = weight
    return weights


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "structural-profiles",
        aliases=["hom-profiles"],
        help="Compute structural profiles → hom_profiles.parquet (compatibility alias: hom-profiles).",
        description=(
            "Compute per-symbol typed-edge profile vectors and write them as "
            "<data_dir>/ctkr/hom_profiles.parquet at maximal precision (raw "
            "integer counts; no L1-normalisation, no quantisation). "
            "hom-profiles is a compatibility alias; artifact and schema names "
            "remain unchanged. Profiles measure structural similarity, not "
            "categorical or behavioral equivalence. "
            "Implements MetaCoding-23q.1; see docs/notes/entropy-as-dial.md "
            "for the granularity-as-query-time-knob framing."
        ),
    )
    add_common_flags(p)
    p.add_argument(
        "--kinds-filter",
        action="append",
        default=None,
        metavar="KIND",
        help=(
            "Symbol kind to EXCLUDE from the output (repeatable). Edges "
            "incident to excluded symbols still increment their surviving "
            "neighbors' counts. Common usage: --kinds-filter file."
        ),
    )
    p.add_argument(
        "--kind-weight",
        action="append",
        default=None,
        metavar="KIND=W",
        help=(
            "Scale an edge kind's profile dimensions by float W (repeatable). "
            "Unspecified kinds default to 1.0. Weighting produces a Float64 "
            "variant (not raw counts); weights are recorded in the manifest. "
            "Example: --kind-weight CONTAINS=0.25 to down-weight containment "
            "scaffolding."
        ),
    )
    p.add_argument(
        "--depth",
        type=int,
        default=1,
        choices=(1, 2),
        help=(
            "Neighborhood depth of the profile. 1 (default) = raw per-symbol "
            "typed-edge counts (byte-identical to the historical artifact). "
            "2 = WL-inspired neighbor-mean expansion, not exact Weisfeiler-Leman "
            "refinement: each symbol's 1-hop vector concatenated with, per "
            "(edge_kind,direction) block, the mean 1-hop vector of neighbors "
            "reached via that block. This lossy signature splits "
            "some depth-1 exact-profile classes (alignment seeds); this does not "
            "identify automorphism orbits or prove equivalence. Depth-2 "
            "output is a Float64 variant of NDIM+NDIM*NDIM dims."
        ),
    )
    p.add_argument(
        "--out",
        default=None,
        help="Output path. Default: <data_dir>/ctkr/hom_profiles.parquet.",
    )
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    start = time.perf_counter()
    data_dir = resolve_data_dir(args.data_dir)
    sys.stderr.write(f"loading graph from {data_dir}...\n")
    g = load_graph(data_dir)
    sys.stderr.write(
        f"  {g.number_of_nodes():,} nodes, {g.number_of_edges():,} edges\n"
    )

    if g.number_of_nodes() == 0:
        sys.stderr.write("ERROR: empty graph — nothing to compute.\n")
        return 1

    kinds_filter = set(args.kinds_filter) if args.kinds_filter else None
    try:
        kind_weights = _parse_kind_weights(args.kind_weight)
    except ValueError as exc:
        sys.stderr.write(f"ERROR: {exc}\n")
        return 2
    filter_label = sorted(kinds_filter) if kinds_filter else "(none)"
    weights_label = (
        ", ".join(f"{k}={w}" for k, w in sorted(kind_weights.items()))
        if kind_weights
        else "(none)"
    )
    depth = int(getattr(args, "depth", 1))
    sys.stderr.write(
        f"computing structural profiles (kinds_filter={filter_label}, "
        f"kind_weights={weights_label}, depth={depth})...\n"
    )
    df, stats = compute_hom_profiles(
        g, kinds_filter=kinds_filter, kind_weights=kind_weights, depth=depth
    )

    # Depth-2 profiles carry fractional block means → Float64, exactly like
    # the weighted variant. Either condition forces the non-raw write path.
    float_output = stats.weighted or stats.depth > 1

    canonical_out = (data_dir / "ctkr" / "hom_profiles.parquet").resolve()
    out = Path(args.out).expanduser().resolve() if args.out else canonical_out
    sys.stderr.write(f"writing {df.height:,} rows to {out}...\n")
    write_hom_profiles(df, out, weighted=float_output)

    # Record the weights used (None on the raw-count path) so the artifact
    # is self-describing and never confused with maximal-precision counts.
    manifest_kind_weights = dict(stats.kind_weights) if stats.weighted else None

    # Skip manifest update when --out points outside the canonical path;
    # the manifest's "artifact present" promise must match where it lives.
    if out == canonical_out:
        manifest_path: Path | None = write_manifest(
            data_dir,
            hom_profiles=True,
            n_hom_profiles=df.height,
            profile_vec_dim=stats.profile_vec_dim,
            kind_weights=manifest_kind_weights,
            profile_depth=stats.depth,
        )
    else:
        manifest_path = None
        sys.stderr.write(
            f"  note: --out points outside {canonical_out.parent}; "
            "skipping manifest.json update to avoid desync.\n"
        )

    elapsed = round(time.perf_counter() - start, 3)
    filter_desc = (
        ",".join(sorted(kinds_filter)) if kinds_filter else "(none)"
    )
    manifest_desc = str(manifest_path) if manifest_path else "(skipped — non-canonical --out)"
    weights_desc = weights_label
    if stats.depth > 1:
        precision_desc = f"Float64 (depth-{stats.depth} neighbor-mean variant)"
    elif stats.weighted:
        precision_desc = "Float64 (weighted variant)"
    else:
        precision_desc = "UInt32 (raw counts)"
    sys.stderr.write(
        "\n"
        f"  rows            : {df.height:,}\n"
        f"  profile_vec_dim : {stats.profile_vec_dim}\n"
        f"  depth           : {stats.depth}\n"
        f"  kinds_filter    : {filter_desc}\n"
        f"  kind_weights    : {weights_desc}\n"
        f"  precision       : {precision_desc}\n"
        f"  output          : {out}\n"
        f"  manifest        : {manifest_desc}\n"
        f"  elapsed         : {elapsed}s (compute {stats.elapsed_seconds}s)\n"
    )

    if getattr(args, "as_json", False):
        import json

        sys.stdout.write(
            json.dumps(
                {
                    "rows": df.height,
                    "profile_vec_dim": stats.profile_vec_dim,
                    "depth": stats.depth,
                    "kinds_filter": sorted(kinds_filter) if kinds_filter else [],
                    "kind_weights": dict(stats.kind_weights),
                    "weighted": stats.weighted,
                    "output": str(out),
                    "manifest": str(manifest_path) if manifest_path else None,
                    "elapsed_seconds": elapsed,
                }
            )
            + "\n"
        )
    return 0
