"""``ctkr entropy-check`` — hom-profile entropy / edge-type discrimination spike.

Analytical spike for MetaCoding-23q.6. Checks whether the current typed-edge
alphabet (CALLS, REFERENCES, IMPLEMENTS, ...) is rich enough for hom-profile
clustering to produce discriminating role classes (MetaCoding-23q.1).

For every Symbol in the corpus, computes:

    hom_profile(s) = {(edge_kind, direction): count}

where direction is "in" or "out". Normalises by L1 norm to a distribution
vector. Then reports:

1. Profile distribution — how many unique L1-normalised profile shapes exist.
2. Shannon entropy of the profile distribution.
3. Per-symbol-kind entropy.
4. Dominant-profile coverage (fraction with one of top-5 profiles).
5. Pairwise cosine similarity histogram over a 1000-symbol sample.

Decision:
- shannon_entropy >= 4.0 AND dominant_top5_coverage < 50%  → PROCEED
- shannon_entropy <  4.0 OR  dominant_top5_coverage > 70%  → BLOCKED
- otherwise                                                  → BORDERLINE
"""

from __future__ import annotations

import argparse
import collections
import math
import random
import sys
from typing import Any

from ctkr.commands._common import (
    add_common_flags,
    add_kind_weight_flag,
    parse_kind_weights,
    resolve_data_dir,
)
from ctkr.graph_loader import EDGE_KINDS, load_graph
from ctkr.hom_profiles import DIM_IDX as _DIM_IDX
from ctkr.hom_profiles import DIMS as _DIMS_TUPLE
from ctkr.hom_profiles import NDIM as _NDIM

