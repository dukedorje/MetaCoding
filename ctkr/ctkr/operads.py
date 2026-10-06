"""Composition-pattern mining — Stage C / §4.3 (subsystem-extraction T4).

Mine supported typed path and fan-in patterns within each subsystem, projected
onto the role classes in ``presentations.parquet``. Category theory, operads,
and wiring diagrams (Fong & Spivak ch. 6) remain research inspiration; see
``docs/design/ct-pipeline.md`` §2d. This module does not recover or prove an
operad, categorical laws, or behavioral equivalence.

The pipeline:

1. **Project observed paths onto roles.** Enumerate internal, non-``CONTAINS``
   edges and two-edge paths, then replace concrete symbols with role classes.
   A role sequence summarizes graph edges, not necessarily execution order.
2. **Keep supported patterns.** ``path`` rows count distinct concrete node
   tuples. ``fan_in`` rows count targets with the same set of distinct source
   roles and edge kinds; their ``arity`` counts source roles, not source nodes.
3. **Record diagnostics.** Recurring role pairs with a shared middle role but
   no retained two-edge pattern yield ``missing_composite`` rows. Thresholds,
   truncated enumeration/sampling, path limits, missing profiles, and the role
   quotient all affect absence. Opposite recurring role pairs yield
   ``back_call_cycle`` rows; these need not share concrete endpoints. Neither
   diagnostic is a generic category/operad violation: cycles are allowed, and
   role-level composability need not imply connected instance paths. Observed
   two-edge paths do not prove associativity.
4. **Flag interface participation.** ``is_boundary_op`` means at least one role
   participates in the interface. This is a review hint, not proof of an
   external protocol or an order-of-operations contract.

Compatibility names are retained: ``operads`` module/API/artifact/schema,
``non_operadic``, ``associative_observed``, ``law_violations``, ``violation_kind``,
and ``invariance_tier`` are legacy labels for patterns and diagnostics, not
mathematical or portability guarantees. ``orbit`` means exact-profile classes.

Structure-only lane (§5): typed edges, the T1 partition, and the T3 role quotient
set the patterns and flags. Identifier text is used only for exemplars. The NL
lane (T5) can label the patterns later.

Determinism: role-paths are enumerated over sorted nodes/edges; operations are
ranked ``(op_kind, -support, operation_id)`` with members/roles sorted;
``operation_id`` is content-addressed and excludes ``generated_at`` — so the same
graph + partition + roles yield byte-identical parquet across runs regardless of
``PYTHONHASHSEED``.
"""

from __future__ import annotations

import json
import logging
import time
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import networkx as nx
import polars as pl
from blake3 import blake3

from ctkr.schema import OPERADS_COLUMNS, SCHEMA_VERSION

logger = logging.getLogger("ctkr.operads")

# ── defaults (dials, not truths) ──
# A role-path must recur at least this many times to count as an operation. 2 is
# the minimum that makes "recurring" meaningful (support 1 is a one-off).
# Raising it filters patterns; no support threshold turns a pattern into a law.
DEFAULT_MIN_SUPPORT: int = 2
# Path-node setting: the implementation enumerates edges, plus two-edge paths
# when this is >= 3. Larger values do not enable deeper path enumeration.
DEFAULT_MAX_PATH_NODES: int = 3
# Up to this many concrete qualified-name paths kept per operation as exemplars.
DEFAULT_MAX_EXEMPLARS: int = 3
# Which role quotient to project through. "similarity" is the working quotient
# the card uses; legacy "orbit" means exact-profile classes; "both" emits each.
DEFAULT_VIEW: str = "similarity"
# Safety cap on 2-edge path enumeration per subsystem (guards a pathological
# hub). Exceeding it truncates enumeration (recorded in stats). Observed path
# support is then a lower bound; missing-pattern diagnostics can be artifacts
# of truncation, not genuine structural absences.
DEFAULT_MAX_PATHS_PER_SUBSYSTEM: int = 2_000_000

