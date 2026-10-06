/**
 * Approximate structural alignment (Phase 2b, MetaCoding §6 Task 2).
 *
 * Searches for a partial alignment between two indexed typed graphs. Edge
 * preservation is scored, not guaranteed. This is not a proof of functor laws,
 * categorical equivalence, graph isomorphism, or behavioral equivalence.
 * Category theory remains research inspiration in
 * docs/design/ct-functor-discovery.md §2.2; pinned defaults come from
 * docs/notes/functor-spike/{README,2hop-findings}.md. The functorSearch API,
 * Functor* types, and functor artifact names remain compatibility identifiers.
 *
 * Pipeline (Steps 0-4):
 *   0. build typed adjacency (internal edges only, deterministically sorted)
 *   1. candidate blocking — DEPTH-2 structural-profile KNN + RELATIVE-CUT
 *   2. similarity-flooding propagation (alpha=0.3, rounds=8) with CONDITIONAL
 *      competitive (Sinkhorn-style) normalization + kind-discriminativeness
 *      weights + seed-confidence damping
 *   3. arc-consistency pruning (beta=0.25) + GREEDY extraction + margin column
 *   4. fidelity scoring + bounded drop/swap repair
 *
 * This module is a PURE algorithm over in-memory fixtures: it consumes
 * objects (with lossy depth-2 degree/neighbor-mean profiles), typed edges, and
 * a config, and returns the mapping + alignment metrics. The batch runner
 * (Task 3) wires it to `CtkrHandle` (artifacts.ts) for structural-profile rows
 * and the graph store for typed edges; `buildFunctorInput` is the adapter shape it
 * feeds. Keeping the core pure is what makes the determinism contract testable
 * on hand-built fixtures.
 *
 * Determinism contract (§2.2 "Convergence & determinism"): adjacency lists are
 * sorted by (kind, dir, other) at build time; float accumulation is sequential
 * in sorted order (never a parallel reduction — non-associativity would break
 * byte-identical artifacts); candidate/extraction ordering breaks ties
 * lexicographically. Same inputs + config ⇒ byte-identical output.
 */

import { cosineSimilarity } from "./homProfile.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One Symbol node in a repo's typed graph, with its depth-2 profile. */
export interface FunctorObject {
  id: string;
  /** Symbol kind — drives the hard kind-compatibility block (§2.2 Step 1). */
  kind: string;
  /** Depth-2 structural profile (legacy command: ctkr hom-profiles --depth 2). */
  profileVec: number[];
}

/** One directed typed edge `src →kind→ dst`. */
export interface FunctorEdge {
  src: string;
  dst: string;
  kind: string;
}

/** Full search input — one directed repo pair `(A → B)`. */
export interface FunctorSearchInput {
  srcObjects: FunctorObject[];
  dstObjects: FunctorObject[];
  srcEdges: FunctorEdge[];
  dstEdges: FunctorEdge[];
  /**
   * MEMBER-SET RESTRICTION (MetaCoding-4ty, §5.6). Optional domain restriction:
   * when present, only src objects whose id is in this set participate as
   * dom(F). Edges are auto-scoped by `buildGraph` (it already drops any edge an
   * endpoint of which is not an object), so restricting the object set is
   * enough — blocking and propagation are unchanged, they just run over the
   * scoped inputs. `null`/absent = whole repo.
   */
  srcMembers?: ReadonlySet<string> | null;
  /** Codomain restriction, symmetric to `srcMembers` (only these dst objects). */
  dstMembers?: ReadonlySet<string> | null;
}

export type NormalizeMode = "none" | "sinkhorn" | "adaptive";

