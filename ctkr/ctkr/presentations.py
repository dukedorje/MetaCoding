"""Structural role inventory — Stage C / §4.1 (subsystem-extraction T3).

Group each subsystem's members by **depth-1** structural profiles to surface
candidate role classes. Equal typed-degree vectors can merge structurally or
behaviorally different symbols. Depth 2 adds neighbor means and can split some
of these ties; neither depth computes automorphism orbits or exact WL classes.
The presentation/generator vocabulary in the design is research inspiration,
not a claim that these classes recover a categorical presentation.

Two views are always emitted:

- **exact-profile class** (legacy wire value ``orbit``) — members with equal
  profile tuples share a class. Equality is tested after Float64 conversion,
  not as byte equality of the original artifacts. No threshold is used, and
  ``persistence=1.0`` marks definitional equality, not semantic certainty.
- **similarity** — cosine-threshold connected components over the profile
  vectors, with a threshold sweep supplying per-class ``persistence`` (mean
  within-class co-association across the sweep). Transitive chains can join
  members whose pairwise cosine is below the threshold. Discretisation stays
  at query time; the vectors are not quantised here.

The ``presentations`` artifact/API and ``orbit`` enum, helper, and statistics
names remain compatibility identifiers. Public wording is structural analysis.

The **zero-profile floor** (§2.3): edgeless members have a zero profile vector.
In the exact-profile view they collapse to one class (all-zeros is one tuple).
In the similarity view cosine is undefined (zero norm), so we group every
zero-profile member into one dedicated "isolated" class per view. These profiles
cannot distinguish them. Zero vectors can also result from filtering edge kinds
or zero weights, so they do not always mean the original node was edgeless.
The T5 NL lane can supply source-text context.

Every class carries: member list, the structural-profile **centroid**, an **exemplar**
(the member nearest the centroid — a re-implementer needs the role plus one
concrete instance, not all 14), cardinality, and its **interface participation**
(does any member appear in the subsystem's ``provides``/``consumes`` surface? —
the re-implementer's first question about any role is whether it is public).

Determinism: classes are ranked ``(-size, min member id)`` and members sorted, so
the same profiles + partition yield byte-identical parquet across runs regardless
of ``PYTHONHASHSEED``. ``role_id`` is content-addressed and excludes
``generated_at``.

Structure-only lane (§5): this module reads exclusively the (name-blind) profile
vectors + the T1 partition + the T2 interface rows. No identifier text influences
any class boundary. The NL lane (T5) labels these classes later.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import polars as pl
from blake3 import blake3

from ctkr.schema import (
    PRESENTATIONS_COLUMNS,
    SCHEMA_VERSION,
)

logger = logging.getLogger("ctkr.presentations")

# ── defaults (dials, not truths) ──
# Cosine threshold the emitted similarity view is cut at, plus the sweep the
# per-class persistence is measured over. The default is always unioned into the
# sweep so the emitted partition is one of the points it is scored against. 0.90
# is a deliberately strict heuristic for similar typed-edge mixes within a
# subsystem. It does not establish true roles or automorphism orbits.
DEFAULT_THRESHOLD: float = 0.90
DEFAULT_SWEEP: tuple[float, ...] = (0.80, 0.85, 0.90, 0.95, 0.99)
DEFAULT_PROFILE_DEPTH: int = 1


@dataclass(slots=True, frozen=True)
class RoleInventoryStats:
    n_subsystems: int
    n_members_profiled: int
    n_members_no_profile: int
    n_roles_orbit: int
    n_roles_similarity: int
    # n_members_profiled / n_roles_* — the design's compression ratio.
    compression_orbit: float
    compression_similarity: float
    total_seconds: float
    per_subsystem: dict[str, dict[str, float]] = field(default_factory=dict)


# ----- public API -----


def compute_role_inventory(
    hom_profiles: pl.DataFrame,
    members: pl.DataFrame,
    interfaces: pl.DataFrame | None = None,
    *,
    default_threshold: float = DEFAULT_THRESHOLD,
    sweep: Sequence[float] = DEFAULT_SWEEP,
    profile_depth: int = DEFAULT_PROFILE_DEPTH,
    generated_at: str | None = None,
) -> tuple[pl.DataFrame, RoleInventoryStats]:
    """Group each subsystem's members into structural role classes (both views).

    Parameters
    ----------
    hom_profiles
        Structural profiles in legacy ``hom_profiles.parquet`` — columns
        ``symbol_id, repo, qualified_name, profile_vec``.
        Should be **depth 1** (the role-surfacing dial); a
        different depth is accepted but recorded in ``profile_depth`` so the
        artifact is self-describing. Filtering ``--kinds-filter file`` upstream
        is recommended (file rows carry only ``CONTAINS:in`` and are not roles).
    members
        ``subsystem_members.parquet`` — the T1 partition (columns
        ``subsystem_id, symbol_id, repo, ...``). Members without a profile row
        are dropped from the inventory (counted in stats) — they are the NL-only
        floor the T5 lane specs from text.
    interfaces
        Optional ``interfaces.parquet`` (T2). When present, each class's
        ``interface_participation`` is populated from whether any member appears
        as an internal (or rolled-up export) symbol on a ``provides``/
        ``consumes`` row of its subsystem. When ``None`` every class gets an
        empty participation list.

    Returns
    -------
    (pl.DataFrame, RoleInventoryStats)
        DataFrame columns in ``PRESENTATIONS_COLUMNS`` order — two rows-groups
        per subsystem (legacy ``view="orbit"`` for exact-profile classes,
        and ``view="similarity"``).
    """
    start = time.perf_counter()
    gen_at = generated_at or datetime.now(tz=UTC).isoformat()

    sweep_thr = sorted(
        {round(float(t), 6) for t in sweep} | {round(float(default_threshold), 6)}
    )

    config = {
        "stage": "C",
        "section": "role_inventory",
        "default_threshold": float(default_threshold),
        "sweep": [float(t) for t in sweep_thr],
        "profile_depth": int(profile_depth),
        "schema_version": SCHEMA_VERSION,
    }
    config_json = json.dumps(config, sort_keys=True, separators=(",", ":"))

    # ── profile lookup (symbol_id -> (qualified_name, np.float64 vector)) ──
    prof_qn: dict[str, str] = {}
    prof_vec: dict[str, np.ndarray] = {}
    for row in hom_profiles.iter_rows(named=True):
        sid = row["symbol_id"]
        prof_qn[sid] = row.get("qualified_name") or ""
        prof_vec[sid] = np.asarray(row["profile_vec"], dtype=np.float64)

    # ── interface participation lookup: subsystem_id -> symbol_id -> {dirs} ──
    iface_part = _interface_participation(interfaces)

    # ── group members by subsystem (deterministic order) ──
    by_sub: dict[str, tuple[str, list[str]]] = {}
    for row in members.iter_rows(named=True):
        ssid = row["subsystem_id"]
        repo = row.get("repo") or ""
        by_sub.setdefault(ssid, (repo, []))[1].append(row["symbol_id"])

    rows: list[dict[str, object]] = []
    per_subsystem: dict[str, dict[str, float]] = {}
    n_members_profiled = 0
    n_members_no_profile = 0
    n_roles_orbit = 0
    n_roles_similarity = 0
    n_subsystems_done = 0

    for ssid in sorted(by_sub):
        repo, member_ids = by_sub[ssid]
        # Keep only members that carry a profile; the rest are the NL-only floor.
        profiled = sorted(m for m in member_ids if m in prof_vec)
        n_members_no_profile += len(member_ids) - len(profiled)
        if not profiled:
            continue
        n_subsystems_done += 1
        n_members_profiled += len(profiled)
        part = iface_part.get(ssid, {})

        orbit_classes = _orbit_classes(profiled, prof_vec)
        sim_classes, sim_persist = _similarity_classes(
            profiled, prof_vec, default_threshold=default_threshold, sweep=sweep_thr
        )

        for view, classes, persist in (
            ("orbit", orbit_classes, None),
            ("similarity", sim_classes, sim_persist),
        ):
            for members_sorted in classes:
                centroid = _centroid(members_sorted, prof_vec)
                exemplar = _exemplar(members_sorted, prof_vec, centroid)
                participation = _class_participation(members_sorted, part)
                pers = 1.0 if persist is None else persist[frozenset(members_sorted)]
                granularity = "exact" if view == "orbit" else _thr_label(default_threshold)
                role_id = _role_id(ssid, view, config_json, members_sorted)
                rows.append(
                    {
                        "subsystem_id": ssid,
                        "repo": repo,
                        "role_id": role_id,
                        "view": view,
                        "granularity": granularity,
                        "cardinality": len(members_sorted),
                        "members": members_sorted,
                        "exemplar_symbol_id": exemplar,
                        "exemplar_qualified_name": prof_qn.get(exemplar, ""),
                        "profile_centroid": [float(x) for x in centroid],
                        "profile_depth": int(profile_depth),
                        "interface_participation": participation,
                        "persistence": max(0.0, min(1.0, float(pers))),
                        "config": config_json,
                        "generated_at": gen_at,
                        "schema_version": SCHEMA_VERSION,
                    }
                )
            if view == "orbit":
                n_roles_orbit += len(classes)
            else:
                n_roles_similarity += len(classes)

        per_subsystem[ssid] = {
            "n_members": float(len(profiled)),
            "n_roles_orbit": float(len(orbit_classes)),
            "n_roles_similarity": float(len(sim_classes)),
            "compression_orbit": (
                len(profiled) / len(orbit_classes) if orbit_classes else 0.0
            ),
            "compression_similarity": (
                len(profiled) / len(sim_classes) if sim_classes else 0.0
            ),
        }

    df = pl.DataFrame(rows, schema=_presentations_schema()).select(PRESENTATIONS_COLUMNS)
    # Deterministic, byte-stable row order.
    df = df.sort(["subsystem_id", "view", "role_id"])

    stats = RoleInventoryStats(
        n_subsystems=n_subsystems_done,
        n_members_profiled=n_members_profiled,
        n_members_no_profile=n_members_no_profile,
        n_roles_orbit=n_roles_orbit,
        n_roles_similarity=n_roles_similarity,
        compression_orbit=(n_members_profiled / n_roles_orbit if n_roles_orbit else 0.0),
        compression_similarity=(
            n_members_profiled / n_roles_similarity if n_roles_similarity else 0.0
        ),
        total_seconds=round(time.perf_counter() - start, 3),
        per_subsystem=per_subsystem,
    )
    return df, stats


# ----- per-view class construction -----


def _orbit_classes(
    members: list[str], prof_vec: dict[str, np.ndarray]
) -> list[list[str]]:
    """Exact-profile classes under tuple equality after Float64 conversion.

    The legacy helper name does not mean automorphism or WL orbits.
    Returns each class's member list (sorted), classes ranked ``(-size, min
    member id)``. All-zero vectors collapse into one class naturally (one tuple).
    """
    buckets: dict[tuple[float, ...], list[str]] = {}
    for m in members:
        key = tuple(prof_vec[m].tolist())
        buckets.setdefault(key, []).append(m)
    classes = [sorted(v) for v in buckets.values()]
    classes.sort(key=lambda c: (-len(c), c[0]))
    return classes


def _similarity_classes(
    members: list[str],
    prof_vec: dict[str, np.ndarray],
    *,
    default_threshold: float,
    sweep: Sequence[float],
) -> tuple[list[list[str]], dict[frozenset[str], float]]:
    """Cosine-threshold connected components at the default threshold, plus a
    per-class persistence (mean within-class co-association across ``sweep``).

    Zero-norm (edgeless) members are grouped into a single dedicated "isolated"
    class rather than exploded into singletons — cosine cannot discriminate
    them (the §2.3 floor). Their persistence is 1.0 (they are always identical).
    """
    idx = {m: i for i, m in enumerate(members)}
    mat = np.vstack([prof_vec[m] for m in members])  # (n, d)
    norms = np.linalg.norm(mat, axis=1)
    nonzero_mask = norms > 0.0
    nonzero = [members[i] for i in range(len(members)) if nonzero_mask[i]]
    zero = [members[i] for i in range(len(members)) if not nonzero_mask[i]]

    # Cosine similarity matrix over the non-zero members only.
    classes: list[list[str]] = []
    persist: dict[frozenset[str], float] = {}

    if nonzero:
        sub_idx = {m: i for i, m in enumerate(nonzero)}
        sub_mat = mat[[idx[m] for m in nonzero]]
        sim = _cosine_matrix(sub_mat)

        default_labels = _components_at(sim, nonzero, threshold=default_threshold)
        # Sweep: label vector per threshold, for co-association persistence.
        n_runs = len(sweep)
        label_runs: list[dict[str, int]] = [
            _label_map(_components_at(sim, nonzero, threshold=t), nonzero)
            for t in sweep
        ]

        # Group non-zero members by their default component (ranked list).
        for comp in default_labels:
            classes.append(sorted(comp))
        # Persistence per default class: mean pairwise co-association across sweep.
        for comp in default_labels:
            comp_sorted = sorted(comp)
            persist[frozenset(comp_sorted)] = _co_association(
                comp_sorted, label_runs, n_runs
            )
    if zero:
        zero_sorted = sorted(zero)
        classes.append(zero_sorted)
        persist[frozenset(zero_sorted)] = 1.0

    # Final deterministic ranking across all classes (non-zero + isolated).
    classes.sort(key=lambda c: (-len(c), c[0]))
    return classes, persist


def _cosine_matrix(mat: np.ndarray) -> np.ndarray:
    """Pairwise cosine similarity of the rows of ``mat`` (all rows non-zero)."""
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    unit = mat / norms
    sim = unit @ unit.T
    np.clip(sim, -1.0, 1.0, out=sim)
    return sim


def _components_at(
    sim: np.ndarray, members: list[str], *, threshold: float
) -> list[list[str]]:
    """Connected components of the graph {(a,b): cos(a,b) >= threshold}.

    Union-find over member indices (no scipy). Returns component member lists
    ranked ``(-size, min member id)`` — a total order independent of set
    iteration, so the label integers are stable across processes.
    """
    n = len(members)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            # Attach higher root onto lower for determinism.
            if ra < rb:
                parent[rb] = ra
            else:
                parent[ra] = rb

    for i in range(n):
        for j in range(i + 1, n):
            if sim[i, j] >= threshold:
                union(i, j)

    comp_map: dict[int, list[str]] = {}
    for i in range(n):
        comp_map.setdefault(find(i), []).append(members[i])
    comps = [sorted(v) for v in comp_map.values()]
    comps.sort(key=lambda c: (-len(c), c[0]))
    return comps


def _label_map(components: list[list[str]], members: list[str]) -> dict[str, int]:
    lab: dict[str, int] = {}
    for cid, comp in enumerate(components):
        for m in comp:
            lab[m] = cid
    return lab


def _co_association(
    members: list[str], label_runs: list[dict[str, int]], n_runs: int
) -> float:
    """Mean pairwise co-association of ``members`` across the sweep runs.

    For each ordered pair, fraction of runs where they share a component;
    averaged over all pairs. A singleton class is definitionally stable → 1.0.
    """
    m = len(members)
    if m <= 1:
        return 1.0
    total = 0.0
    pairs = 0
    for a in range(m):
        for b in range(a + 1, m):
            shared = sum(
                1
                for run in label_runs
                if run[members[a]] == run[members[b]]
            )
            total += shared / n_runs
            pairs += 1
    return total / pairs if pairs else 1.0


# ----- class-level helpers -----


def _centroid(members: list[str], prof_vec: dict[str, np.ndarray]) -> np.ndarray:
    return np.mean(np.vstack([prof_vec[m] for m in members]), axis=0)


def _exemplar(
    members: list[str], prof_vec: dict[str, np.ndarray], centroid: np.ndarray
) -> str:
    """Member nearest the centroid by cosine (ties → min symbol_id).

    A zero centroid (the isolated class) makes every cosine 0, so the tie-break
    on ``min symbol_id`` decides — deterministic either way.
    """
    cn = float(np.linalg.norm(centroid))
    best: str | None = None
    best_sim = -2.0
    for m in sorted(members):
        v = prof_vec[m]
        vn = float(np.linalg.norm(v))
        sim = 0.0 if cn == 0.0 or vn == 0.0 else float(v @ centroid) / (vn * cn)
        if sim > best_sim + 1e-12:
            best_sim = sim
            best = m
    return best if best is not None else members[0]


def _class_participation(members: list[str], part: dict[str, set[str]]) -> list[str]:
    dirs: set[str] = set()
    for m in members:
        dirs |= part.get(m, set())
    return sorted(dirs)


def _interface_participation(
    interfaces: pl.DataFrame | None,
) -> dict[str, dict[str, set[str]]]:
    """subsystem_id -> symbol_id -> {"provides","consumes"} from interfaces.parquet.

    A member counts as participating in a direction if it is the row's
    ``internal_symbol_id`` *or* its rolled-up ``internal_export_symbol_id`` (a
    field/param of an exported symbol makes the export public). Absent/ empty
    interfaces → empty mapping (every class gets [] participation).
    """
    out: dict[str, dict[str, set[str]]] = {}
    if interfaces is None or interfaces.height == 0:
        return out
    cols = set(interfaces.columns)
    have_export = "internal_export_symbol_id" in cols
    for row in interfaces.iter_rows(named=True):
        ssid = row["subsystem_id"]
        direction = row["direction"]
        sub = out.setdefault(ssid, {})
        sid = row.get("internal_symbol_id")
        if sid:
            sub.setdefault(sid, set()).add(direction)
        if have_export:
            exp = row.get("internal_export_symbol_id")
            if exp:
                sub.setdefault(exp, set()).add(direction)
    return out


def _thr_label(threshold: float) -> str:
    return f"cos>={threshold:g}"


def _role_id(subsystem_id: str, view: str, config_json: str, members: list[str]) -> str:
    """Content-addressed role id: blake3(subsystem_id + view + config + members).

    Excludes ``generated_at`` so re-runs over the same partition + profiles are
    byte-identical.
    """
    member_digest = blake3("\n".join(members).encode("utf-8")).hexdigest()
    h = blake3()
    h.update(subsystem_id.encode("utf-8"))
    h.update(b"\x00")
    h.update(view.encode("utf-8"))
    h.update(b"\x00")
    h.update(config_json.encode("utf-8"))
    h.update(b"\x00")
    h.update(member_digest.encode("utf-8"))
    return "role:" + h.hexdigest()[:24]


def _presentations_schema() -> dict[str, pl.DataType]:
    return {
        "subsystem_id": pl.Utf8,
        "repo": pl.Utf8,
        "role_id": pl.Utf8,
        "view": pl.Utf8,
        "granularity": pl.Utf8,
        "cardinality": pl.Int64,
        "members": pl.List(pl.Utf8),
        "exemplar_symbol_id": pl.Utf8,
        "exemplar_qualified_name": pl.Utf8,
        "profile_centroid": pl.List(pl.Float64),
        "profile_depth": pl.Int64,
        "interface_participation": pl.List(pl.Utf8),
        "persistence": pl.Float64,
        "config": pl.Utf8,
        "generated_at": pl.Utf8,
        "schema_version": pl.Int64,
    }


def write_presentations(df: pl.DataFrame, out_path: str | Path) -> None:
    p = Path(out_path).expanduser().resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    df.select(PRESENTATIONS_COLUMNS).write_parquet(p)


def write_manifest(
    data_dir: str | Path,
    *,
    n_presentations: int,
    generated_at: str | None = None,
) -> Path:
    """Merge role-inventory presence into ``<data_dir>/ctkr/manifest.json``.

    Additive: reads any existing manifest and updates only the presentation
    fields; every other presence flag / counter survives intact (multiple
    commands share the file). Creates a fresh manifest if none exists.
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
        "presentations": True,
        "n_presentations": int(n_presentations),
    }
    manifest_path.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    return manifest_path


__all__ = [
    "DEFAULT_THRESHOLD",
    "DEFAULT_SWEEP",
    "DEFAULT_PROFILE_DEPTH",
    "RoleInventoryStats",
    "compute_role_inventory",
    "write_presentations",
    "write_manifest",
]