# CONTAINS is containment scaffolding (§6.1 tier A). This modeling choice
# excludes it from path patterns, as interfaces.py excludes it from interfaces.
CONTAINMENT_KIND = "CONTAINS"
INVARIANCE_TIER = "I"  # legacy tier label (§6.1), not proven port invariance


@dataclass(slots=True, frozen=True)
class OperadStats:
    n_subsystems: int
    n_operations: int
    n_path_ops: int
    n_fan_in_ops: int
    n_non_operadic: int
    n_boundary_ops: int
    n_missing_composite: int
    n_back_call_cycle: int
    n_unit_like_roles: int  # shortcut-pattern roles, not proven identity units
    total_seconds: float
    truncated_subsystems: list[str] = field(default_factory=list)
    per_subsystem: dict[str, dict[str, float]] = field(default_factory=dict)


# ----- public API -----


def compute_operads(
    g: nx.MultiDiGraph,
    members: pl.DataFrame,
    presentations: pl.DataFrame,
    *,
    view: str = DEFAULT_VIEW,
    min_support: int = DEFAULT_MIN_SUPPORT,
    max_path_nodes: int = DEFAULT_MAX_PATH_NODES,
    max_exemplars: int = DEFAULT_MAX_EXEMPLARS,
    max_paths_per_subsystem: int = DEFAULT_MAX_PATHS_PER_SUBSYSTEM,
    generated_at: str | None = None,
) -> tuple[pl.DataFrame, OperadStats]:
    """Mine each subsystem's composition patterns and diagnostic rows.

    Parameters
    ----------
    g
        The typed code graph (``nx.MultiDiGraph`` from ``graph_loader.load_graph``).
        Nodes carry ``qualified_name``; edges are keyed by ``kind``.
    members
        ``subsystem_members.parquet`` (T1) — columns ``subsystem_id, symbol_id,
        repo, ...``. Fixes which subsystem each symbol belongs to and the scope
        each set of composition patterns is mined within.
    presentations
        ``presentations.parquet`` (T3) — the role quotient. Each row carries
        ``subsystem_id, view, role_id, members (list), interface_participation``.
        A symbol's role (for the chosen ``view``) is the ``role_id`` of the class
        whose ``members`` contains it. Members without a profile never appear here
        (the NL-only floor) and are skipped — a path through such a symbol is
        dropped (its composition is invisible to structure, specced by T5 text).
    view
        ``"orbit" | "similarity" | "both"``. Which role quotient to project
        through (default ``"similarity"``, the working quotient). ``"both"`` emits
        patterns per view (rows tagged by ``view``). The legacy ``"orbit"``
        value selects exact-profile classes, not automorphism orbits.

    Returns
    -------
    (pl.DataFrame, OperadStats)
        DataFrame columns in ``OPERADS_COLUMNS`` order.
    """
    start = time.perf_counter()
    gen_at = generated_at or datetime.now(tz=UTC).isoformat()

    views = _resolve_views(view)
    config = {
        "stage": "C",
        "section": "operad_recovery",
        "views": views,
        "min_support": int(min_support),
        "max_path_nodes": int(max_path_nodes),
        "max_exemplars": int(max_exemplars),
        "schema_version": SCHEMA_VERSION,
    }
    config_json = json.dumps(config, sort_keys=True, separators=(",", ":"))

    # ── symbol → subsystem, subsystem → repo (T1 partition) ──
    sym2sub: dict[str, str] = {}
    sub2repo: dict[str, str] = {}
    for row in members.iter_rows(named=True):
        sym2sub[row["symbol_id"]] = row["subsystem_id"]
        sub2repo[row["subsystem_id"]] = row.get("repo") or ""

    # ── per-subsystem internal adjacency (non-CONTAINS, non-self, both ends in) ──
    # adj[sub][u] = list of (v, kind); edges[sub] = list of (u, v, kind).
    adj: dict[str, dict[str, list[tuple[str, str]]]] = defaultdict(lambda: defaultdict(list))
    n_edges_by_sub: dict[str, int] = defaultdict(int)
    for u, v, k in g.edges(keys=True):
        if k == CONTAINMENT_KIND or u == v:
            continue
        su = sym2sub.get(u)
        if su is None or su != sym2sub.get(v):
            continue  # only compositions *within* one subsystem
        adj[su][u].append((v, k))
        n_edges_by_sub[su] += 1

    rows: list[dict[str, object]] = []
    per_subsystem: dict[str, dict[str, float]] = {}
    truncated_subsystems: list[str] = []
    tot = _Tallies()

    for vname in views:
        # symbol → role_id and role_id → is_public for THIS view, per subsystem.
        sym2role, role_public = _role_maps(presentations, vname)

        for ssid in sorted(sub2repo):
            repo = sub2repo[ssid]
            sub_adj = adj.get(ssid, {})
            roles = sym2role.get(ssid, {})
            if not sub_adj or not roles:
                continue

            sub_rows, sub_stat, truncated = _operad_for_subsystem(
                ssid=ssid,
                repo=repo,
                adj=sub_adj,
                roles=roles,
                role_public=role_public.get(ssid, {}),
                g=g,
                view=vname,
                min_support=min_support,
                max_path_nodes=max_path_nodes,
                max_exemplars=max_exemplars,
                max_paths=max_paths_per_subsystem,
                config_json=config_json,
                gen_at=gen_at,
            )
            if not sub_rows:
                continue
            rows.extend(sub_rows)
            tot.add(sub_stat)
            if truncated:
                truncated_subsystems.append(f"{ssid}[{vname}]")
            per_subsystem[f"{ssid}[{vname}]"] = {
                "n_operations": float(sub_stat.n_operations),
                "n_path_ops": float(sub_stat.n_path_ops),
                "n_fan_in_ops": float(sub_stat.n_fan_in_ops),
                "n_non_operadic": float(sub_stat.n_non_operadic),
                "n_boundary_ops": float(sub_stat.n_boundary_ops),
            }

    df = pl.DataFrame(rows, schema=_operads_schema()).select(OPERADS_COLUMNS)
    df = df.sort(["subsystem_id", "view", "op_kind", "operation_id"])

    n_subsystems_done = len({r["subsystem_id"] for r in rows})
    stats = OperadStats(
        n_subsystems=n_subsystems_done,
        n_operations=tot.n_operations,
        n_path_ops=tot.n_path_ops,
        n_fan_in_ops=tot.n_fan_in_ops,
        n_non_operadic=tot.n_non_operadic,
        n_boundary_ops=tot.n_boundary_ops,
        n_missing_composite=tot.n_missing_composite,
        n_back_call_cycle=tot.n_back_call_cycle,
        n_unit_like_roles=tot.n_unit_like_roles,
        total_seconds=round(time.perf_counter() - start, 3),
        truncated_subsystems=truncated_subsystems,
        per_subsystem=per_subsystem,
    )
    return df, stats


