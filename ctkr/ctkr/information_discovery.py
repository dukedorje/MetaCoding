"""Deterministic, review-only typed shared-neighbor discovery for small archives.

This is not functor search, identity resolution, or semantic link prediction.
Scores rank topology, not confidence. No LLM, network, or graph write-back.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from itertools import combinations
from pathlib import Path
from typing import Any

import networkx as nx

from ctkr.graph_loader import INFORMATION_DOMAIN, load_graph

ALGORITHM = "typed-shared-neighbor-v1"
MAX_NODES = 2000


def _generated(attrs: dict[str, Any]) -> bool:
    # Treat truthy metadata conservatively, including string-valued flags.
    if attrs.get("generated") or attrs.get("derived") or attrs.get("generated_by"):
        return True
    provenance = json.dumps(attrs.get("provenance", ""), sort_keys=True).lower()
    return any(word in provenance for word in ("ctkr", "discovery", "suggested-link", "derived"))


def _excluded_node(node_id: str, attrs: dict[str, Any]) -> bool:
    if _generated(attrs) or attrs.get("administrative"):
        return True
    paths = [node_id] + [
        str(attrs.get(k, "")) for k in ("slug", "qualified_name", "file", "file_path", "path")
    ]
    admin = {"constitution", "commitments", "hot-snapshot", "recipes", "self-model"}
    if any(
        "suggested-link-" in value.lower()
        or ("notes" in Path(value.lower()).parts and Path(value.lower()).stem in admin)
        for value in paths
    ):
        return True
    tags = attrs.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    return any(
        str(tag).lower() in {"ctkr-generated", "ctkr-discovery", "administrative"} for tag in tags
    )


def discover(g: nx.MultiDiGraph, *, limit: int = 20) -> dict[str, Any]:
    """Return unlinked same-kind pairs with equal typed/directed neighbors.

    Each feature is (edge kind, in/out direction, neighbor ID). Exact shared
    features need at least two distinct neighbors. Names, text, folders
    and tags do not affect rank.
    Scaffolding, generated nodes and generated/derived edges cannot supply
    evidence. An edge in either direction in the original graph blocks a pair.

    score = sum(1 / feature_frequency for shared features) / union_size.
    This is inverse-frequency weighted shared support divided by the number
    of distinct incident features. A common hub gives less evidence than a
    rare witness. Scores are in (0, 1], NOT calibrated probabilities.
    Edge counts, confidence and validity intervals are reported, not weighted
    or composed. Evidence asserts topology only, not simultaneous relations.
    """
    if limit < 0:
        raise ValueError("limit must be nonnegative")
    if g.number_of_nodes() > MAX_NODES:
        raise ValueError(f"small-graph discovery supports at most {MAX_NODES} nodes")
    profile = g.graph.get("domain_profile", INFORMATION_DOMAIN)
    if profile.name != "information":
        raise ValueError("discovery requires an information-domain graph")
    if any(not isinstance(n, str) for n in g):
        raise ValueError("node IDs must be strings")
    keep = {n for n, attrs in g.nodes(data=True) if not _excluded_node(n, attrs)}
    # Always suppress scaffolding even if a custom profile forgets it.
    ignored = set(profile.scaffold_edge_kinds) | {"CONTAINS", "TAGGED", "SAME_AS"}
    features: dict[str, dict[tuple[str, str, str], dict[str, Any]]] = {n: {} for n in sorted(keep)}
    for src, dst, key, attrs in g.edges(keys=True, data=True):
        kind = attrs.get("kind", key)
        if src not in keep or dst not in keep or src == dst or kind in ignored or _generated(attrs):
            continue
        if (kind, "out", dst) in features[src]:
            raise ValueError("duplicate typed edge; aggregate provenance before discovery")
        witness = {**attrs, "src_id": src, "dst_id": dst, "kind": kind}
        features[src][kind, "out", dst] = witness
        features[dst][kind, "in", src] = witness
    eligible = {n for n in keep if g.nodes[n].get("kind") in profile.anchor_node_kinds}
    postings: dict[tuple[str, str, str], list[str]] = defaultdict(list)
    for n in sorted(eligible):
        for feature in sorted(features[n]):
            postings[feature].append(n)
    pairs: set[tuple[str, str]] = set()
    for nodes in postings.values():
        for left, right in combinations(nodes, 2):
            if (
                g.nodes[left].get("kind") == g.nodes[right].get("kind")
                and not g.has_edge(left, right)
                and not g.has_edge(right, left)
            ):
                pairs.add((left, right))
    candidates = []
    for left, right in sorted(pairs):
        lf, rf = features[left], features[right]
        shared = sorted(lf.keys() & rf.keys())
        if len({f[2] for f in shared}) < 2:
            continue
        shared_features = [
            {
                "neighbor": neighbor,
                "kind": kind,
                "direction": direction,
                "feature_frequency": len(postings[kind, direction, neighbor]),
            }
            for kind, direction, neighbor in shared
        ]
        evidence = [edge for feature in shared for edge in (lf[feature], rf[feature])]
        score = sum(1 / len(postings[f]) for f in shared) / len(lf.keys() | rf.keys())
        digest = hashlib.sha256(
            json.dumps([ALGORITHM, left, right], separators=(",", ":")).encode()
        ).hexdigest()[:24]
        candidates.append(
            {
                "id": "ctkr-i-" + digest,
                "left": left,
                "right": right,
                "score": round(score, 12),
                "evidence": evidence,
                "shared_features": shared_features,
            }
        )
    candidates.sort(key=lambda c: (-c["score"], c["left"], c["right"]))
    return {
        "algorithm": ALGORITHM,
        "schema_version": 1,
        "domain": profile.name,
        "score_definition": "sum(1/feature_frequency for shared features)/union_size",
        "n_nodes": g.number_of_nodes(),
        "n_excluded_nodes": g.number_of_nodes() - len(keep),
        "n_eligible_nodes": len(eligible),
        "n_candidates_total": len(candidates),
        "candidates": candidates[:limit],
        "limitations": [
            "Review-only topology, not a semantic relation or identity claim.",
            "No temporal overlap check or confidence calibration.",
            "Requires two distinct shared neighbors; sparse graphs can yield no candidates.",
            "Same-kind shared neighbors only; not full Yoneda or motif completion.",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args(argv)
    try:
        if args.limit < 0:
            raise ValueError("limit must be nonnegative")
        graph = load_graph(args.data_dir)
        result = discover(graph, limit=args.limit)
        output = args.out.expanduser().resolve()
        # Refuse overwriting inputs, even through a symlink.
        from ctkr.graph_loader import resolve_paths

        inputs = resolve_paths(args.data_dir)
        input_paths = [p for p in (inputs.nodes, inputs.edges, inputs.manifest) if p is not None]
        if any(
            output == p.resolve() or (output.exists() and output.samefile(p)) for p in input_paths
        ):
            raise ValueError("output must not overwrite an export input")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