export interface FunctorSearchConfig {
  /** Base candidate count / relative-cut floor. */
  kSeed: number;
  /** Widened count for flat (low-margin) seed regions. */
  kWide: number;
  /** Max cosine DISTANCE for a candidate (absolute gate). */
  tauSeed: number;
  /** Flatness threshold on seed margin for adaptive widening / damping. */
  deltaFlat: number;
  /** Relative-cut width: keep candidates within deltaRel of the best sim. */
  deltaRel: number;
  /** Hard cap on candidates per source (bounds propagation cost). */
  cap: number;
  /** Anchor weight α on the seed term. */
  alpha: number;
  /** Max propagation rounds. */
  rounds: number;
  /** Arc-consistency witness-support fraction. */
  beta: number;
  /** Absolute prune floor on converged σ. */
  epsPrune: number;
  /** Repair drop threshold on pair_fidelity. */
  fMin: number;
  /** Ambiguity threshold on margin (metadata only). */
  deltaAmb: number;
  /**
   * HONEST-ACCEPTANCE gate (MetaCoding-265). Default `0` = keep current
   * behavior exactly (byte-identical). When `> 0`, a committed mapping whose
   * `margin < commitMinMargin` is FLAGGED `isAmbiguous=true` (never silently
   * dropped — it stays in the mapping so consumers can inspect it) and is
   * EXCLUDED from the "confident" coverage/fidelity accounting: on real code
   * the margin collapses (median 0.0000, ~89% of mappings margin<0.01), so a
   * near-random tie must not be reported as a confident correspondence. This
   * does NOT try to map better — it reports the truth about the mapping.
   */
  commitMinMargin: number;
  /** Early-exit convergence tolerance on max σ delta. */
  convTol: number;
  /** Competitive-normalization mode (CONDITIONAL per spike). */
  normalize: NormalizeMode;
  /** Bounded repair sweeps. */
  repairSweeps: number;
  /** Wall-clock budget (ms). Anytime: exits with current state past this. */
  budgetMs: number;
  /**
   * SAME-REPO MODE (legacy "endofunctor", MetaCoding-4ty). When true, the
   * trivial `s ↦ s` diagonal candidate is dropped at blocking time, so a
   * single-repo search surfaces candidate INTERNAL correspondences (similar
   * subsystems / repeated patterns), not proven isomorphisms. No
   * other stage changes: diagonal pairs simply never enter the candidate space,
   * so propagation, pruning and extraction run unmodified over the off-diagonal
   * candidates. Default `false` (cross-repo alignment does not need this filter).
   */
  excludeIdentity: boolean;
}

/**
 * Pinned defaults — spike-revised, OVERRIDE the design doc where they differ.
 * See docs/notes/functor-spike/README.md "Pinned defaults (Task 2)".
 */
export const DEFAULT_FUNCTOR_CONFIG: FunctorSearchConfig = {
  kSeed: 10,
  kWide: 25,
  tauSeed: 0.3,
  deltaFlat: 0.05,
  deltaRel: 0.02, // relative-cut, NOT fixed-k (fixed-k gave 0.41 recall)
  cap: 400,
  alpha: 0.3,
  rounds: 8,
  beta: 0.25,
  epsPrune: 0.05,
  fMin: 0.1,
  deltaAmb: 0.02,
  commitMinMargin: 0, // 0 = keep current behavior (honest-acceptance gate off)
  convTol: 1e-3,
  normalize: "adaptive", // off for high-signal, on for BORDERLINE (§2.2 h.1)
  repairSweeps: 2,
  budgetMs: 120_000,
  excludeIdentity: false,
};

/** One object↦object correspondence — a `functor_edges.parquet` row shape. */
export interface FunctorMapping {
  srcId: string;
  dstId: string;
  /** Converged (pre-normalization) propagation score σ — emitted evidence. */
  similarity: number;
  /** σ gap to best unaccepted alternative for this source (§2.2 Step 3). */
  margin: number;
  /** preserved/total internal INCIDENT edges; null = no structural evidence. */
  pairFidelity: number | null;
  /** internal typed edges incident to src (evidence mass). */
  nEdgesIncident: number;
  /** of those, preserved. */
  nEdgesPreserved: number;
  /**
   * Coin-flip flag (MetaCoding-265): the accepted candidate was a near-tie
   * among structural lookalikes. `margin < deltaAmb` by default, or
   * `margin < commitMinMargin` when the honest-acceptance gate is armed.
   * Kept (not dropped) so consumers can see + discount the per-symbol claim.
   */
  isAmbiguous: boolean;
}