# ----- per-subsystem recovery -----


@dataclass(slots=True)
class _Tallies:
    n_operations: int = 0
    n_path_ops: int = 0
    n_fan_in_ops: int = 0
    n_non_operadic: int = 0
    n_boundary_ops: int = 0
    n_missing_composite: int = 0
    n_back_call_cycle: int = 0
    n_unit_like_roles: int = 0

    def add(self, o: "_Tallies") -> None:
        self.n_operations += o.n_operations
        self.n_path_ops += o.n_path_ops
        self.n_fan_in_ops += o.n_fan_in_ops
        self.n_non_operadic += o.n_non_operadic
        self.n_boundary_ops += o.n_boundary_ops
        self.n_missing_composite += o.n_missing_composite
        self.n_back_call_cycle += o.n_back_call_cycle
        self.n_unit_like_roles += o.n_unit_like_roles


def _operad_for_subsystem(
    *,
    ssid: str,
    repo: str,
    adj: dict[str, list[tuple[str, str]]],
    roles: dict[str, str],
    role_public: dict[str, bool],
    g: nx.MultiDiGraph,
    view: str,
    min_support: int,
    max_path_nodes: int,
    max_exemplars: int,
    max_paths: int,
    config_json: str,
    gen_at: str,
) -> tuple[list[dict[str, object]], _Tallies, bool]:
    """Mine one subsystem's composition patterns for one role view."""

    def qn(n: str) -> str:
        return (g.nodes.get(n, {}).get("qualified_name") or n)

    # ── 1. enumerate concrete role-paths (nodes 2..max_path_nodes) ──
    # sig -> {"support": set of node-tuples, "exemplars": [qn-path strings],
    #         "edge_kinds": set}. sig = (roles..., "|", edge_kinds...) tuple.
    path_sigs: dict[tuple, _PathAgg] = {}
    truncated = False
    n_paths = 0

    # length-1 (2 nodes): every internal edge with both endpoints role-typed.
    for u in sorted(adj):
        ru = roles.get(u)
        if ru is None:
            continue
        for v, k in sorted(adj[u]):
            rv = roles.get(v)
            if rv is None:
                continue
            _accumulate(path_sigs, (ru, rv), (k,), (u, v), qn, max_exemplars)
            n_paths += 1
            if n_paths > max_paths:
                truncated = True
                break
        if truncated:
            break

    # length-2 (3 nodes): u → v → w, distinct nodes, all role-typed.
    if max_path_nodes >= 3 and not truncated:
        for u in sorted(adj):
            ru = roles.get(u)
            if ru is None:
                continue
            for v, k1 in sorted(adj[u]):
                rv = roles.get(v)
                if rv is None or v == u:
                    continue
                for w, k2 in sorted(adj.get(v, [])):
                    rw = roles.get(w)
                    if rw is None or w == u or w == v:
                        continue
                    _accumulate(
                        path_sigs, (ru, rv, rw), (k1, k2), (u, v, w), qn, max_exemplars
                    )
                    n_paths += 1
                    if n_paths > max_paths:
                        truncated = True
                        break
                if truncated:
                    break
            if truncated:
                break

    # ── 2a. path operations: role-paths with support ≥ min_support ──
    stat = _Tallies()
    out: list[dict[str, object]] = []

    # index of surviving generator (arity-1) ops: (r_i, r_j) present? and their
    # support — used by the missing-pattern diagnostic. Keyed by role tuple,
    # ignoring edge kind; role-level adjacency need not connect real instances.
    gen_support: dict[tuple[str, str], int] = {}
    two_step_present: set[tuple[str, str, str]] = set()

    kept_paths: list[tuple[tuple, _PathAgg]] = []
    for sig, agg in path_sigs.items():
        support = len(agg.support)
        if support < min_support:
            continue
        kept_paths.append((sig, agg))
        role_seq = sig[0]  # the role tuple
        if len(role_seq) == 2:
            gen_support[(role_seq[0], role_seq[1])] = max(
                gen_support.get((role_seq[0], role_seq[1]), 0), support
            )
        elif len(role_seq) == 3:
            two_step_present.add((role_seq[0], role_seq[1], role_seq[2]))

    for sig, agg in kept_paths:
        role_seq: tuple[str, ...] = sig[0]
        edge_kinds = sorted(set(sig[1]))
        support = len(agg.support)
        input_roles = list(role_seq[:-1])
        output_role = role_seq[-1]
        arity = len(input_roles)
        assoc, violations = _associativity(role_seq, gen_support, two_step_present)
        is_boundary = _any_public(role_seq, role_public)
        out.append(
            _row(
                ssid, repo, "path", view, arity, input_roles, output_role,
                edge_kinds, support, is_boundary, assoc, violations, "",
                agg.exemplars, config_json, gen_at,
            )
        )
        stat.n_path_ops += 1
        stat.n_operations += 1
        if is_boundary:
            stat.n_boundary_ops += 1

    # ── 2b. fan-in operations: n-ary combinations at a target ──
    # For each target node, the SET of distinct source roles over incoming
    # internal edges. signature = (output_role, frozenset(source_roles)). arity
    # = |source_roles| (≥ 2 to be genuinely n-ary). support = # targets matching.
    incoming: dict[str, list[tuple[str, str]]] = defaultdict(list)  # v -> [(u, kind)]
    for u in adj:
        for v, k in adj[u]:
            incoming[v].append((u, k))

    fan_sigs: dict[tuple, _PathAgg] = {}
    for v in sorted(incoming):
        rv = roles.get(v)
        if rv is None:
            continue
        src_roles: set[str] = set()
        src_kinds: set[str] = set()
        exemplar_srcs: list[str] = []
        for u, k in sorted(incoming[v]):
            ru = roles.get(u)
            if ru is None or ru == rv:
                continue  # skip self-role loops in the fan
            src_roles.add(ru)
            src_kinds.add(k)
            exemplar_srcs.append(qn(u))
        if len(src_roles) < 2:
            continue  # not genuinely n-ary
        sig = (rv, tuple(sorted(src_roles)), tuple(sorted(src_kinds)))
        agg = fan_sigs.setdefault(sig, _PathAgg())
        agg.support.add(v)
        if len(agg.exemplars) < max_exemplars:
            fan_str = " + ".join(exemplar_srcs[:4]) + " -> " + qn(v)
            agg.exemplars.append(fan_str)

    for sig, agg in fan_sigs.items():
        support = len(agg.support)
        if support < min_support:
            continue
        output_role, src_roles, src_kinds = sig
        input_roles = list(src_roles)
        arity = len(input_roles)
        is_boundary = _any_public((output_role, *src_roles), role_public)
        out.append(
            _row(
                ssid, repo, "fan_in", view, arity, input_roles, output_role,
                sorted(src_kinds), support, is_boundary, True, 0, "",
                agg.exemplars, config_json, gen_at,
            )
        )
        stat.n_fan_in_ops += 1
        stat.n_operations += 1
        if is_boundary:
            stat.n_boundary_ops += 1

    # ── 3. pattern diagnostics: legacy non_operadic bookkeeping ──
    # 3a. missing_composite: role pairs R_i→R_j and R_j→R_k both recur, but no
    #     R_i→R_j→R_k pattern survives enumeration and support filtering.
    #     This can reflect the quotient, thresholds, or truncated sampling.
    by_mid: dict[str, list[tuple[str, str]]] = defaultdict(list)  # R_j -> [(R_i, R_j)]
    out_edges: dict[str, list[str]] = defaultdict(list)  # R_j -> [R_k]
    for (ri, rj) in gen_support:
        by_mid[rj].append((ri, rj))
        out_edges[ri].append(rj)  # ri -> rj as an outgoing generator from ri
    for rj, ins in by_mid.items():
        outs = out_edges.get(rj, [])  # R_j -> R_k generators
        for (ri, _rj) in ins:
            for rk in outs:
                if ri == rj or rk == rj or ri == rk:
                    continue  # ignore degenerate composites
                if (ri, rj, rk) in two_step_present:
                    continue  # retained two-edge pattern, not an associativity proof
                sup = min(gen_support[(ri, rj)], gen_support[(rj, rk)])
                is_boundary = _any_public((ri, rj, rk), role_public)
                ex = [f"{ri} -> {rj}  &  {rj} -> {rk}  (composite {ri}->{rj}->{rk} unobserved)"]
                out.append(
                    _row(
                        ssid, repo, "non_operadic", view, 2, [ri, rj], rk,
                        [], sup, is_boundary, False, 1, "missing_composite",
                        ex, config_json, gen_at,
                    )
                )
                stat.n_non_operadic += 1
                stat.n_missing_composite += 1
                if is_boundary:
                    stat.n_boundary_ops += 1

    # 3b. back_call_cycle: opposite role pairs recur; concrete edges may differ.
    # Cycles are not generic category/operad violations; the label is legacy.
    seen_cycle: set[tuple[str, str]] = set()
    for (ri, rj) in sorted(gen_support):
        if ri == rj:
            continue
        if (rj, ri) in gen_support and (rj, ri) not in seen_cycle:
            seen_cycle.add((ri, rj))
            sup = min(gen_support[(ri, rj)], gen_support[(rj, ri)])
            is_boundary = _any_public((ri, rj), role_public)
            ex = [f"{ri} <-> {rj}  (both directions observed: {ri}->{rj} and {rj}->{ri})"]
            out.append(
                _row(
                    ssid, repo, "non_operadic", view, 2, [ri, rj], ri,
                    [], sup, is_boundary, False, 1, "back_call_cycle",
                    ex, config_json, gen_at,
                )
            )
            stat.n_non_operadic += 1
            stat.n_back_call_cycle += 1
            if is_boundary:
                stat.n_boundary_ops += 1

    stat.n_operations += stat.n_non_operadic

    # ── shortcut-pattern roles: R with A→R→B recurring AND direct A→B ──
    # Legacy unit-like statistic, not proof that R acts as an identity (§4.3).
    stat.n_unit_like_roles = _count_unit_like(two_step_present, gen_support)

    return out, stat, truncated


