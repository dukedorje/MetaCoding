"""``ctkr extract-spec`` — the Stage A–E spec-deck orchestrator (§8.2, T5).

Runs the full subsystem-spec-extraction pipeline for one indexed project and
emits the deck (``subsystem_cards.jsonl``) plus its L3 provenance
(``patterns.jsonl`` / ``evidence.jsonl``). Stages:

    A  subsystems   — partition (Stage A / T1)
    B  interfaces   — boundary + data shapes (Stage B / T2)
    C  roles        — role inventory (Stage C / T3)
    C  operads      — composition patterns (legacy artifact name) [optional-empty]
    D  NL labeling  — evidence packs + L3 labels (Stage D / T5)
    E  card fusion  — subsystem_cards.jsonl             (Stage E / T5)

Stages A–C are the earlier subcommands; extract-spec invokes each in-process
when its artifact is absent (``--skip-structural`` turns that off and requires
them present). Stages D + E always run here. Unlike the read-side MCP tools,
this is a *batch runner* — the same split structural alignment uses (legacy
``functor`` runner vs. ``structural_alignment`` tool): ``ctkr.subsystem_card`` reads the deck,
``ctkr extract-spec`` writes it.

Determinism: with the same inputs + ``--prompt-version`` + model the deck's
``card_id``s are byte-identical (structural digest; see
:func:`ctkr.cards.card_id`), and the labels themselves are stable through the
LLM cache at ``temperature=0``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ctkr.commands._common import (
    DEFAULT_LLM_PROVIDER,
    GPT56_CHEAP_MODEL,
    GPT56_STRONG_MODEL,
    add_common_flags,
    require_provider_key,
    resolve_data_dir,
)

# (manifest flag, subcommand, human label) for the structural prerequisites.
_STRUCTURAL_STAGES = [
    ("subsystems", "subsystems", "A — partition"),
    ("interfaces", "interfaces", "B — interface + data shapes"),
    ("presentations", "roles", "C — role inventory"),
    ("operads", "operads", "C — composition patterns"),
]


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "extract-spec",
        help="Generate the full subsystem spec deck (Stages A–E) for a project.",
        description=(
            "Orchestrate the subsystem-spec-extraction pipeline end to end: ensure "
            "the structural stages (subsystems / interfaces / roles / composition patterns) are "
            "present (running any that are missing), then run the NL lane (Stage D "
            "— evidence packs + L3 labels) and card fusion (Stage E), emitting "
            "subsystem_cards.jsonl plus patterns.jsonl / evidence.jsonl. Cards are "
            "derived and regenerable; card_ids are deterministic for fixed "
            "inputs + prompt_version + model."
        ),
    )
    add_common_flags(p)
    p.add_argument(
        "--repo-root",
        default=None,
        help="Parent directory containing the indexed repo as a subdirectory "
        "(source slices are read from <repo-root>/<repo>/<file>). Default: the "
        "parent of the current working directory.",
    )
    p.add_argument("--repo", default=None, help="Restrict the deck to one repo.")
    p.add_argument(
        "--provider",
        default=None,
        help="LLM provider for every call: 'anthropic' (default) or 'openai' "
        "(GPT-5.x tiers — pass the tier via --model/--subsystem-model).",
    )
    p.add_argument(
        "--model",
        default=None,
        help="LLM model for cheap per-element labels (default: spec-labeler default).",
    )
    p.add_argument(
        "--subsystem-model",
        default=None,
        help="Stronger LLM model for the highest-stakes subsystem name+intent pass "
        "(default: spec-labeler default, a sonnet-class model). Pass the same value "
        "as --model to force a single model.",
    )
    p.add_argument("--prompt-version", default=None, help="Override prompt_version.")
    p.add_argument(
        "--view",
        default="similarity",
        choices=["orbit", "similarity"],
        help="Profile grouping used by cards: orbit is legacy exact-profile equality; similarity is clustering.",
    )
    p.add_argument("--roles-per", type=int, default=None, help="Max LLM-labeled roles per card.")
    p.add_argument("--ops-per", type=int, default=None, help="Max LLM-labeled operations per card.")
    p.add_argument("--exports-per", type=int, default=None, help="Max LLM-labeled exports per card.")
    p.add_argument("--shapes-per", type=int, default=None, help="Max LLM-labeled data shapes per card.")
    p.add_argument("--nl-desc-per", type=int, default=None, help="Max LLM-described nl-only symbols per card.")
    p.add_argument("--max-subsystems", type=int, default=None, help="Cap the number of cards (largest first).")
    p.add_argument(
        "--generated-at",
        default=None,
        help="Fixed ISO-8601 timestamp for provenance (byte-identical re-runs). "
        "Does not affect card_ids.",
    )
    p.add_argument(
        "--skip-structural",
        action="store_true",
        help="Do not run missing structural stages; require them present.",
    )
    p.set_defaults(func=run)


def _artifact_present(ctkr_dir: Path, manifest: dict, flag: str, name: str) -> bool:
    return bool(manifest.get(flag)) or (ctkr_dir / f"{name}.parquet").exists()


def _load_manifest(ctkr_dir: Path) -> dict:
    p = ctkr_dir / "manifest.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def run(args: argparse.Namespace) -> int:
    from ctkr.cards import write_cards
    from ctkr.cli import main as cli_main
    from ctkr.llm import LLMClient, scratch_dir
    from ctkr.spec_cards import (
        DEFAULT_MODEL,
        DEFAULT_PROMPT_VERSION,
        build_deck,
        merge_evidence_jsonl,
        merge_patterns_jsonl,
        write_deck_manifest,
    )

    data_dir = resolve_data_dir(args.data_dir)
    ctkr_dir = Path(data_dir) / "ctkr"

    # ---- Stages A–C: ensure structural artifacts present ----
    manifest = _load_manifest(ctkr_dir)
    for flag, subcmd, label in _STRUCTURAL_STAGES:
        if _artifact_present(ctkr_dir, manifest, flag, subcmd if flag != "presentations" else "presentations"):
            continue
        if args.skip_structural:
            sys.stderr.write(
                f"ERROR: structural artifact for stage {label} is missing and "
                f"--skip-structural was given. Run `ctkr {subcmd} --data-dir {data_dir}` first.\n"
            )
            return 2
        sys.stderr.write(f"[stage {label}] artifact missing — running `ctkr {subcmd}` …\n")
        rc = cli_main([subcmd, "--data-dir", str(data_dir)])
        if rc != 0:
            sys.stderr.write(f"ERROR: stage {label} (`ctkr {subcmd}`) failed with code {rc}.\n")
            return rc
        manifest = _load_manifest(ctkr_dir)

    # ---- repo root ----
    repo_root = Path(args.repo_root).expanduser().resolve() if args.repo_root else Path.cwd().parent

    # ---- LLM client (cache + cost log alongside the artifacts) ----
    provider = args.provider or DEFAULT_LLM_PROVIDER
    # Adopted defaults (9h5.9): cheap per-element labeler → gpt-5.6-luna (re-test
    # 3/3 produced valid scenarios with the schema hardening); strong subsystem
    # name+intent pass → gpt-5.6-terra (reproduced baseline verdicts at ~parity cost).
    cheap_model = args.model or (GPT56_CHEAP_MODEL if provider == "openai" else DEFAULT_MODEL)
    strong_model = args.subsystem_model or (GPT56_STRONG_MODEL if provider == "openai" else None)
    rc = require_provider_key(
        provider,
        stage="extract-spec",
        default_hint=f"OpenAI {cheap_model} (cheap) / {strong_model} (strong)",
    )
    if rc is not None:
        return rc
    # Scratch, never the data-dir: a sandbox a command reads is read-only
    # (MetaCoding-7xr lever 4).
    client = LLMClient(
        cache_dir=scratch_dir("extract-spec") / "llm_cache",
        cost_log=scratch_dir("extract-spec") / "llm_cost.jsonl",
        default_provider=provider,
    )

    kwargs: dict = {
        "data_dir": data_dir,
        "repo_root": repo_root,
        "client": client,
        "view": args.view,
        "repo_filter": args.repo,
        "max_subsystems": args.max_subsystems,
        "generated_at": args.generated_at,
    }
    kwargs["model"] = cheap_model
    if strong_model is not None:
        kwargs["subsystem_model"] = strong_model
    if args.prompt_version:
        kwargs["prompt_version"] = args.prompt_version
    for cap_arg, cap_kw in (
        ("roles_per", "roles_per"),
        ("ops_per", "ops_per"),
        ("exports_per", "exports_per"),
        ("shapes_per", "shapes_per"),
        ("nl_desc_per", "nl_desc_per"),
    ):
        v = getattr(args, cap_arg)
        if v is not None:
            kwargs[cap_kw] = v

    sys.stderr.write(f"[stage D+E] fusing deck (repo_root={repo_root}) …\n")
    cards, patterns, evidence, stats = build_deck(**kwargs)

    # ---- Stage E: write the deck + provenance + manifest ----
    write_cards(cards, ctkr_dir / "subsystem_cards.jsonl")
    merge_patterns_jsonl(ctkr_dir / "patterns.jsonl", patterns)
    merge_evidence_jsonl(ctkr_dir / "evidence.jsonl", evidence)
    manifest_path = write_deck_manifest(
        data_dir, n_cards=len(cards), generated_at=args.generated_at
    )

    model = cheap_model
    pv = args.prompt_version or DEFAULT_PROMPT_VERSION
    sys.stderr.write(
        "\n"
        f"  cards               : {stats.n_cards} (subsystems {stats.n_subsystems})\n"
        f"  members             : {stats.n_members_total} "
        f"(structural {stats.n_members_structural}, "
        f"nl-only {stats.n_nl_only_symbols})\n"
        f"  labels              : {stats.n_labels} "
        f"(role {stats.n_role_labels}, op {stats.n_op_labels}, "
        f"export {stats.n_export_labels}, shape {stats.n_shape_labels}, "
        f"nl {stats.n_nl_labels})\n"
        f"  dissonance findings : {stats.n_dissonance_structural + stats.n_dissonance_llm} "
        f"(structural {stats.n_dissonance_structural}, llm {stats.n_dissonance_llm})\n"
        f"  cost                : ${stats.total_cost_usd:.4f}  "
        f"(cache hits {stats.cache_hits}/{stats.n_labels})\n"
        f"  model / prompt      : {model} / {pv}\n"
        f"  deck                : {ctkr_dir / 'subsystem_cards.jsonl'}\n"
        f"  manifest            : {manifest_path}\n"
        f"  elapsed             : {stats.total_seconds}s\n"
    )

    if getattr(args, "as_json", False):
        sys.stdout.write(
            json.dumps(
                {
                    "n_cards": stats.n_cards,
                    "n_members_total": stats.n_members_total,
                    "n_members_structural": stats.n_members_structural,
                    "n_nl_only_symbols": stats.n_nl_only_symbols,
                    "n_labels": stats.n_labels,
                    "n_dissonance_structural": stats.n_dissonance_structural,
                    "n_dissonance_llm": stats.n_dissonance_llm,
                    "total_cost_usd": stats.total_cost_usd,
                    "cache_hits": stats.cache_hits,
                    "model": model,
                    "prompt_version": pv,
                    "per_card": stats.per_card,
                    "elapsed_seconds": stats.total_seconds,
                },
                indent=2,
            )
            + "\n"
        )
    return 0
