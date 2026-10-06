"""``ctkr role-gaps`` — family-scoped role-equivalence sweep + idiom filter (MetaCoding-034).

Deterministic, LM-free. Scopes symbols to one module family, buckets their
hom-profiles into role classes (the existing label-roles deterministic core),
tags classes framework-idiom vs domain via boundary-quality's member
classification (the F6 idiom filter), and emits the DOMAIN classes recurring
across >= k features that no glossary term maps to — the machine-readable gap
list feeding ``propose-terms``.

The data-dir is treated as READ-ONLY: derived output goes wherever ``--out``
points (required); a fresh hom-profile compute stays in memory unless
``--profiles-out`` names a scratch path.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ctkr.commands._common import add_common_flags, resolve_data_dir


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "role-gaps",
        help="Recurring domain role classes with no glossary term (MetaCoding-034).",
        description=(
            "Family-scoped role-equivalence sweep with the framework-idiom "
            "filter: structural-profile classes recurring across >= k features, "
            "tagged framework-vs-domain, checked against the explicit "
            "glossary-term mapping. Emits role-classes JSONL (one role_class "
            "record per class + one trailing summary record). LM-free."
        ),
    )
    add_common_flags(p)
    p.add_argument(
        "--family",
        required=True,
        help="Module family to scope to, e.g. 'log' -> modules/log/.",
    )
    p.add_argument(
        "-k",
        "--min-features",
        dest="k",
        type=int,
        default=2,
        help="Minimum distinct features a class must recur across (default 2).",
    )
    p.add_argument(
        "--granularity-k",
        type=int,
        default=None,
        help="Bucket granularity for role-class equality (default: label-roles' "
        "DEFAULT_GRANULARITY).",
    )
    p.add_argument(
        "--min-class-size",
        type=int,
        default=2,
        help="Drop role classes with fewer members (default 2).",
    )
    p.add_argument(
        "--out",
        required=True,
        help="Output JSONL path (REQUIRED — never defaults into the data-dir; "
        "the graph sandbox stays read-only).",
    )
    p.add_argument(
        "--profiles",
        default=None,
        help="Explicit hom_profiles.parquet to reuse. Default: "
        "<data_dir>/ctkr/hom_profiles.parquet when present, else compute "
        "in-memory from the graph.",
    )
    p.add_argument(
        "--profiles-out",
        default=None,
        help="When computing profiles fresh, also write them to this scratch "
        "path for reuse (never written into the data-dir).",
    )
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    import polars as pl

    from ctkr.graph_loader import load_graph
    from ctkr.hom_profiles import compute_hom_profiles, write_hom_profiles
    from ctkr.label_roles import DEFAULT_GRANULARITY
    from ctkr.role_gaps import class_record, role_gaps

    data_dir = resolve_data_dir(getattr(args, "data_dir", None))
    sys.stderr.write(f"loading graph from {data_dir}...\n")
    g = load_graph(data_dir)
    sys.stderr.write(
        f"  {g.number_of_nodes():,} nodes, {g.number_of_edges():,} edges\n"
    )
    if g.number_of_nodes() == 0:
        sys.stderr.write("ERROR: empty graph.\n")
        return 1

    # Hom-profiles: reuse the canonical parquet when present, else compute.
    prof_path = (
        Path(args.profiles).expanduser().resolve()
        if args.profiles
        else data_dir / "ctkr" / "hom_profiles.parquet"
    )
    if prof_path.exists():
        profiles_df = pl.read_parquet(prof_path)
        profiles_source = str(prof_path)
        sys.stderr.write(f"  reusing hom-profiles: {prof_path} ({profiles_df.height:,} rows)\n")
    else:
        sys.stderr.write("  no hom_profiles.parquet — computing in-memory\n")
        profiles_df, _stats = compute_hom_profiles(g, kinds_filter={"file"})
        profiles_source = "(computed in-memory, kinds_filter=file)"
        if args.profiles_out:
            scratch = Path(args.profiles_out).expanduser().resolve()
            write_hom_profiles(profiles_df, scratch)
            profiles_source += f"; written to {scratch}"
            sys.stderr.write(f"  wrote fresh profiles to scratch: {scratch}\n")

    granularity_k = (
        int(args.granularity_k) if args.granularity_k else DEFAULT_GRANULARITY
    )
    result = role_gaps(
        g,
        profiles_df,
        family=args.family,
        k=int(args.k),
        granularity_k=granularity_k,
        min_cluster_size=int(args.min_class_size),
    )

    out = Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    summary = result.summary()
    summary["data_dir"] = str(data_dir)
    summary["profiles_source"] = profiles_source
    with out.open("w", encoding="utf-8") as f:
        for rep in result.classes:
            f.write(json.dumps(class_record(rep), sort_keys=False) + "\n")
        f.write(json.dumps(summary) + "\n")

    if getattr(args, "as_json", False):
        sys.stdout.write(json.dumps({**summary, "output": str(out)}) + "\n")
        return 0

    print(f"\n  family              : {result.family} (modules/{result.family}/)")
    print(f"  scoped symbols      : {result.n_scoped_symbols}")
    print(f"  features            : {result.n_features}")
    print(f"  role classes        : {result.n_classes} (granularity_k={granularity_k})")
    print(f"  framework-idiom     : {result.n_framework_idiom}")
    print(f"  domain              : {result.n_domain}")
    print(f"  recurring domain    : {result.n_recurring_domain} (k={result.k})")
    print(f"  glossary gaps       : {result.n_gaps}")
    print(f"  output              : {out}")
    gaps = [r for r in result.classes if r.candidate is not None]
    if gaps:
        print("\n  gap classes (domain, recurring, unnamed):")
        for r in gaps:
            names = ", ".join(n.split("::")[-1] for n in r.member_names[:4])
            more = f" (+{len(r.members) - 4})" if len(r.members) > 4 else ""
            print(
                f"    {r.class_id}  features={len(r.features)} "
                f"members={len(r.members)}  {names}{more}"
            )
    return 0