# ----- helpers -----


@dataclass(slots=True)
class _PathAgg:
    support: set = field(default_factory=set)  # distinct concrete node-tuples (or targets)
    exemplars: list = field(default_factory=list)  # concrete qn-path strings


def _accumulate(
    sigs: dict[tuple, _PathAgg],
    role_seq: tuple[str, ...],
    edge_kinds: tuple[str, ...],
    nodes: tuple[str, ...],
    qn,
    max_exemplars: int,
) -> None:
    """Record one concrete role-path instance under its (roles, kinds) signature."""
    sig = (role_seq, edge_kinds)
    agg = sigs.setdefault(sig, _PathAgg())
    if nodes in agg.support:
        return
    agg.support.add(nodes)
    if len(agg.exemplars) < max_exemplars:
        agg.exemplars.append(" -> ".join(qn(n) for n in nodes))


def _associativity(
    role_seq: tuple[str, ...],
    gen_support: dict[tuple[str, str], int],
    two_step_present: set[tuple[str, str, str]],
) -> tuple[bool, int]:
    """Return the legacy acceptance flag for an observed path pattern.

    This helper always returns ``(True, 0)``; it does not test associativity
    or use ``gen_support`` / ``two_step_present``. Observing two edges is not
    a law proof. Missing retained patterns are diagnosed separately using the
    legacy ``non_operadic`` and ``law_violations`` labels.
    """
    if len(role_seq) <= 2:
        return True, 0
    # Legacy flag for a retained path, not an associativity check.
    return True, 0


