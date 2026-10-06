"""``ctkr composition-patterns`` — observed per-subsystem role-path patterns.

``operads`` remains a compatibility command alias. Projects typed call/reference
paths onto role classes and keeps recurring patterns. Operad theory is research
inspiration; these patterns and diagnostics are not verified composition laws,
runtime ordering contracts, or categorical operads.

Reads the typed graph, ``subsystem_members.parquet`` and
``presentations.parquet``. Emits the unchanged ``operads.parquet`` schema and
manifest keys. Interface participation flags boundary patterns; it does not
establish protocol ordering. See :mod:`ctkr.operads` for the algorithm and
``docs/design/ct-subsystem-extraction.md`` §4.3 for research context.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import polars as pl

from ctkr.commands._common import add_common_flags, resolve_data_dir
from ctkr.graph_loader import load_graph


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "composition-patterns",
        aliases=["operads"],
        help="Find observed composition patterns (compatibility alias: operads).",
        description=(
            "Find each subsystem's observed composition patterns by "
            "projecting the subsystem's actual typed call/reference paths onto "
            "the T3 role classes and keeping recurring role-paths. Emits "
            "operads.parquet under <data_dir>/ctkr/ with three op_kind families: "
            "path (sequential composition), fan_in (n-ary combination), and "
            "non_operadic (legacy diagnostic label — missing_composite / "
            "back_call_cycle, not proven law violations). Operad theory is "
            "research inspiration, not a verified guarantee. The operads command "
            "alias and artifact/schema names remain unchanged. Boundary ops — any of whose roles is "
            "public in the T2 interface — are flagged is_boundary_op, without "
            "asserting runtime ordering or protocol guarantees. Requires "
            "`ctkr subsystems` (T1) and `ctkr roles` (T3) to have run first; "
            "reads interfaces.parquet participation via presentations. "
            "Deterministic: byte-identical re-runs for a fixed --generated-at."
        ),
    )
    add_common_flags(p)
    p.add_argument(
        "--view",
        type=str,
        default=None,
        choices=["orbit", "similarity", "both"],
        help="Which profile grouping to project through (default 'similarity', "
        "clustered profiles; legacy 'orbit' = exact-profile classes, not "
        "automorphism orbits; 'both' emits each).",
    )
    p.add_argument(
        "--min-support",
        type=int,
        default=None,
        help="A role-path must recur at least this many times to be an operation "
        "(default 2; raise to retain only more frequent patterns).",
    )
    p.add_argument(
        "--max-nodes",
        type=int,
        default=None,
        help="Longest role-path in nodes (default 3 = the role×role×role triple).",
    )
    p.add_argument(
        "--max-exemplars",
        type=int,
        default=None,
        help="Concrete qualified-name paths kept per operation (default 3).",
    )
    p.add_argument(
        "--generated-at",
        type=str,
        default=None,
        help="Fixed ISO-8601 timestamp to stamp on rows (for byte-identical "
        "re-runs). Default: now(). Does not affect operation_ids.",
    )
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    from ctkr.operads import (
        DEFAULT_MAX_EXEMPLARS,
        DEFAULT_MAX_PATH_NODES,
        DEFAULT_MIN_SUPPORT,
        DEFAULT_VIEW,
        compute_operads,
        write_manifest,
        write_operads,
    )

    data_dir = resolve_data_dir(args.data_dir)
    ctkr_dir = Path(data_dir) / "ctkr"
    mem_path = ctkr_dir / "subsystem_members.parquet"
    pres_path = ctkr_dir / "presentations.parquet"

    if not mem_path.exists():
        sys.stderr.write(
            f"ERROR: {mem_path} not found — run `ctkr subsystems` first (T1).\n"
        )
        return 2
    if not pres_path.exists():
        sys.stderr.write(
            f"ERROR: {pres_path} not found — run `ctkr roles` first (T3 is a "
            "prerequisite for composition patterns over role classes).\n"
        )
        return 2

    sys.stderr.write(f"loading graph from {data_dir}...\n")
    g = load_graph(data_dir)
    sys.stderr.write(
        f"  {g.number_of_nodes():,} nodes, {g.number_of_edges():,} edges\n"
    )
    if g.number_of_nodes() == 0:
        sys.stderr.write("ERROR: empty graph — nothing to recover.\n")
        return 1

    members = pl.read_parquet(mem_path)
    presentations = pl.read_parquet(pres_path)
    sys.stderr.write(
        f"loaded {members.height:,} members, {presentations.height:,} role rows\n"
    )

    view = args.view if args.view is not None else DEFAULT_VIEW
    min_support = args.min_support if args.min_support is not None else DEFAULT_MIN_SUPPORT
    max_nodes = args.max_nodes if args.max_nodes is not None else DEFAULT_MAX_PATH_NODES
    max_exemplars = (
        args.max_exemplars if args.max_exemplars is not None else DEFAULT_MAX_EXEMPLARS
    )

    df, stats = compute_operads(
        g,
        members,
        presentations,
        view=view,
        min_support=min_support,
        max_path_nodes=max_nodes,
        max_exemplars=max_exemplars,
        generated_at=args.generated_at,
    )

    ctkr_dir.mkdir(parents=True, exist_ok=True)
    write_operads(df, ctkr_dir / "operads.parquet")
    manifest_path = write_manifest(
        data_dir, n_operads=df.height, generated_at=args.generated_at
    )

    sys.stderr.write(
        "\n"
        f"  subsystems (with ops): {stats.n_subsystems}\n"
        f"  operations           : {stats.n_operations:,}\n"
        f"    path               : {stats.n_path_ops:,}\n"
        f"    fan_in             : {stats.n_fan_in_ops:,}\n"
        f"    non_operadic       : {stats.n_non_operadic:,} "
        f"(missing_composite {stats.n_missing_composite:,} / "
        f"back_call_cycle {stats.n_back_call_cycle:,})\n"
        f"  boundary (protocol)  : {stats.n_boundary_ops:,}\n"
        f"  unit-like roles      : {stats.n_unit_like_roles:,}\n"
        f"  composition rows     : {df.height:,}\n"
        f"  manifest             : {manifest_path}\n"
        f"  elapsed              : {stats.total_seconds}s\n"
    )
    if stats.truncated_subsystems:
        sys.stderr.write(
            f"  NOTE: path enumeration truncated for "
            f"{len(stats.truncated_subsystems)} subsystem-view(s) "
            "(support is a lower bound there): "
            f"{', '.join(stats.truncated_subsystems[:5])}"
            f"{' …' if len(stats.truncated_subsystems) > 5 else ''}\n"
        )

    if getattr(args, "as_json", False):
        sys.stdout.write(
            json.dumps(
                {
                    "n_subsystems": stats.n_subsystems,
                    "n_operations": stats.n_operations,
                    "n_path_ops": stats.n_path_ops,
                    "n_fan_in_ops": stats.n_fan_in_ops,
                    "n_non_operadic": stats.n_non_operadic,
                    "n_missing_composite": stats.n_missing_composite,
                    "n_back_call_cycle": stats.n_back_call_cycle,
                    "n_boundary_ops": stats.n_boundary_ops,
                    "n_unit_like_roles": stats.n_unit_like_roles,
                    "n_operad_rows": df.height,
                    "truncated_subsystems": stats.truncated_subsystems,
                    "per_subsystem": stats.per_subsystem,
                    "elapsed_seconds": stats.total_seconds,
                }
            )
            + "\n"
        )
    return 0