# Re-bind to a list so existing iteration sites (and tests) read the same shape
# they always did. The canonical ordering lives in ctkr.hom_profiles.DIMS so
# entropy-check and the hom-profiles writer can never drift apart.
_DIMS: list[tuple[str, str]] = list(_DIMS_TUPLE)


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "entropy-check",
        help="Structural-profile entropy / edge-type discrimination diagnostic.",
        description=(
            "Compute structural-profile entropy over the corpus to assess whether the "
            "current edge-type alphabet discriminates structural roles well enough "
            "for structural-profile clustering to be useful (a heuristic, not a guarantee)."
        ),
    )
    add_common_flags(p)
    p.add_argument(
        "--sample-size",
        type=int,
        default=1000,
        help="Number of symbols to sample for pairwise cosine similarity histogram (default: 1000).",
    )
    p.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for sampling (default: 42).",
    )
    p.add_argument(
        "--top-k-profiles",
        type=int,
        default=5,
        help="Number of top profiles for dominant-coverage calculation (default: 5).",
    )
    add_kind_weight_flag(p)
    p.set_defaults(func=run)


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
        sys.stderr.write("computing hom-profiles...\n")

    # counts[node_id] = list of floats, length _NDIM. Each edge contributes its
    # kind's weight (default 1.0) so the profile scored here matches what the
    # hom-profiles writer emits for the same --kind-weight — the diagnostic is
    # no longer blind to weighting.
    raw_counts: dict[str, list[float]] = {
        nid: [0.0] * _NDIM for nid in g.nodes()
    }

    for src, dst, data in g.edges(data=True):
        kind = data.get("kind", "")
        w = kind_weights.get(kind, 1.0)
        out_key = (kind, "out")
        in_key = (kind, "in")
        if out_key in _DIM_IDX:
            raw_counts[src][_DIM_IDX[out_key]] += w
        if in_key in _DIM_IDX:
            raw_counts[dst][_DIM_IDX[in_key]] += w

    # ── 2. L1-normalise → profile tuples ────────────────────────────────────
    # Isolated nodes (all-zero vector) get the zero-profile tuple.
    profile_tuples: dict[str, tuple[float, ...]] = {}
    for nid, vec in raw_counts.items():
        total = sum(vec)
        if total == 0:
            profile_tuples[nid] = tuple([0.0] * _NDIM)
        else:
            profile_tuples[nid] = tuple(v / total for v in vec)

    # ── 3. Profile distribution ──────────────────────────────────────────────
    sys.stderr.write("computing profile distribution...\n")
    profile_counts: collections.Counter[tuple[float, ...]] = collections.Counter(
        profile_tuples.values()
    )
    n_unique_profiles = len(profile_counts)
    top_k = args.top_k_profiles

    # ── 4. Shannon entropy of profile distribution ───────────────────────────
    total_symbols = n_nodes
    shannon_entropy = 0.0
    for cnt in profile_counts.values():
        p = cnt / total_symbols
        if p > 0:
            shannon_entropy -= p * math.log2(p)

    # ── 5. Dominant-profile coverage ─────────────────────────────────────────
    top_profiles = profile_counts.most_common(top_k)
    top5_count = sum(cnt for _, cnt in top_profiles)
    dominant_top5_coverage = top5_count / total_symbols * 100.0  # percent

    # ── 6. Per-symbol-kind entropy ────────────────────────────────────────────
    sys.stderr.write("computing per-symbol-kind entropy...\n")
    kind_profile_counts: dict[str, collections.Counter[tuple[float, ...]]] = (
        collections.defaultdict(collections.Counter)
    )
    for nid, pt in profile_tuples.items():
        sym_kind = g.nodes[nid].get("kind") or "unknown"
        kind_profile_counts[sym_kind][pt] += 1

    kind_entropy: dict[str, tuple[float, int]] = {}  # kind → (entropy, count)
    for sym_kind, counter in kind_profile_counts.items():
        n_kind = sum(counter.values())
        h = 0.0
        for cnt in counter.values():
            p = cnt / n_kind
            if p > 0:
                h -= p * math.log2(p)
        kind_entropy[sym_kind] = (h, n_kind)

    # ── 7. Pairwise cosine similarity histogram ───────────────────────────────
    sys.stderr.write(
        f"sampling {args.sample_size:,} symbols for pairwise cosine similarity...\n"
    )
    rng = random.Random(args.seed)
    all_node_ids = list(g.nodes())
    sample_size = min(args.sample_size, len(all_node_ids))
    sample_ids = rng.sample(all_node_ids, sample_size)
    sample_vecs = [raw_counts[nid] for nid in sample_ids]  # use raw (unnormalised) for cosine

    # Cosine similarity on ~1000 nodes: O(n^2/2) = ~500k pairs — fast enough.
    cos_bins = [0] * 10  # [0,0.1), [0.1,0.2), ..., [0.9,1.0]
    n_pairs = 0
    high_sim_pairs = 0  # similarity > 0.9

    for i in range(sample_size):
        vi = sample_vecs[i]
        norm_i = math.sqrt(sum(x * x for x in vi))
        if norm_i == 0:
            continue
        for j in range(i + 1, sample_size):
            vj = sample_vecs[j]
            norm_j = math.sqrt(sum(x * x for x in vj))
            if norm_j == 0:
                continue
            dot = sum(vi[k] * vj[k] for k in range(_NDIM))
            cos_sim = dot / (norm_i * norm_j)
            cos_sim = max(0.0, min(1.0, cos_sim))  # clamp float noise
            bin_idx = min(int(cos_sim * 10), 9)
            cos_bins[bin_idx] += 1
            n_pairs += 1
            if cos_sim > 0.9:
                high_sim_pairs += 1

    high_sim_frac = (high_sim_pairs / n_pairs * 100.0) if n_pairs > 0 else 0.0

    # ── 8. Print report ───────────────────────────────────────────────────────
    print()
    print("=" * 60)
    print("  ENTROPY CHECK  —  MetaCoding-23q.6")
    print("=" * 60)
    print(f"  corpus symbols          : {total_symbols:>10,}")
    print(f"  corpus edges            : {n_edges:>10,}")
    print(f"  edge-type alphabet size : {len(EDGE_KINDS):>10}")
    print(f"  profile vector dims     : {_NDIM:>10}  (2 * {len(EDGE_KINDS)} kinds)")
    print()
    print("  1. PROFILE DISTRIBUTION")
    print(f"     unique L1-normalised profiles : {n_unique_profiles:>8,}")
    print(f"     unique / total symbols        : {n_unique_profiles / total_symbols * 100:.2f}%")
    print()
    print("  2. SHANNON ENTROPY (profile distribution)")
    print(f"     H = {shannon_entropy:.4f} bits   (max theoretical = {math.log2(total_symbols):.2f} bits)")
    print()
    print("  3. PER-SYMBOL-KIND ENTROPY  (sorted by count)")
    kind_rows = sorted(kind_entropy.items(), key=lambda kv: -kv[1][1])
    for sym_kind, (h, cnt) in kind_rows[:20]:
        n_uniq_k = len(kind_profile_counts[sym_kind])
        print(f"     {sym_kind:<20} count={cnt:>8,}  H={h:.3f} bits  unique_profiles={n_uniq_k:,}")
    if len(kind_rows) > 20:
        print(f"     ... ({len(kind_rows) - 20} more kinds)")
    print()
    print(f"  4. DOMINANT-PROFILE COVERAGE (top {top_k})")
    for rank, (profile, cnt) in enumerate(top_profiles, 1):
        pct = cnt / total_symbols * 100
        # Describe the profile: show non-zero dims only
        nonzero = [(dim, v) for dim, v in zip(_DIMS, profile) if v > 0]
        desc = ", ".join(f"{d[0]}:{d[1]}={v:.2f}" for d, v in nonzero[:4])
        if len(nonzero) > 4:
            desc += f" +{len(nonzero) - 4} more"
        print(f"     #{rank}  {pct:5.2f}%  ({cnt:,})  [{desc or 'isolated/no-edges'}]")
    print(f"     ─────────────────────────────")
    print(f"     top-{top_k} combined coverage : {dominant_top5_coverage:.2f}%")
    print()
    print(f"  5. PAIRWISE COSINE SIMILARITY  (sample n={sample_size:,}, pairs={n_pairs:,})")
    for b in range(10):
        lo = b / 10
        hi = (b + 1) / 10
        cnt = cos_bins[b]
        pct = cnt / n_pairs * 100 if n_pairs > 0 else 0.0
        bar = "#" * int(pct / 2)
        print(f"     [{lo:.1f}, {hi:.1f})  {pct:5.2f}%  {bar}")
    print(f"     pairs with similarity > 0.9 : {high_sim_frac:.2f}%")
    print()

    # ── 9. Recommendation ────────────────────────────────────────────────────
    print("  RECOMMENDATION")
    print("  ─────────────────────────────────────")
    if shannon_entropy >= 4.0 and dominant_top5_coverage < 50.0:
        verdict = "PROCEED"
        reason = (
            f"shannon_entropy={shannon_entropy:.3f} >= 4.0  AND  "
            f"dominant_top5_coverage={dominant_top5_coverage:.1f}% < 50%.\n"
            "  Edge types discriminate roles. Hom-profile clustering is viable."
        )
    elif shannon_entropy < 4.0 or dominant_top5_coverage > 70.0:
        verdict = "BLOCKED"
        # Compute genuinely-absent edge kinds from the live graph rather
        # than hardcoding names that may already exist (bead MetaCoding-ijo.4).
        present_kinds: set[str] = set()
        for _, _, data in g.edges(data=True):
            k = data.get("kind", "")
            if k:
                present_kinds.add(k)
        absent_kinds = [ek for ek in EDGE_KINDS if ek not in present_kinds]
        if absent_kinds:
            absent_str = ", ".join(absent_kinds)
            absent_hint = (
                f"\n  Edge kinds in the schema but absent from this corpus:\n"
                f"    {absent_str}.\n"
                f"  Consider extending the extractor to emit these."
            )
        else:
            absent_hint = (
                "\n  All defined edge kinds are present. Consider adding new edge\n"
                "  kinds (e.g. domain-specific relationships) for finer discrimination."
            )
        reason = (
            f"shannon_entropy={shannon_entropy:.3f} (threshold 4.0)  /  "
            f"dominant_top5_coverage={dominant_top5_coverage:.1f}% (threshold 70%).\n"
            "  Need richer edge types before hom-profiles will earn their keep."
            f"{absent_hint}"
        )
    else:
        verdict = "BORDERLINE"
        reason = (
            f"shannon_entropy={shannon_entropy:.3f}  /  "
            f"dominant_top5_coverage={dominant_top5_coverage:.1f}%.\n"
            "  Proceed with caution; expect role classes to be coarse."
        )

    print(f"  {verdict} — {reason}")
    print()
    print("=" * 60)

    # Emit JSON if requested (--json flag from add_common_flags)
    if getattr(args, "as_json", False):
        import json

        result: dict[str, Any] = {
            "total_symbols": total_symbols,
            "n_edges": n_edges,
            "edge_kind_alphabet_size": len(EDGE_KINDS),
            "profile_vector_dims": _NDIM,
            "unique_profiles": n_unique_profiles,
            "unique_profiles_pct": n_unique_profiles / total_symbols * 100,
            "shannon_entropy": shannon_entropy,
            "dominant_top5_coverage_pct": dominant_top5_coverage,
            "high_sim_pairs_pct": high_sim_frac,
            "verdict": verdict,
            "per_kind_entropy": {
                k: {"entropy": h, "count": cnt, "unique_profiles": len(kind_profile_counts[k])}
                for k, (h, cnt) in kind_entropy.items()
            },
            "cosine_histogram": {
                f"{b/10:.1f}-{(b+1)/10:.1f}": cos_bins[b] for b in range(10)
            },
        }
        sys.stdout.write(json.dumps(result, indent=2) + "\n")

    return 0