def _count_unit_like(
    two_step_present: set[tuple[str, str, str]],
    gen_support: dict[tuple[str, str], int],
) -> int:
    """Count roles R where A→R→B and direct A→B patterns both recur.

    The legacy unit-like name does not establish identity or pass-through
    behavior; the direct and two-edge patterns can have different instances.
    """
    units: set[str] = set()
    for (a, r, b) in two_step_present:
        if (a, b) in gen_support:
            units.add(r)
    return len(units)


def _any_public(role_seq: Sequence[str], role_public: dict[str, bool]) -> bool:
    return any(role_public.get(r, False) for r in role_seq)


def _resolve_views(view: str) -> list[str]:
    v = view.strip().lower()
    if v == "both":
        return ["orbit", "similarity"]
    if v in ("orbit", "similarity"):
        return [v]
    raise ValueError(f"view must be 'orbit', 'similarity', or 'both'; got {view!r}")


def _role_maps(
    presentations: pl.DataFrame,
    view: str,
) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, bool]]]:
    """Build ``subsystem_id -> symbol_id -> role_id`` and ``subsystem_id ->
    role_id -> is_public`` for one role view from ``presentations.parquet``."""
    sym2role: dict[str, dict[str, str]] = defaultdict(dict)
    role_public: dict[str, dict[str, bool]] = defaultdict(dict)
    if presentations is None or presentations.height == 0:
        return sym2role, role_public
    for row in presentations.iter_rows(named=True):
        if row.get("view") != view:
            continue
        ssid = row["subsystem_id"]
        role_id = row["role_id"]
        participation = row.get("interface_participation") or []
        role_public[ssid][role_id] = len(list(participation)) > 0
        for m in row.get("members") or []:
            sym2role[ssid][m] = role_id
    return sym2role, role_public


