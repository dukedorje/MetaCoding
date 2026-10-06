"""``ctkr label-roles`` — L3 role-class labeler CLI (MetaCoding-23q.4).

Reads ``hom_profiles.parquet``, clusters rows by bucket-key
equivalence at the chosen granularity, and labels each surviving
cluster via the LLM structured-output pipeline. Emits
``patterns.jsonl`` (source_kind='role-cluster') + ``evidence.jsonl``
alongside the L1 artifacts. Idempotent under the same prompt-version +
model — already-labeled clusters are skipped unless ``--force``.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import polars as pl

from ctkr.commands._common import add_common_flags, resolve_data_dir
from ctkr.evidence import build_evidence_pack
from ctkr.graph_loader import load_graph
from ctkr.label_roles import (
    DEFAULT_GRANULARITY,
    DEFAULT_MAX_INSTANCES,
    DEFAULT_MIN_CLUSTER_SIZE,
    DEFAULT_MODEL,
    DEFAULT_PROMPT_VERSION,
    DEFAULT_TEMPERATURE,
    DEFAULT_TOKEN_BUDGET,
    SOURCE_KIND,
    _pick_anchors_by_repo,
    compute_role_clusters,
    label_roles,
    pattern_id_for_role_cluster,
    render_prompt,
)
from ctkr.llm import LLMClient, sandbox_write_guard, scratch_dir


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "label-roles",
        help="Label clustered structural profiles with source-linked LLM descriptions.",
        description=(
            "Read hom_profiles.parquet, group symbols by bucket-key "
            "equivalence at the chosen granularity, and LLM-label each "
            "surviving cluster. Emits PatternRow (source_kind='role-cluster') "
            "+ EvidenceRow to patterns.jsonl / evidence.jsonl. Idempotent "
            "under the same prompt-version + model."
        ),
    )
    add_common_flags(p)
    p.add_argument(
        "--orchestrators-root",
        type=str,
        default=None,
        help=(
            "Parent dir containing each indexed repo as a subdirectory. "
            "Defaults to the parent of --data-dir."
        ),
    )
    p.add_argument(
        "--granularity",
        type=int,
        default=DEFAULT_GRANULARITY,
        help=(
            "Bucket-key granularity k — discretize each L1-normalised "
            "profile component to 1/k steps before grouping. Lower → "
            "coarser, fewer larger clusters. Default: %(default)s."
        ),
    )
    p.add_argument(
        "--min-cluster-size",
        type=int,
        default=DEFAULT_MIN_CLUSTER_SIZE,
        help=(
            "Drop clusters smaller than this many members. Default: %(default)s."
        ),
    )
    p.add_argument(
        "--keep-isolates",
        action="store_true",
        help=(
            "Include the all-zeros cluster (symbols with no edges). "
            "Default: drop — isolates carry no role signal."
        ),
    )
    p.add_argument("--provider", choices=("anthropic", "openai"), default="anthropic")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--temperature", type=float, default=DEFAULT_TEMPERATURE)
    p.add_argument("--prompt-version", default=DEFAULT_PROMPT_VERSION)
    p.add_argument("--max-tokens", type=int, default=1024)
    p.add_argument(
        "--max-instances-per-cluster", type=int, default=DEFAULT_MAX_INSTANCES
    )
    p.add_argument("--token-budget", type=int, default=DEFAULT_TOKEN_BUDGET)
    p.add_argument(
        "--max-clusters",
        type=int,
        default=None,
        help="Cap the number of clusters labeled (sorted by size desc).",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Re-label clusters whose pattern_id already exists.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Don't call the LLM. Print the cluster summary + render the "
            "prompt for the largest cluster, then exit. Useful for "
            "sanity-checking the granularity before spending money."
        ),
    )
    p.add_argument(
        "--cache-dir",
        default=None,
        help="LLM cache directory; defaults to ~/.cache/ctkr/label-roles/llm_cache/ (scratch, never a sandbox).",
    )
    p.add_argument(
        "--cost-log",
        default=None,
        help="LLM cost log JSONL; defaults to ~/.cache/ctkr/label-roles/llm_cost.jsonl (scratch, never a sandbox).",
    )
    p.add_argument(
        "--verbose", "-v", action="store_true", help="Log one line per cluster."
    )
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    data_dir = resolve_data_dir(args.data_dir)
    ctkr_dir = data_dir / "ctkr"
    profiles_path = ctkr_dir / "hom_profiles.parquet"
    if not profiles_path.exists():
        sys.stderr.write(
            f"{profiles_path} not found. Run `ctkr structural-profiles` first.\n"
        )
        return 2

    orchestrators_root = (
        Path(args.orchestrators_root).expanduser().resolve()
        if args.orchestrators_root
        else data_dir.parent
    )
    if not orchestrators_root.exists():
        sys.stderr.write(
            f"--orchestrators-root {orchestrators_root} does not exist\n"
        )
        return 2

    sys.stderr.write(f"loading graph from {data_dir}...\n")
    graph = load_graph(data_dir)
    sys.stderr.write(
        f"  {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges\n"
    )

    sys.stderr.write(f"loading hom_profiles from {profiles_path}...\n")
    profiles_df = pl.read_parquet(profiles_path)
    sys.stderr.write(f"  {profiles_df.height} profile rows\n")

    sys.stderr.write(
        f"clustering at granularity k={args.granularity} "
        f"(min_size={args.min_cluster_size}, "
        f"isolates={'kept' if args.keep_isolates else 'dropped'})...\n"
    )
    clusters = compute_role_clusters(
        profiles_df,
        granularity_k=args.granularity,
        min_cluster_size=args.min_cluster_size,
        drop_isolates=not args.keep_isolates,
    )
    sys.stderr.write(
        f"  {len(clusters)} clusters (≥{args.min_cluster_size} members each)\n"
    )
    if clusters:
        sizes = [c.size for c in clusters]
        sys.stderr.write(
            f"  size: max={max(sizes)} min={min(sizes)} sum={sum(sizes)}\n"
        )

    if args.dry_run:
        return _dry_run(
            clusters=clusters,
            graph=graph,
            orchestrators_root=orchestrators_root,
            granularity_k=args.granularity,
            max_instances_per_cluster=args.max_instances_per_cluster,
            token_budget=args.token_budget,
            prompt_version=args.prompt_version,
            model=args.model,
        )

    if not clusters:
        sys.stderr.write("no clusters to label.\n")
        return 0

    cache_dir = (
        Path(args.cache_dir).expanduser().resolve()
        if args.cache_dir
        else scratch_dir("label-roles") / "llm_cache"
    )
    cost_log = (
        Path(args.cost_log).expanduser().resolve()
        if args.cost_log
        else scratch_dir("label-roles") / "llm_cost.jsonl"
    )
    sandbox_write_guard(data_dir, cache_dir, cost_log)
    client = LLMClient(
        cache_dir=cache_dir,
        cost_log=cost_log,
        default_provider=args.provider,
        default_model=args.model,
        default_temperature=args.temperature,
        default_max_tokens=args.max_tokens,
    )

    out_patterns = ctkr_dir / "patterns.jsonl"
    out_evidence = ctkr_dir / "evidence.jsonl"
    sys.stderr.write(
        f"labeling — writing to {out_patterns} and {out_evidence}\n"
    )

    stats = label_roles(
        clusters=clusters,
        graph=graph,
        orchestrators_root=orchestrators_root,
        client=client,
        out_patterns=out_patterns,
        out_evidence=out_evidence,
        granularity_k=args.granularity,
        model=args.model,
        temperature=args.temperature,
        prompt_version=args.prompt_version,
        max_instances_per_cluster=args.max_instances_per_cluster,
        token_budget=args.token_budget,
        force=args.force,
        max_clusters=args.max_clusters,
        progress=[""] if args.verbose else None,
    )

    sys.stderr.write(
        f"\ndone — labeled={stats.n_labeled} skipped={stats.n_skipped} "
        f"failed={stats.n_failed} (of {stats.n_clusters}) "
        f"cost=${stats.total_cost_usd:.4f} cache_hits={stats.cache_hits}\n"
    )
    return 0 if stats.n_failed == 0 else 1


def _dry_run(
    *,
    clusters,
    graph,
    orchestrators_root: Path,
    granularity_k: int,
    max_instances_per_cluster: int,
    token_budget: int,
    prompt_version: str,
    model: str,
) -> int:
    """Print cluster summary + render the prompt for the largest cluster."""
    if not clusters:
        sys.stderr.write("(dry run) no clusters discovered.\n")
        return 0

    sys.stderr.write("\n(dry run) top 10 clusters by size:\n")
    for c in clusters[:10]:
        sys.stderr.write(
            f"  {c.cluster_id}  size={c.size:<6}  key={c.bucket_key[:60]}…\n"
        )

    target = clusters[0]
    anchors = _pick_anchors_by_repo(
        graph, target.members, max_instances=max_instances_per_cluster
    )
    if not anchors:
        sys.stderr.write(
            f"\n(dry run) cluster {target.cluster_id}: no resolvable graph "
            "nodes among its members — graph likely loaded from a different "
            "data-dir than the hom_profiles.\n"
        )
        return 2
    pack = build_evidence_pack(
        graph,
        anchors,
        source_kind=SOURCE_KIND,
        source_ref=target.cluster_id,
        orchestrators_root=orchestrators_root,
        token_budget=token_budget,
    )
    prompt = render_prompt(target, pack, granularity_k=granularity_k)
    sys.stdout.write(prompt + "\n")
    pid = pattern_id_for_role_cluster(
        target.cluster_id, prompt_version=prompt_version, llm_model=model
    )
    sys.stderr.write(
        f"\n(dry run) cluster {target.cluster_id}: pattern_id would be {pid}\n"
    )
    return 0