/** Full search result — a `functors.parquet` row plus its mapping rows. */
export interface FunctorSearchResult {
  mapping: FunctorMapping[];
  /** |dom(F)| / |O(C_A)|. */
  coverage: number;
  /** |P| / |E(dom F)|; -1 when E(dom F) = ∅ (no evidence, not perfect). */
  fidelity: number;
  nObjectsSrc: number;
  nMapped: number;
  nEdgesInternal: number;
  nEdgesPreserved: number;
  /** fraction of accepted pairs with margin < deltaAmb. */
  ambiguityRate: number;
  /**
   * Alignment-level honesty metric (MetaCoding-265): fraction of committed
   * mappings with `margin < deltaAmb`. High (~0.9 on real name-blind typed-edge
   * profiles) means the per-symbol correspondence is an aggregate-only signal —
   * fidelity/cycle-consistency remain meaningful, individual mappings are
   * coin-flip ties and must not be trusted. Equals `ambiguityRate`; surfaced
   * under the artifact-facing name that flows into FunctorRow.ambiguity_mass.
   */
  ambiguityMass: number;
  roundsRun: number;
  converged: boolean;
  budgetExhausted: boolean;
  /** whether Sinkhorn normalization was actually applied (adaptive resolves). */
  normalizationApplied: boolean;
  /** per-kind inverse-frequency weights used in propagation. */
  kindWeights: Record<string, number>;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Internal structures
// ---------------------------------------------------------------------------

type Dir = 0 | 1; // 0 = out (src→dst), 1 = in (dst←src)

interface AdjEntry {
  kind: string;
  dir: Dir;
  other: string;
}

interface BuiltGraph {
  /** id → object. */
  objs: Map<string, FunctorObject>;
  /** sorted object ids. */
  ids: string[];
  /** id → sorted adjacency (both directions, internal only, deduped). */
  adj: Map<string, AdjEntry[]>;
  /** L2 norm of each object's profile vector (cached). */
  norms: Map<string, number>;
  /** number of distinct internal directed edges. */
  nInternalEdges: number;
  /** per-kind directed internal edge frequency. */
  kindFreq: Map<string, number>;
  /** witness set: `${a}|${kind}|${dir}|${b}` present iff that typed edge exists. */
  edgeSet: Set<string>;
  /** fast index: t → "kind|dir" → neighbor ids. */
  adjByKD: Map<string, Map<string, string[]>>;
}

// ---------------------------------------------------------------------------
// Step 0 — build typed adjacency
// ---------------------------------------------------------------------------

/** Kind-compatibility grouping for the hard block (§2.2 Step 1). */
export function kindGroup(kind: string): string {
  if (kind === "function" || kind === "method") return "callable";
  if (kind === "class" || kind === "interface" || kind === "type_alias") return "type";
  if (kind === "field") return "field";
  return "other:" + kind;
}

function l2norm(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

function edgeKey(a: string, kind: string, dir: Dir, b: string): string {
  return `${a}|${kind}|${dir}|${b}`;
}

/**
 * Build the in-memory graph: objects, deterministically-sorted typed
 * adjacency restricted to internal edges (both endpoints are objects),
 * per-(src,dst,kind) deduped (mirrors the store's witness-uniqueness), plus
 * the witness set and the (kind,dir) fast index the propagation needs.
 */
function buildGraph(objects: FunctorObject[], edges: FunctorEdge[]): BuiltGraph {
  const objs = new Map<string, FunctorObject>();
  for (const o of objects) objs.set(o.id, o);
  const ids = [...objs.keys()].sort();

  const norms = new Map<string, number>();
  for (const id of ids) norms.set(id, l2norm(objs.get(id)!.profileVec));

  const adj = new Map<string, AdjEntry[]>();
  const edgeSet = new Set<string>();
  const kindFreq = new Map<string, number>();
  // Dedup directed edges by (src,kind,dst) — parallel repeats fold (Edge.count).
  const seenDirected = new Set<string>();
  let nInternalEdges = 0;

  for (const e of edges) {
    // internal only
    if (!objs.has(e.src) || !objs.has(e.dst)) continue;
    const dkey = `${e.src}|${e.kind}|${e.dst}`;
    if (seenDirected.has(dkey)) continue;
    seenDirected.add(dkey);
    nInternalEdges++;
    kindFreq.set(e.kind, (kindFreq.get(e.kind) ?? 0) + 1);

    if (!adj.has(e.src)) adj.set(e.src, []);
    adj.get(e.src)!.push({ kind: e.kind, dir: 0, other: e.dst });
    if (!adj.has(e.dst)) adj.set(e.dst, []);
    adj.get(e.dst)!.push({ kind: e.kind, dir: 1, other: e.src });

    edgeSet.add(edgeKey(e.src, e.kind, 0, e.dst));
    edgeSet.add(edgeKey(e.dst, e.kind, 1, e.src));
  }

  // Determinism: sort each adjacency list by (kind, dir, other).
  const cmpAdj = (a: AdjEntry, b: AdjEntry): number =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.dir - b.dir || (a.other < b.other ? -1 : a.other > b.other ? 1 : 0);
  for (const lst of adj.values()) lst.sort(cmpAdj);

  const adjByKD = new Map<string, Map<string, string[]>>();
  for (const [t, lst] of adj) {
    const mm = new Map<string, string[]>();
    for (const e of lst) {
      const kk = `${e.kind}|${e.dir}`;
      if (!mm.has(kk)) mm.set(kk, []);
      mm.get(kk)!.push(e.other);
    }
    adjByKD.set(t, mm);
  }

  return { objs, ids, adj, norms, nInternalEdges, kindFreq, edgeSet, adjByKD };
}

// ---------------------------------------------------------------------------
// Step 1 — candidate blocking (DEPTH-2 structural-profile KNN + relative cut)
// ---------------------------------------------------------------------------

interface Candidate {
  t: string;
  sim: number;
}

interface Blocking {
  /** src id → sorted (sim desc) candidate list. */
  cand: Map<string, Candidate[]>;
  /** src id → seed margin m(s) = sim(1) - sim(2). */
  seedMargin: Map<string, number>;
  /** src id → candidate membership set. */
  candSet: Map<string, Set<string>>;
}

/**
 * RELATIVE-CUT blocking (the spike's recall fix; fixed-k gave 0.41 recall).
 * For each source, score all kind-compatible targets by cosine similarity over
 * depth-2 profiles, keep every candidate within `deltaRel` of the best sim (the
 * whole max-similarity tied block), capped at `cap`; floor at `kSeed`.
 * Absolute `tauSeed` still gates before the relative cut.
 */
function blockCandidates(
  src: BuiltGraph,
  dst: BuiltGraph,
  cfg: FunctorSearchConfig,
): Blocking {
  // Bucket dst by kind-group (sorted ids for determinism).
  const dstByGroup = new Map<string, FunctorObject[]>();
  for (const id of dst.ids) {
    const o = dst.objs.get(id)!;
    const g = kindGroup(o.kind);
    if (!dstByGroup.has(g)) dstByGroup.set(g, []);
    dstByGroup.get(g)!.push(o);
  }

  const cand = new Map<string, Candidate[]>();
  const seedMargin = new Map<string, number>();
  const candSet = new Map<string, Set<string>>();

  for (const sid of src.ids) {
    const s = src.objs.get(sid)!;
    const sNorm = src.norms.get(sid)!;
    const pool = dstByGroup.get(kindGroup(s.kind)) ?? [];
    const scored: Candidate[] = [];
    if (sNorm > 0) {
      for (const t of pool) {
        // Same-repo mode: drop the trivial s↦s diagonal so a single-repo
        // search surfaces non-trivial internal correspondences, not the identity.
        if (cfg.excludeIdentity && t.id === sid) continue;
        if (dst.norms.get(t.id)! === 0) continue; // zero-profile target: no signal
        // reuse homProfile.ts cosine (dims equal within a corpus)
        const c = cosineSimilarity(s.profileVec, t.profileVec);
        const dist = 1 - c;
        if (dist <= cfg.tauSeed) scored.push({ t: t.id, sim: c });
      }
    }
    // sort by sim desc, tie-break by target id (determinism)
    scored.sort((a, b) => b.sim - a.sim || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

    let top: Candidate[];
    if (scored.length === 0) {
      top = [];
    } else {
      const cut = scored[0]!.sim - cfg.deltaRel;
      top = scored.filter((c) => c.sim >= cut).slice(0, cfg.cap);
      // Adaptive widening for flat seed regions: if the retained block is
      // narrower than kSeed but more candidates exist, widen (they are all
      // near-tied by construction). Never below kSeed while candidates remain.
      if (top.length < cfg.kSeed) {
        const flat =
          scored.length > 1
            ? scored[0]!.sim - scored[Math.min(cfg.kSeed, scored.length) - 1]!.sim
            : 1;
        const floor = flat < cfg.deltaFlat ? cfg.kWide : cfg.kSeed;
        top = scored.slice(0, Math.min(floor, scored.length));
      }
    }
    cand.set(sid, top);
    candSet.set(sid, new Set(top.map((c) => c.t)));
    seedMargin.set(
      sid,
      top.length >= 2 ? top[0]!.sim - top[1]!.sim : top.length === 1 ? 1.0 : 0,
    );
  }

  return { cand, seedMargin, candSet };
}

// ---------------------------------------------------------------------------
// Step 2 — similarity-flooding propagation
// ---------------------------------------------------------------------------

function computeKindWeights(kindFreq: Map<string, number>): Map<string, number> {
  // w_k ∝ 1/log(2 + freq_k), normalized to mean 1. Deterministic (sorted).
  const kinds = [...kindFreq.keys()].sort();
  const raw = new Map<string, number>();
  let tot = 0;
  for (const k of kinds) {
    const w = 1 / Math.log(2 + kindFreq.get(k)!);
    raw.set(k, w);
    tot += w;
  }
  const mean = kinds.length > 0 ? tot / kinds.length : 1;
  const out = new Map<string, number>();
  for (const k of kinds) out.set(k, raw.get(k)! / mean);
  return out;
}

const sigKey = (s: string, t: string): string => `${s}|${t}`;

interface PropagationResult {
  /** pre-normalization converged σ (emitted evidence). */
  sigmaPre: Map<string, number>;
  /** dynamics σ (normalized when Sinkhorn active) — used for pruning. */
  sigma: Map<string, number>;
  roundsRun: number;
  converged: boolean;
  normalizationApplied: boolean;
}

function propagate(
  src: BuiltGraph,
  dst: BuiltGraph,
  block: Blocking,
  kindW: Map<string, number>,
  cfg: FunctorSearchConfig,
  startMs: number,
): PropagationResult {
  const { cand, candSet, seedMargin } = block;

  // Decide normalization (CONDITIONAL, spike pin 4). Adaptive: turn Sinkhorn
  // ON only when seeds are genuinely BORDERLINE — a materially high fraction of
  // sources sit in a flat (low-margin) region. High-signal pairs run with it
  // OFF (it degraded them 0.86→0.68 by diluting sharp seeds).
  let normalizationApplied: boolean;
  if (cfg.normalize === "sinkhorn") normalizationApplied = true;
  else if (cfg.normalize === "none") normalizationApplied = false;
  else {
    let flatCount = 0;
    let multi = 0;
    for (const sid of src.ids) {
      const cs = cand.get(sid)!;
      if (cs.length >= 2) {
        multi++;
        if (seedMargin.get(sid)! < cfg.deltaFlat) flatCount++;
      }
    }
    normalizationApplied = multi > 0 && flatCount / multi > 0.5;
  }

  const sigma0 = new Map<string, number>();
  let sigma = new Map<string, number>();
  for (const sid of src.ids) {
    for (const c of cand.get(sid)!) {
      sigma0.set(sigKey(sid, c.t), c.sim);
      sigma.set(sigKey(sid, c.t), c.sim);
    }
  }
  const sigmaPre = new Map<string, number>(sigma0);

  let converged = false;
  let roundsRun = 0;
  for (let r = 0; r < cfg.rounds; r++) {
    if (Date.now() - startMs >= cfg.budgetMs) break;
    roundsRun = r + 1;
    const next = new Map<string, number>();
    let maxDelta = 0;

    for (const sid of src.ids) {
      const cs = cand.get(sid)!;
      if (cs.length === 0) continue;
      const nbrs = src.adj.get(sid) ?? [];
      const degN = nbrs.length; // |N(s)| — counts every typed edge (conservative)
      const m = seedMargin.get(sid)!;
      // seed-confidence damping: flat-region seeds anchor weakly.
      const alphaEff = cfg.alpha * (0.5 + 0.5 * Math.min(1, m / cfg.deltaFlat));

      for (const c of cs) {
        const t = c.t;
        let acc = 0;
        if (degN > 0) {
          // sequential accumulation over sorted nbrs (determinism contract)
          for (const e of nbrs) {
            const cprimeSet = candSet.get(e.other);
            if (!cprimeSet || cprimeSet.size === 0) continue; // contributes 0
            const fnbrs = dst.adjByKD.get(t)?.get(`${e.kind}|${e.dir}`);
            if (!fnbrs) continue;
            let best = 0;
            for (const t2 of fnbrs) {
              if (cprimeSet.has(t2)) {
                const sv = sigma.get(sigKey(e.other, t2)) ?? 0;
                if (sv > best) best = sv;
              }
            }
            const w = kindW.get(e.kind) ?? 1;
            acc += w * best;
          }
          acc /= degN;
        }
        const val = alphaEff * sigma0.get(sigKey(sid, t))! + (1 - cfg.alpha) * acc;
        next.set(sigKey(sid, t), val);
        const d = Math.abs(val - (sigma.get(sigKey(sid, t)) ?? 0));
        if (d > maxDelta) maxDelta = d;
      }
    }

    // stash pre-normalization values (the emitted evidence)
    for (const [k, v] of next) sigmaPre.set(k, v);

    // competitive (Sinkhorn-style) normalization on a COPY (shapes dynamics only)
    let dyn = next;
    if (normalizationApplied) {
      dyn = new Map(next);
      // source-side L1
      for (const sid of src.ids) {
        const cs = cand.get(sid)!;
        let s = 0;
        for (const c of cs) s += dyn.get(sigKey(sid, c.t)) ?? 0;
        if (s > 0) for (const c of cs) dyn.set(sigKey(sid, c.t), (dyn.get(sigKey(sid, c.t)) ?? 0) / s);
      }
      // target-side L1 (kills hub attractors)
      const byTarget = new Map<string, string[]>();
      for (const sid of src.ids) {
        for (const c of cand.get(sid)!) {
          if (!byTarget.has(c.t)) byTarget.set(c.t, []);
          byTarget.get(c.t)!.push(sid);
        }
      }
      const tKeys = [...byTarget.keys()].sort();
      for (const t of tKeys) {
        const srcs = byTarget.get(t)!;
        let s = 0;
        for (const sc of srcs) s += dyn.get(sigKey(sc, t)) ?? 0;
        if (s > 0) for (const sc of srcs) dyn.set(sigKey(sc, t), (dyn.get(sigKey(sc, t)) ?? 0) / s);
      }
    }
    sigma = dyn;

    if (maxDelta < cfg.convTol) {
      converged = true;
      break;
    }
  }

  return { sigmaPre, sigma, roundsRun, converged, normalizationApplied };
}

// ---------------------------------------------------------------------------
// Step 3 — arc-consistency pruning + greedy extraction
// ---------------------------------------------------------------------------

interface Survivor {
  t: string;
  /** dynamics σ (used for the prune floor). */
  sig: number;
  /** pre-normalization σ (used for ranking / emitted similarity). */
  pre: number;
}

function pruneArcConsistency(
  src: BuiltGraph,
  dst: BuiltGraph,
  block: Blocking,
  prop: PropagationResult,
  cfg: FunctorSearchConfig,
): Map<string, Survivor[]> {
  const { cand, candSet } = block;
  const { sigma, sigmaPre, normalizationApplied } = prop;
  const survive = new Map<string, Survivor[]>();

  for (const sid of src.ids) {
    const cs = cand.get(sid)!;
    const nbrs = src.adj.get(sid) ?? [];
    const deg = nbrs.length;
    const need = Math.ceil(cfg.beta * deg);
    // eps scaled when Sinkhorn shrinks magnitudes across the candidate list.
    const epsFloor = normalizationApplied
      ? cfg.epsPrune / Math.max(1, cs.length)
      : cfg.epsPrune;

    const kept: Survivor[] = [];
    for (const c of cs) {
      const sg = sigma.get(sigKey(sid, c.t)) ?? 0;
      if (sg < epsFloor) continue;
      // witness-support count: fork neighbors of c.t along each (kind,dir)
      // that land on some candidate of the corresponding source neighbor.
      let supported = 0;
      for (const e of nbrs) {
        const cprimeSet = candSet.get(e.other);
        if (!cprimeSet) continue;
        const fnbrs = dst.adjByKD.get(c.t)?.get(`${e.kind}|${e.dir}`);
        if (fnbrs && fnbrs.some((t2) => cprimeSet.has(t2))) supported++;
      }
      if (deg > 0 && supported < need) continue;
      kept.push({ t: c.t, sig: sg, pre: sigmaPre.get(sigKey(sid, c.t)) ?? c.sim });
    }
    // partiality-but-not-total-drop: keep best surviving candidate if pruning
    // emptied a source that had candidates (recorded, low confidence downstream).
    if (kept.length === 0 && cs.length > 0) {
      let best: Survivor | null = null;
      for (const c of cs) {
        const sg = sigma.get(sigKey(sid, c.t)) ?? 0;
        const cand2: Survivor = { t: c.t, sig: sg, pre: sigmaPre.get(sigKey(sid, c.t)) ?? c.sim };
        if (best === null || cand2.sig > best.sig || (cand2.sig === best.sig && cand2.t < best.t))
          best = cand2;
      }
      if (best && best.sig > 0) kept.push(best);
    }
    survive.set(sid, kept);
  }
  return survive;
}

interface ExtractedPair {
  s: string;
  t: string;
  /** emitted similarity (pre-norm σ). */
  sig: number;
  margin: number;
}

/**
 * GREEDY maximum-weight matching (½-approx). Per the spike, LAP/Hungarian buys
 * nothing in the spike — lossy profiles leave ties — so keep greedy + margin.
 * Such ties do not establish automorphism orbits or equivalent behavior.
 * Sort surviving pairs by pre-norm σ desc, tie-break (s,t) lex; accept a pair
 * when both endpoints are unclaimed (injectivity).
 */
function extractGreedy(
  src: BuiltGraph,
  survive: Map<string, Survivor[]>,
): Map<string, ExtractedPair> {
  const allPairs: { s: string; t: string; sig: number }[] = [];
  for (const sid of src.ids) {
    for (const c of survive.get(sid)!) allPairs.push({ s: sid, t: c.t, sig: c.pre });
  }
  allPairs.sort(
    (a, b) =>
      b.sig - a.sig ||
      (a.s < b.s ? -1 : a.s > b.s ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : 0),
  );

  const claimedS = new Set<string>();
  const claimedT = new Set<string>();
  const mapping = new Map<string, ExtractedPair>();
  for (const p of allPairs) {
    if (claimedS.has(p.s) || claimedT.has(p.t)) continue;
    // margin = σ - best unaccepted alternative for the same source (survivors)
    let bestAlt = -1;
    for (const c of survive.get(p.s)!) {
      if (c.t !== p.t && c.pre > bestAlt) bestAlt = c.pre;
    }
    const margin = bestAlt < 0 ? 1.0 : p.sig - bestAlt;
    mapping.set(p.s, { s: p.s, t: p.t, sig: p.sig, margin });
    claimedS.add(p.s);
    claimedT.add(p.t);
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Step 4 — fidelity scoring + repair
// ---------------------------------------------------------------------------

/** preserved/incident internal edges for one mapped source, given current F. */
function pairMetrics(
  src: BuiltGraph,
  dst: BuiltGraph,
  Fmap: Map<string, string>,
  dom: Set<string>,
  s: string,
): { incident: number; preserved: number; pairFidelity: number | null } {
  const nbrs = src.adj.get(s) ?? [];
  const Fs = Fmap.get(s)!;
  let incident = 0;
  let preserved = 0;
  for (const e of nbrs) {
    if (!dom.has(e.other)) continue;
    incident++;
    const Fo = Fmap.get(e.other)!;
    if (dst.edgeSet.has(edgeKey(Fs, e.kind, e.dir, Fo))) preserved++;
  }
  return {
    incident,
    preserved,
    pairFidelity: incident > 0 ? preserved / incident : null,
  };
}

/** Alignment-level internal/preserved edge counts (each directed edge once). */
function functorFidelity(
  src: BuiltGraph,
  dst: BuiltGraph,
  Fmap: Map<string, string>,
  dom: Set<string>,
): { internal: number; preserved: number } {
  let internal = 0;
  let preserved = 0;
  for (const sid of src.ids) {
    if (!dom.has(sid)) continue;
    const Fs = Fmap.get(sid)!;
    for (const e of src.adj.get(sid) ?? []) {
      if (e.dir !== 0) continue; // count each directed edge once (out-direction)
      if (!dom.has(e.other)) continue;
      internal++;
      if (dst.edgeSet.has(edgeKey(Fs, e.kind, 0, Fmap.get(e.other)!))) preserved++;
    }
  }
  return { internal, preserved };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run seeded-constraint-propagation structural alignment on one directed
 * repo pair. Deterministic and anytime (honors `cfg.budgetMs`).
 */
export function functorSearch(
  input: FunctorSearchInput,
  config: Partial<FunctorSearchConfig> = {},
): FunctorSearchResult {
  const startMs = Date.now();
  const cfg: FunctorSearchConfig = { ...DEFAULT_FUNCTOR_CONFIG, ...config };

  // MEMBER-SET RESTRICTION (§5.6): scope the domain / codomain to the given
  // symbol-id sets. Objects are filtered here; `buildGraph` then keeps only the
  // edges internal to the retained object set — so the whole downstream pipeline
  // (blocking → propagation → extraction) runs unmodified over the scoped graph.
  const srcObjects = input.srcMembers
    ? input.srcObjects.filter((o) => input.srcMembers!.has(o.id))
    : input.srcObjects;
  const dstObjects = input.dstMembers
    ? input.dstObjects.filter((o) => input.dstMembers!.has(o.id))
    : input.dstObjects;

  const src = buildGraph(srcObjects, input.srcEdges);
  const dst = buildGraph(dstObjects, input.dstEdges);

  const block = blockCandidates(src, dst, cfg);
  const kindW = computeKindWeights(src.kindFreq);
  const prop = propagate(src, dst, block, kindW, cfg, startMs);
  const survive = pruneArcConsistency(src, dst, block, prop, cfg);
  const extracted = extractGreedy(src, survive);

  // Fmap / dom
  const Fmap = new Map<string, string>();
  const marginOf = new Map<string, number>();
  const sigOf = new Map<string, number>();
  for (const [s, p] of extracted) {
    Fmap.set(s, p.t);
    marginOf.set(s, p.margin);
    sigOf.set(s, p.sig);
  }
  let dom = new Set(Fmap.keys());

  // Step 4 — bounded drop/swap repair.
  // Propagation exits early below cfg.rounds only when the budget was hit
  // (convergence is reported separately), so that's a budget signal too.
  let budgetExhausted = prop.roundsRun < cfg.rounds && !prop.converged;
  for (let sweep = 0; sweep < cfg.repairSweeps; sweep++) {
    if (Date.now() - startMs >= cfg.budgetMs) {
      budgetExhausted = true;
      break;
    }
    const ff = functorFidelity(src, dst, Fmap, dom);
    const globalFid = ff.internal > 0 ? ff.preserved / ff.internal : -1;
    const dropped: string[] = [];
    // Drop: below-fMin, below-average pairs whose removal raises fidelity.
    for (const s of [...dom].sort()) {
      const pm = pairMetrics(src, dst, Fmap, dom, s);
      if (
        pm.pairFidelity !== null &&
        pm.pairFidelity < cfg.fMin &&
        globalFid >= 0 &&
        pm.pairFidelity < globalFid
      ) {
        Fmap.delete(s);
        dom.delete(s);
        dropped.push(s);
      }
    }
    if (dropped.length === 0) break;

    // Swap: retry dropped sources' next-best unclaimed survivor with positive
    // pair fidelity.
    const claimedT = new Set(Fmap.values());
    let changed = false;
    for (const s of dropped.sort()) {
      const alts = [...survive.get(s)!].sort(
        (a, b) => b.pre - a.pre || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0),
      );
      for (const c of alts) {
        if (claimedT.has(c.t)) continue;
        // tentatively add, check positive pair fidelity
        Fmap.set(s, c.t);
        dom.add(s);
        const pm = pairMetrics(src, dst, Fmap, dom, s);
        if (pm.pairFidelity !== null && pm.pairFidelity > 0) {
          claimedT.add(c.t);
          // recompute margin vs remaining survivors
          let bestAlt = -1;
          for (const c2 of survive.get(s)!) if (c2.t !== c.t && c2.pre > bestAlt) bestAlt = c2.pre;
          marginOf.set(s, bestAlt < 0 ? 1.0 : c.pre - bestAlt);
          sigOf.set(s, c.pre);
          changed = true;
          break;
        }
        Fmap.delete(s);
        dom.delete(s);
      }
    }
    if (!changed) break;
    dom = new Set(Fmap.keys());
  }

  // Honest-acceptance gate (MetaCoding-265). Default (commitMinMargin=0): the
  // "confident" domain is the whole mapped domain, so coverage/fidelity are
  // byte-identical to the pre-265 behavior. When armed (>0): a mapping whose
  // margin < commitMinMargin is flagged AND removed from the confident domain,
  // so coverage/fidelity account only for mappings the matcher actually
  // resolved — the ambiguous rows still ship in `mapping` (never dropped).
  const commitGate =
    cfg.commitMinMargin > 0 ? cfg.commitMinMargin : cfg.deltaAmb;
  const confidentDom =
    cfg.commitMinMargin > 0
      ? new Set(
          [...dom].filter((s) => (marginOf.get(s) ?? 1.0) >= cfg.commitMinMargin),
        )
      : dom;

  // Final metrics — over the confident domain (== dom under the default gate).
  const ff = functorFidelity(src, dst, Fmap, confidentDom);
  const fidelity = ff.internal > 0 ? ff.preserved / ff.internal : -1;

  const mappedIds = [...Fmap.keys()].sort();
  const mapping: FunctorMapping[] = [];
  let lowMargin = 0;
  for (const s of mappedIds) {
    const pm = pairMetrics(src, dst, Fmap, dom, s);
    const margin = marginOf.get(s) ?? 1.0;
    if (margin < cfg.deltaAmb) lowMargin++;
    mapping.push({
      srcId: s,
      dstId: Fmap.get(s)!,
      similarity: sigOf.get(s) ?? 0,
      margin,
      pairFidelity: pm.pairFidelity,
      nEdgesIncident: pm.incident,
      nEdgesPreserved: pm.preserved,
      isAmbiguous: margin < commitGate,
    });
  }
  // Emit sorted by pairFidelity desc (nulls last), then similarity desc, then id.
  mapping.sort((a, b) => {
    const pa = a.pairFidelity ?? -1;
    const pb = b.pairFidelity ?? -1;
    return pb - pa || b.similarity - a.similarity || (a.srcId < b.srcId ? -1 : a.srcId > b.srcId ? 1 : 0);
  });

  const kindWeights: Record<string, number> = {};
  for (const [k, v] of kindW) kindWeights[k] = v;

  // Coverage counts the confident domain (== full mapping under the default
  // gate, so unchanged there); n_mapped stays the full committed count so the
  // ambiguous rows remain visible in the artifact.
  const coverageDenom = src.ids.length;
  const ambiguityMass = mapping.length > 0 ? lowMargin / mapping.length : 0;

  return {
    mapping,
    coverage: coverageDenom > 0 ? confidentDom.size / coverageDenom : 0,
    fidelity,
    nObjectsSrc: src.ids.length,
    nMapped: mapping.length,
    nEdgesInternal: ff.internal,
    nEdgesPreserved: ff.preserved,
    ambiguityRate: ambiguityMass,
    ambiguityMass,
    roundsRun: prop.roundsRun,
    converged: prop.converged,
    budgetExhausted,
    normalizationApplied: prop.normalizationApplied,
    kindWeights,
    elapsedMs: Date.now() - startMs,
  };
}