def _row(
    subsystem_id: str,
    repo: str,
    op_kind: str,
    view: str,
    arity: int,
    input_roles: list[str],
    output_role: str,
    edge_kinds: list[str],
    support: int,
    is_boundary: bool,
    associative: bool,
    law_violations: int,
    violation_kind: str,
    exemplars: list[str],
    config_json: str,
    gen_at: str,
) -> dict[str, object]:
    return {
        "subsystem_id": subsystem_id,
        "repo": repo,
        "operation_id": _operation_id(
            subsystem_id, view, op_kind, input_roles, output_role, edge_kinds,
            violation_kind, config_json,
        ),
        "view": view,
        "op_kind": op_kind,
        "arity": int(arity),
        "input_roles": list(input_roles),
        "output_role": output_role,
        "edge_kinds": list(edge_kinds),
        "support": int(support),
        "is_boundary_op": bool(is_boundary),
        "associative_observed": bool(associative),
        "law_violations": int(law_violations),
        "violation_kind": violation_kind,
        "exemplar_paths": list(exemplars),
        "invariance_tier": INVARIANCE_TIER,
        "config": config_json,
        "generated_at": gen_at,
        "schema_version": SCHEMA_VERSION,
    }


def _operation_id(
    subsystem_id: str,
    view: str,
    op_kind: str,
    input_roles: list[str],
    output_role: str,
    edge_kinds: list[str],
    violation_kind: str,
    config_json: str,
) -> str:
    """Content-addressed op id: blake3 of the subsystem + view + kind + role
    signature + edge kinds + config. Excludes ``generated_at`` so re-runs over
    the same partition + roles are byte-identical."""
    h = blake3()
    for part in (
        subsystem_id, view, op_kind, "\x1f".join(input_roles), output_role,
        "\x1f".join(edge_kinds), violation_kind, config_json,
    ):
        h.update(part.encode("utf-8"))
        h.update(b"\x00")
    return "op:" + h.hexdigest()[:24]


