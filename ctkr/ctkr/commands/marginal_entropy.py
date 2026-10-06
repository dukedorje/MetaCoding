"""``ctkr marginal-entropy`` — per-edge-kind marginal contribution to hom-profile entropy.

Bead MetaCoding-ijo.3. For each EdgeKind in the graph, computes the
marginal contribution to hom-profile Shannon entropy by leave-one-out
ablation: zero out all dimensions belonging to that edge kind, recompute
the profile distribution and its Shannon entropy, and report the delta
(baseline - ablated). A large positive delta means the edge kind is
important for discriminating roles; near-zero means it adds little signal.

Output: a ranked table of edge kinds by entropy delta (descending).
"""

from __future__ import annotations

import argparse
import collections
import math
import sys
from typing import Any

from ctkr.commands._common import (
    add_common_flags,
    add_kind_weight_flag,
    parse_kind_weights,
    resolve_data_dir,
)
from ctkr.graph_loader import EDGE_KINDS, load_graph
from ctkr.hom_profiles import DIM_IDX, NDIM


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "marginal-entropy",
        help="Per-edge-kind contribution to structural-profile entropy (leave-one-out ablation).",
        description=(
            "For each edge kind, zero out its structural-profile dimensions and recompute "
            "Shannon entropy. Reports the entropy delta (baseline - ablated) ranked "
            "by importance. Positive delta = that kind helps discriminate roles."
        ),
    )
    add_common_flags(p)
    add_kind_weight_flag(p)
    p.set_defaults(func=run)


def _shannon_entropy(profile_counts: collections.Counter[tuple[float, ...]], n: int) -> float:
    """Shannon entropy of a discrete distribution given a Counter of profile tuples."""
    h = 0.0
    for cnt in profile_counts.values():
        p = cnt / n
        if p > 0:
            h -= p * math.log2(p)
    return h


def _l1_normalize(vec: list[int]) -> tuple[float, ...]:
    total = sum(vec)
    if total == 0:
        return tuple(0.0 for _ in vec)
    return tuple(v / total for v in vec)


def run(args: argparse.Namespace) -> int:
    data_dir = resolve_data_dir(args.data_dir)
    sys.stderr.write(f"loading graph from {data_dir}...\n")
    g = load_graph(data_dir)
    n_nodes = g.number_of_nodes()
    n_edges = g.number_of_edges()
    sys.stderr.write(f"  {n_nodes:,} nodes, {n_edges:,} edges\n")

    if n_nodes == 0:
        sys.stderr.write("ERROR: empty graph — nothing to analyse.\n")
        return 1

    # ── 1. Compute hom-profiles ──────────────────────────────────────────────
    try:
        kind_weights = parse_kind_weights(getattr(args, "kind_weight", None), EDGE_KINDS)
    except ValueError as exc:
        sys.stderr.write(f"ERROR: {exc}\n")
        return 2
    if kind_weights:
        weights_label = ", ".join(f"{k}={w}" for k, w in sorted(kind_weights.items()))
        sys.stderr.write(f"computing hom-profiles (kind_weights={weights_label})...\n")
    else:
        sys.stderr.write("computing raw hom-profiles...\n")
    # Each edge contributes its kind's weight (default 1.0). Ablation deltas are
    # then measured relative to this (possibly weighted) baseline.
    raw_counts: dict[str, list[float]] = {nid: [0.0] * NDIM for nid in g.nodes()}

    for src, dst, data in g.edges(data=True):
        kind = data.get("kind", "")
        w = kind_weights.get(kind, 1.0)
        out_key = (kind, "out")
        in_key = (kind, "in")
        if out_key in DIM_IDX:
            raw_counts[src][DIM_IDX[out_key]] += w
        if in_key in DIM_IDX:
            raw_counts[dst][DIM_IDX[in_key]] += w

    # ── 2. Baseline entropy ──────────────────────────────────────────────────
    baseline_profiles: collections.Counter[tuple[float, ...]] = collections.Counter()
    for vec in raw_counts.values():
        baseline_profiles[_l1_normalize(vec)] += 1
    baseline_entropy = _shannon_entropy(baseline_profiles, n_nodes)

    # ── 3. Leave-one-out ablation per edge kind ──────────────────────────────
    sys.stderr.write("running leave-one-out ablation per edge kind...\n")
    results: list[dict[str, Any]] = []

    # Count how many edges exist per kind for the report.
    kind_edge_counts: dict[str, int] = {}
    for _, _, data in g.edges(data=True):
        k = data.get("kind", "")
        kind_edge_counts[k] = kind_edge_counts.get(k, 0) + 1

    for ek in EDGE_KINDS:
        in_idx = DIM_IDX.get((ek, "in"))
        out_idx = DIM_IDX.get((ek, "out"))

        ablated_profiles: collections.Counter[tuple[float, ...]] = collections.Counter()
        for vec in raw_counts.values():
            ablated = list(vec)
            if in_idx is not None:
                ablated[in_idx] = 0
            if out_idx is not None:
                ablated[out_idx] = 0
            ablated_profiles[_l1_normalize(ablated)] += 1

        ablated_entropy = _shannon_entropy(ablated_profiles, n_nodes)
        delta = baseline_entropy - ablated_entropy

        results.append({
            "edge_kind": ek,
            "n_edges": kind_edge_counts.get(ek, 0),
            "baseline_entropy": baseline_entropy,
            "ablated_entropy": ablated_entropy,
            "delta": delta,
        })

    # Sort by delta descending (most important first).
    results.sort(key=lambda r: -r["delta"])

    # ── 4. Print report ──────────────────────────────────────────────────────
    print()
    print("=" * 70)
    print("  MARGINAL-ENTROPY ANALYSIS  —  MetaCoding-ijo.3")
    print("=" * 70)
    print(f"  corpus: {n_nodes:,} nodes, {n_edges:,} edges")
    print(f"  baseline Shannon entropy: {baseline_entropy:.4f} bits")
    print()
    print(f"  {'EDGE KIND':<20} {'EDGES':>8} {'ABLATED H':>12} {'DELTA':>10} {'IMPORTANCE':>12}")
    print(f"  {'─' * 20} {'─' * 8} {'─' * 12} {'─' * 10} {'─' * 12}")
    for r in results:
        importance = "HIGH" if r["delta"] > 0.1 else "MEDIUM" if r["delta"] > 0.01 else "LOW" if r["delta"] > 0.001 else "NONE"
        print(
            f"  {r['edge_kind']:<20} {r['n_edges']:>8,} "
            f"{r['ablated_entropy']:>12.4f} {r['delta']:>+10.4f} {importance:>12}"
        )
    print()
    print(f"  Total entropy budget: {baseline_entropy:.4f} bits")
    print(f"  Sum of deltas: {sum(r['delta'] for r in results):.4f} bits (not additive — leave-one-out)")
    print()
    print("=" * 70)

    # Emit JSON if requested.
    if getattr(args, "as_json", False):
        import json

        out: dict[str, Any] = {
            "baseline_entropy": baseline_entropy,
            "n_nodes": n_nodes,
            "n_edges": n_edges,
            "ablations": results,
        }
        sys.stdout.write(json.dumps(out, indent=2) + "\n")

    return 0
