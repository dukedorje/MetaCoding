"""``ctkr roles`` — per-subsystem role inventory (Stage C / §4.1, T3).

Group each subsystem's members by depth-1 structural profiles, emitting both
exact-profile classes (legacy view name ``orbit``, not automorphism orbits) and
similarity clusters to ``presentations.parquet`` under ``<data_dir>/ctkr/``
and merging the presence flags into ``manifest.json``.

Reads ``hom_profiles.parquet`` (should be depth-1 — the role-*surfacing* dial;
``--kinds-filter file`` recommended upstream) + ``subsystem_members.parquet``
(T1) and, when present, ``interfaces.parquet`` (T2) for interface participation.

See :mod:`ctkr.presentations` for the algorithm and
``docs/design/ct-subsystem-extraction.md`` §4.1 for the design.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import polars as pl

from ctkr.commands._common import add_common_flags, resolve_data_dir


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "roles",
        help="Per-subsystem role inventory (exact-profile classes + similarity clusters).",
        description=(
            "Group each subsystem's members using depth-1 structural profiles. "
            "Equal profiles do not establish structural or behavioral equivalence. "
            "Emits presentations.parquet under <data_dir>/ctkr/ with two views "
            "per subsystem: orbit (legacy name for exact-profile classes) and "
            "similarity (cosine-threshold connected components at a default "
            "threshold, with a threshold sweep for per-class persistence). Each "
            "class carries members, structural-profile centroid, an exemplar (member "
            "nearest the centroid), cardinality, and interface participation "
            "(from interfaces.parquet if present). Deterministic: byte-identical "
            "re-runs for a fixed --generated-at."
        ),
    )
    add_common_flags(p)
    p.add_argument(
        "--threshold",
        type=float,
        default=None,
        help="Default cosine threshold the similarity view is cut at "
        "(default 0.90; higher = more, finer role classes).",
    )
    p.add_argument(
        "--sweep",
        type=str,
        default=None,
        help="Comma-separated cosine-threshold sweep for similarity persistence "
        "(default '0.80,0.85,0.90,0.95,0.99'). The default threshold is always "
        "unioned in.",
    )
    p.add_argument(
        "--generated-at",
        type=str,
        default=None,
        help="Fixed ISO-8601 timestamp to stamp on rows (for byte-identical "
        "re-runs). Default: now(). Does not affect role_ids.",
    )
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    from ctkr.presentations import (
        DEFAULT_SWEEP,
        DEFAULT_THRESHOLD,
        compute_role_inventory,
        write_manifest,
        write_presentations,
    )

    data_dir = resolve_data_dir(args.data_dir)
    ctkr_dir = Path(data_dir) / "ctkr"
    hp_path = ctkr_dir / "hom_profiles.parquet"
    mem_path = ctkr_dir / "subsystem_members.parquet"
    iface_path = ctkr_dir / "interfaces.parquet"

    if not hp_path.exists():
        sys.stderr.write(
            f"ERROR: {hp_path} not found — run `ctkr structural-profiles` first "
            "(depth 1, --kinds-filter file recommended).\n"
        )
        return 2
    if not mem_path.exists():
        sys.stderr.write(
            f"ERROR: {mem_path} not found — run `ctkr subsystems` first (T1).\n"
        )
        return 2

    hom_profiles = pl.read_parquet(hp_path)
    members = pl.read_parquet(mem_path)
    interfaces = pl.read_parquet(iface_path) if iface_path.exists() else None
    sys.stderr.write(
        f"loaded {hom_profiles.height:,} profiles, {members.height:,} members"
        + (f", {interfaces.height:,} interface rows" if interfaces is not None else ", no interfaces.parquet")
        + "\n"
    )

    threshold = args.threshold if args.threshold is not None else DEFAULT_THRESHOLD
    if args.sweep:
        try:
            sweep = [float(x) for x in args.sweep.split(",") if x.strip()]
        except ValueError:
            sys.stderr.write(f"ERROR: --sweep must be comma-separated floats, got {args.sweep!r}\n")
            return 2
        if not sweep:
            sys.stderr.write("ERROR: --sweep is empty.\n")
            return 2
    else:
        sweep = list(DEFAULT_SWEEP)

    df, stats = compute_role_inventory(
        hom_profiles,
        members,
        interfaces,
        default_threshold=threshold,
        sweep=sweep,
        generated_at=args.generated_at,
    )

    ctkr_dir.mkdir(parents=True, exist_ok=True)
    write_presentations(df, ctkr_dir / "presentations.parquet")
    manifest_path = write_manifest(
        data_dir, n_presentations=df.height, generated_at=args.generated_at
    )

    sys.stderr.write(
        "\n"
        f"  subsystems          : {stats.n_subsystems}\n"
        f"  members (profiled)  : {stats.n_members_profiled:,}\n"
        f"  members (no profile): {stats.n_members_no_profile:,} (NL-only floor)\n"
        f"  roles (exact-profile/orbit): {stats.n_roles_orbit:,}  "
        f"compression {stats.compression_orbit:.2f}x\n"
        f"  roles (similarity)  : {stats.n_roles_similarity:,}  "
        f"compression {stats.compression_similarity:.2f}x\n"
        f"  presentation rows   : {df.height:,}\n"
        f"  manifest            : {manifest_path}\n"
        f"  elapsed             : {stats.total_seconds}s\n"
    )

    if getattr(args, "as_json", False):
        sys.stdout.write(
            json.dumps(
                {
                    "n_subsystems": stats.n_subsystems,
                    "n_members_profiled": stats.n_members_profiled,
                    "n_members_no_profile": stats.n_members_no_profile,
                    "n_roles_orbit": stats.n_roles_orbit,
                    "n_roles_similarity": stats.n_roles_similarity,
                    "compression_orbit": stats.compression_orbit,
                    "compression_similarity": stats.compression_similarity,
                    "n_presentation_rows": df.height,
                    "elapsed_seconds": stats.total_seconds,
                }
            )
            + "\n"
        )
    return 0