def _operads_schema() -> dict[str, pl.DataType]:
    return {
        "subsystem_id": pl.Utf8,
        "repo": pl.Utf8,
        "operation_id": pl.Utf8,
        "view": pl.Utf8,
        "op_kind": pl.Utf8,
        "arity": pl.Int64,
        "input_roles": pl.List(pl.Utf8),
        "output_role": pl.Utf8,
        "edge_kinds": pl.List(pl.Utf8),
        "support": pl.Int64,
        "is_boundary_op": pl.Boolean,
        "associative_observed": pl.Boolean,
        "law_violations": pl.Int64,
        "violation_kind": pl.Utf8,
        "exemplar_paths": pl.List(pl.Utf8),
        "invariance_tier": pl.Utf8,
        "config": pl.Utf8,
        "generated_at": pl.Utf8,
        "schema_version": pl.Int64,
    }


def write_operads(df: pl.DataFrame, out_path: str | Path) -> None:
    p = Path(out_path).expanduser().resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    df.select(OPERADS_COLUMNS).write_parquet(p)


def write_manifest(
    data_dir: str | Path,
    *,
    n_operads: int,
    generated_at: str | None = None,
) -> Path:
    """Merge composition-pattern presence into ``<data_dir>/ctkr/manifest.json``.

    Additive: reads any existing manifest and updates only legacy operad fields;
    every other presence flag / counter survives intact (multiple commands share
    the file). Creates a fresh manifest if none exists.
    """
    base = Path(data_dir).expanduser().resolve()
    manifest_path = base / "ctkr" / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    existing: dict = {}
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            logger.warning("manifest.json at %s is malformed; overwriting", manifest_path)
            existing = {}

    merged = {
        **existing,
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at or datetime.now(tz=UTC).isoformat(),
        "metacoding_data_dir": str(base),
        "operads": True,
        "n_operads": int(n_operads),
    }
    manifest_path.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    return manifest_path


__all__ = [
    "DEFAULT_MIN_SUPPORT",
    "DEFAULT_MAX_PATH_NODES",
    "DEFAULT_MAX_EXEMPLARS",
    "DEFAULT_VIEW",
    "OperadStats",
    "compute_operads",
    "write_operads",
    "write_manifest",
]
