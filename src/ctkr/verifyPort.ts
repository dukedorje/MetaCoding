/**
 * Port structural analysis — approximate alignment evidence for reviewing a
 * re-implementation (ct-subsystem-extraction.md §7, task T6).
 *
 * Scores a port against extracted roles, interfaces, and composition patterns
 * using member-set-restricted structural alignment, with §6.2 cross-language
 * normalization applied at seed time. The functorSearch / functorRunner names
 * remain compatibility identifiers. Category-theory design pointers describe
 * research inspiration, not verified functor laws or categorical equivalence.
 *
 * The output is a punch list with five heuristic gate scores. A failed gate
 * identifies missing evidence under this extraction, mapping, and threshold
 * configuration; it does not by itself establish a broken behavioral contract.
 *
 * Gates (§7; legacy report names retained):
 *   1. role coverage — at least one mapped member per gated role class
 *   2. interface preservation — mapped provides exports and usage-mode evidence
 *   3. composition preservation — independent role-pair edge witnesses
 *   4. fidelity — typed-edge preservation over mapped pairs
 *   5. cycle consistency — reverse alignment returns enough source symbols
 *
 * IMPORTANT LIMITATION: gate 3 checks each role pair independently. Path steps
 * need not use the same intermediate concrete symbols, so success does not
 * prove a connected complete path in the port. Fan-in inputs need not reach
 * the same concrete target. Each step accepts any kind in the pattern's kind
 * set, rather than enforcing a per-position edge-kind sequence.
 * Legacy composition-preservation keys identify this weaker diagnostic;
 * report text states its limits, not proof of composition laws or execution order.
 *
 * These scores are structural evidence, not behavioral equivalence, complete
 * contract verification, or a replacement for tests and semantic review.
 * Exemplar slices and intent text provide context, not an automated oracle.
 *
 * Provided as a thin recipe over `functorSearch` (§8.2 open decision (c): start
 * as a recipe, promote to an MCP tool when the punch-list format stabilizes).
 * `verifyPort` is the pure core; `verifyPortFromDataDir` is the artifact-reading
 * recipe; the `import.meta.main` block is the CLI entry.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import {
  functorSearch,
  type FunctorObject,
  type FunctorEdge,
  type FunctorSearchConfig,
  type FunctorSearchResult,
} from "./functorSearch.ts";
import type { PortDecision } from "./portDecisions.ts";

// ---------------------------------------------------------------------------
// §6.2 normalization spec
// ---------------------------------------------------------------------------

export interface IdiomShim {
  id: string;
  pattern: string;
  reason: string;
}

export interface NormalizationSpec {
  version: number;
  description?: string;
  /** near-synonymous edge kinds folded to one label for cross-language compare. */
  kind_collapse: Record<string, string>;
  reweight: { scheme: "inverse_marginal"; floor: number; note?: string };
  idiom_shims: { note?: string } & Record<string, IdiomShim[] | string | undefined>;
}

let _defaultNorm: NormalizationSpec | null = null;

/** Load the versioned normalization.json shipped beside this module. */
export function loadNormalization(path?: string): NormalizationSpec {
  if (path) {
    return JSON.parse(readFileSync(path, "utf8")) as NormalizationSpec;
  }
  if (_defaultNorm) return _defaultNorm;
  const here = dirname(fileURLToPath(import.meta.url));
  _defaultNorm = JSON.parse(
    readFileSync(join(here, "normalization.json"), "utf8"),
  ) as NormalizationSpec;
  return _defaultNorm;
}

// ---------------------------------------------------------------------------
// Extracted-spec inputs (a subset of the card / Parquet artifacts — §8.1)
// ---------------------------------------------------------------------------

/** One role class of the subsystem's presentation (presentations.parquet, T3). */
export interface SpecRole {
  roleId: string;
  label?: string;
  members: string[];
  interfaceParticipation: string[];
  exemplarSymbolId: string;
  exemplarQualifiedName?: string;
  cardinality: number;
  /** §6.1 tier; only tier-"I" roles are gated (default "I"). */
  invarianceTier?: string;
  /** zero-profile / nl-only "isolated" class — structure can't verify it (§2.3). */
  isIsolated?: boolean;
}

/** One provided export (interfaces.parquet direction="provides", T2). */
export interface SpecProvide {
  internalSymbolId: string;
  internalQualifiedName?: string;
  roleId?: string;
  /** usage-mode edge kinds (REFERENCES / CALLS / IMPLEMENTS / TYPE_OF / …). */
  usageModes: string[];
}

/** One mined composition pattern (legacy operads.parquet artifact, T4). */
export interface SpecOp {
  operationId: string;
  label?: string;
  /** Legacy enum: non_operadic denotes diagnostics, not failed operad laws. */
  opKind: "path" | "fan_in" | "non_operadic";
  inputRoles: string[];
  outputRole: string;
  edgeKinds: string[];
  isBoundaryOp: boolean;
  invarianceTier?: string;
  exemplarPaths?: string[];
}

export interface SubsystemSpec {
  subsystemId: string;
  repo: string;
  name?: string;
  /** Legacy orbit value means exact-profile classes, not automorphism orbits. */
  view: "orbit" | "similarity";
  roles: SpecRole[];
  provides: SpecProvide[];
  ops: SpecOp[];
}

/** One side of the comparison — S (the spec side) or S' (the port). */
export interface SideGraph {
  objects: FunctorObject[];
  edges: FunctorEdge[];
  /** dominant language for idiom-shim selection ("ts" | "py" | …). */
  language?: string;
  /** symbol_id → qualified_name, for punch-list exemplar slices. */
  qualifiedNames?: Map<string, string>;
  /** restrict dom/codomain to this subsystem member set (null = whole side). */
  memberSet?: ReadonlySet<string> | null;
}

// ---------------------------------------------------------------------------
// Meta-structural pre-build pass — paradigm descriptors (MetaCoding-9h5.1)
// ---------------------------------------------------------------------------

/**
 * The consistency baseline of a system. Free string (forward-compatible) but the
 * port-loop uses "strong" | "causal" | "eventual" (target-profile.md).
 */
export type ConsistencyModel = "strong" | "causal" | "eventual" | (string & {});

/**
 * The source system's paradigm — the two verdict-driving axes plus two
 * informative axes. `verifyPort` compares this against the `TargetProfile` BEFORE
 * scoring, so waivers become pre-registered hypotheses rather than post-hoc
 * excuses (docs/design/meta-structural-pass.md §a).
 */
export interface SourceParadigm {
  /** the source's consistency baseline (a Drupal/PHP app is "strong"). */
  consistencyModel: ConsistencyModel;
  /** does the source have an always-on authority a hard invariant escalates to? */
  coordinationLayer: boolean;
  /** dominant source language ("php" | "py" | "ts" | …) — informative only. */
  language?: string;
  /** deployment substrate ("central-server" | "local-first" | …) — informative. */
  deployment?: string;
}

/**
 * The re-implementation target's consistency profile — the subset of
 * `target-profile.md` that conditions the structural verdict. Load from the
 * `target_profile:` YAML block (consistency_model, capabilities.coordination_layer).
 */
export interface TargetProfile {
  /** stable slug (target_profile.id) — for the banner + ledger cross-refs. */
  id?: string;
  consistencyModel: ConsistencyModel;
  coordinationLayer: boolean;
  language?: string;
  deployment?: string;
}

/**
 * The paradigm assumed for the SOURCE when a `targetProfile` is supplied without
 * an explicit `sourceParadigm`: a central-authority app (the canonical
 * Drupal/farmOS port-loop baseline — strong consistency, an authority a hard
 * invariant can escalate to). Recorded as `sourceParadigmAssumed: true` so the
 * assumption is never silent.
 */
export const CENTRAL_AUTHORITY_PARADIGM: SourceParadigm = {
  consistencyModel: "strong",
  coordinationLayer: true,
  deployment: "central-server",
};

// ---------------------------------------------------------------------------
// Output — the §7 punch list + gate scores
// ---------------------------------------------------------------------------

/** The five §7 gates, as their punch-list / report addresses. */
export type GateName =
  | "role-coverage"
  | "interface-preservation"
  | "composition-preservation"
  | "fidelity"
  | "cycle-consistency";

export const ALL_GATES: readonly GateName[] = [
  "role-coverage",
  "interface-preservation",
  "composition-preservation",
  "fidelity",
  "cycle-consistency",
] as const;

export interface GateResult {
  name: string;
  score: number;
  threshold: number;
  ceiling: number;
  passed: boolean;
  passedAtCeiling: boolean;
  detail: string;
}

export interface ExemplarSlice {
  symbolId: string;
  qualifiedName?: string;
  role?: string;
}

export interface PunchListItem {
  gate: GateName;
  severity: "blocker" | "warning";
  /** the card section this failure localizes to (§7: not a boolean). */
  cardSection: string;
  label?: string;
  detail: string;
  exemplarSlices: ExemplarSlice[];
  /**
   * Set to the matching `PortDecision.id` when a decisions input was supplied
   * and this item's `cardSection` matches a decision's `targetElement`. Waived
   * items are still reported in the punch list but excluded from the net gates.
   */
  waivedBy?: string;
}

export interface GatesShape {
  roleCoverage: GateResult;
  interfacePreservation: GateResult;
  compositionPreservation: GateResult;
  fidelity: GateResult;
  cycleConsistency: GateResult;
}

/** One paradigm axis compared source-vs-target. */
export interface DimensionDivergence<T> {
  source: T;
  target: T;
  diverges: boolean;
}

/**
 * The meta-structural PRE-BUILD declaration (docs/design/meta-structural-pass.md §a).
 * Computed BEFORE gate scoring by comparing the source paradigm to the target
 * profile. `diverges` (verdict-driving) is true iff consistency_model OR
 * coordination_layer differ. The declaration pre-registers which gates are
 * predicted non-informative — so a waiver on a predicted gate is an expected
 * delta, while a waiver on a `binding` gate is an UNPREDICTED waiver (a signal
 * the pass missed a divergence or the builder drifted).
 */
export interface ParadigmDivergence {
  /** true iff the consistency_model OR coordination_layer axes differ. */
  diverges: boolean;
  consistencyModel: DimensionDivergence<string>;
  coordinationLayer: DimensionDivergence<boolean>;
  /** informative only (handled by §6.2 normalization, not verdict-driving). */
  language: DimensionDivergence<string | null>;
  /** informative only. */
  deployment: DimensionDivergence<string | null>;
  /** gates the pass predicts are non-informative under this divergence. */
  predictedNonInformative: GateName[];
  /** gates that remain binding despite the divergence (fidelity, by default). */
  binding: GateName[];
  /** true when the source paradigm was defaulted, not explicitly supplied. */
  sourceParadigmAssumed: boolean;
  /** human-readable summary for the banner. */
  rationale: string;
}

export interface PortVerificationReport {
  subsystemId: string;
  repo: string;
  portRepo: string;
  normalizationApplied: boolean;
  normalizationVersion: number | null;
  /**
   * "binding" (classic gating) or "advisory" — downgraded when a material
   * paradigm divergence is declared. The report is fully rendered either way;
   * only the pass/fail verdict's authority changes. Acceptance then rests on the
   * value-equivalence oracle, and this report becomes the divergence ledger
   * (docs/design/meta-structural-pass.md §c).
   */
  verdict: "binding" | "advisory";
  /**
   * The meta-structural pre-build declaration. Present only when a `targetProfile`
   * was supplied. When `paradigmDivergence.diverges` is true, `verdict` is
   * "advisory".
   */
  paradigmDivergence?: ParadigmDivergence;
  /**
   * First-class structural failure signal under advisory mode: waived punch items
   * on a gate that was NOT predicted non-informative — a post-hoc waiver the
   * pre-build pass did not anticipate. 0 when paradigms match or no divergence.
   */
  unpredictedWaiverCount: number;
  /** convenience mirror of `staleWaivers.length` — the other first-class signal. */
  staleWaiverCount: number;
  /** Raw gate scores — unaffected by any decisions/waivers. */
  gates: GatesShape;
  /**
   * Gate scores net of waivers — present only when a `decisions` input was
   * supplied to `verifyPort`. `passed` is lifted to `true` when every punch-list
   * item for that gate is waived; `passedAtCeiling` is never lifted by waivers
   * (waivers reclassify floor failures, they cannot grant ceiling status).
   */
  gatesNet?: GatesShape;
  /** convenience: every gate passes at its ceiling (the rename-fork "port" bar). */
  passedAtCeiling: boolean;
  /** the §7 PUNCH LIST — localized failures. Empty iff every gate is at ceiling. */
  punchList: PunchListItem[];
  /**
   * How many punch-list items were waived. Zero when no decisions were supplied
   * or no decision targets matched.
   */
  waivedCount: number;
  /**
   * Decision records whose `targetElement` matched no punch-list item in this
   * run. A stale waiver is not silently dropped — it is surfaced here so the
   * decisions log can be kept current. Only populated when a `decisions` input
   * was supplied.
   */
  staleWaivers: PortDecision[];
  functor: {
    coverage: number;
    fidelity: number;
    nMapped: number;
    nObjectsSrc: number;
    cycleConsistency: number;
  };
  /** How many source nodes the forward structural alignment mapped. */
  mappingCount: number;
}

export interface VerifyPortOptions {
  spec: SubsystemSpec;
  /** S — the extracted-spec side (domain). */
  source: SideGraph;
  /** S' — the re-implementation (codomain). */
  port: SideGraph;
  /**
   * §6.2 cross-language normalization. When provided AND `applyNormalization`
   * is not false, it is applied at seed time to BOTH sides before search. Pass
   * `null` (or applyNormalization:false) to run the raw ungated comparison — the
   * on/off delta is the §6 experiment.
   */
  normalization?: NormalizationSpec | null;
  applyNormalization?: boolean;
  config?: Partial<FunctorSearchConfig>;
  thresholds?: Partial<GateThresholds>;
  /**
   * Optional port decision records. When supplied, punch-list items whose
   * `cardSection` matches a decision's `targetElement` are marked `waivedBy`
   * (the decision id) and excluded from the net gate computation. Decisions for
   * a different subsystem (decision.subsystem !== spec.subsystemId) are ignored.
   *
   * Load from `port_decisions/<subsystem_id>.jsonl` via `loadPortDecisions()`.
   */
  decisions?: PortDecision[];
  /**
   * Meta-structural pre-build pass input (MetaCoding-9h5.1). When supplied and its
   * consistency_model / coordination_layer differ from the source paradigm, the
   * verdict is downgraded to "advisory" (the report is still fully rendered), the
   * predicted-non-informative gates are pre-registered, and unpredicted-/stale-
   * waiver counts become first-class signals. Omit to keep classic binding gating —
   * gate scoring itself is byte-for-byte unchanged.
   */
  targetProfile?: TargetProfile | null;
  /**
   * The source system's paradigm. Defaults to `CENTRAL_AUTHORITY_PARADIGM` when a
   * `targetProfile` is supplied without one (the port-loop's Drupal/farmOS
   * baseline); the default is recorded as `sourceParadigmAssumed: true`.
   */
  sourceParadigm?: SourceParadigm | null;
}

export interface GateThresholds {
  /** role coverage: pass floor / ceiling (ceiling = 1.0, the fork bar). */
  roleCoverage: [number, number];
  interfacePreservation: [number, number];
  compositionPreservation: [number, number];
  fidelity: [number, number];
  cycleConsistency: [number, number];
}

/** §7 thresholds: floors are the "robust approximation" bar, ceilings the fork bar. */
export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  roleCoverage: [0.9, 1.0],
  interfacePreservation: [0.9, 1.0],
  compositionPreservation: [0.8, 1.0],
  fidelity: [0.8, 0.95], // ceiling 0.95 per the T6 acceptance criterion
  cycleConsistency: [0.8, 0.9],
};

// ---------------------------------------------------------------------------
// §6.2 normalization — applied at seed time to one side
// ---------------------------------------------------------------------------

export type Dir = "in" | "out";

/** Canonical collapsed edge-kind alphabet (stable order) derived from a base set. */
export function collapsedAlphabet(
  baseKinds: readonly string[],
  collapse: Record<string, string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of baseKinds) {
    const c = collapse[k] ?? k;
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/** The 15 typed edge kinds — mirror of ctkr/ctkr/graph_loader.py EDGE_KINDS. */
export const BASE_EDGE_KINDS = [
  "CALLS",
  "REFERENCES",
  "EXTENDS",
  "IMPLEMENTS",
  "OVERRIDES",
  "INJECTS",
  "CONTAINS",
  "IMPORTS",
  "ANNOTATES",
  "TYPE_OF",
  "READS_FIELD",
  "WRITES_FIELD",
  "RETURNS_TYPE",
  "CONSTRUCTS",
  "RAISES",
] as const;

function idiomShimsFor(spec: NormalizationSpec, language?: string): IdiomShim[] {
  if (!language) return [];
  const v = spec.idiom_shims[language];
  return Array.isArray(v) ? v : [];
}

export interface NormalizedSide {
  objects: FunctorObject[];
  edges: FunctorEdge[];
  /** ids removed by idiom folding (their edges rerouted to the CONTAINS parent). */
  foldedOut: Set<string>;
  /** folded id → the parent it was merged into. */
  containerOf: Map<string, string>;
}

/**
 * Apply §6.2 normalization to one side at seed time:
 *   1. kind-collapse edges (fold near-synonymous kinds — §6.2.2);
 *   2. idiom-fold members into their CONTAINS parent (§6.2.3);
 *   3. rebuild each object's profile as a depth-1 count vector over the COLLAPSED
 *      alphabet, divided by this side's own per-kind marginal (§6.2.1 inverse-
 *      marginal reweight) so language-dense kinds stop dominating the seed.
 *
 * Both sides are normalized with the SAME collapsed alphabet ordering, so the
 * reweighted vectors are directly comparable across languages. The persisted
 * artifacts are untouched — this reshapes only the in-memory search inputs.
 */
export function normalizeSide(
  side: SideGraph,
  spec: NormalizationSpec,
  alphabet: string[],
): NormalizedSide {
  const collapse = spec.kind_collapse;
  const collapseKind = (k: string): string => collapse[k] ?? k;

  // --- 1. collapse edge kinds ---
  const collapsedEdges: FunctorEdge[] = side.edges.map((e) => ({
    src: e.src,
    dst: e.dst,
    kind: collapseKind(e.kind),
  }));

  // --- 2. idiom fold ---
  const shims = idiomShimsFor(spec, side.language).map(
    (s) => new RegExp(s.pattern),
  );
  const qn = side.qualifiedNames ?? new Map<string, string>();
  const foldedOut = new Set<string>();
  const containerOf = new Map<string, string>();
  if (shims.length > 0) {
    // CONTAINS parent of each object (post-collapse CONTAINS is unchanged).
    const parent = new Map<string, string>();
    for (const e of collapsedEdges) {
      if (e.kind === "CONTAINS") parent.set(e.dst, e.src); // src CONTAINS dst
    }
    const objIds = new Set(side.objects.map((o) => o.id));
    for (const o of side.objects) {
      const name = qn.get(o.id) ?? "";
      if (!name) continue;
      if (shims.some((re) => re.test(name))) {
        const p = parent.get(o.id);
        // only fold when the parent exists and is itself a real object — a fold
        // that would drop a top-level symbol is skipped (conservative).
        if (p && objIds.has(p) && p !== o.id) {
          foldedOut.add(o.id);
          containerOf.set(o.id, p);
        }
      }
    }
  }
  // resolve a chain of folds to the final surviving container.
  const resolve = (id: string): string => {
    let cur = id;
    const guard = new Set<string>();
    while (foldedOut.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      cur = containerOf.get(cur)!;
    }
    return cur;
  };

  const survivingObjects = side.objects.filter((o) => !foldedOut.has(o.id));
  // reroute folded members' edges to their surviving container; drop self loops.
  const reroutedEdges: FunctorEdge[] = [];
  for (const e of collapsedEdges) {
    const s = resolve(e.src);
    const d = resolve(e.dst);
    if (s === d) continue;
    reroutedEdges.push({ src: s, dst: d, kind: e.kind });
  }

  // --- 3. reweighted depth-1 profile over the collapsed alphabet ---
  const dimIdx = new Map<string, number>();
  alphabet.forEach((k, i) => {
    dimIdx.set(`${k}|in`, 2 * i);
    dimIdx.set(`${k}|out`, 2 * i + 1);
  });
  const nDim = alphabet.length * 2;
  const counts = new Map<string, number[]>();
  for (const o of survivingObjects) counts.set(o.id, new Array(nDim).fill(0));
  const kindTotal = new Map<string, number>(); // side marginal per collapsed kind
  for (const e of reroutedEdges) {
    const oi = dimIdx.get(`${e.kind}|out`);
    const ii = dimIdx.get(`${e.kind}|in`);
    if (oi !== undefined && counts.has(e.src)) counts.get(e.src)![oi]!++;
    if (ii !== undefined && counts.has(e.dst)) counts.get(e.dst)![ii]!++;
    kindTotal.set(e.kind, (kindTotal.get(e.kind) ?? 0) + 1);
  }
  // inverse-marginal weights: rare (discriminative) kinds up-weighted, dense
  // (language-biased) kinds down-weighted. Marginal = kind share of this side's
  // edges; floor bounds absent/rare kinds.
  const totalEdges = reroutedEdges.length || 1;
  const floor = spec.reweight.floor;
  const weight = new Map<string, number>();
  for (const k of alphabet) {
    const marginal = (kindTotal.get(k) ?? 0) / totalEdges;
    weight.set(k, 1 / (marginal + floor));
  }
  const wVec = new Array<number>(nDim);
  alphabet.forEach((k, i) => {
    const w = weight.get(k)!;
    wVec[2 * i] = w;
    wVec[2 * i + 1] = w;
  });

  const objects: FunctorObject[] = survivingObjects.map((o) => {
    const c = counts.get(o.id)!;
    const v = new Array<number>(nDim);
    for (let j = 0; j < nDim; j++) v[j] = c[j]! * wVec[j]!;
    return { id: o.id, kind: o.kind, profileVec: v };
  });

  return { objects, edges: reroutedEdges, foldedOut, containerOf };
}

// ---------------------------------------------------------------------------
// Witness helpers
// ---------------------------------------------------------------------------

/** directed same-kind witness set: `${src}|${kind}|${dst}`. */
function buildEdgeSet(edges: FunctorEdge[]): Set<string> {
  const s = new Set<string>();
  for (const e of edges) s.add(`${e.src}|${e.kind}|${e.dst}`);
  return s;
}

/** kinds incident to `id` in either direction. */
function incidentKinds(edges: FunctorEdge[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (id: string, k: string) => {
    let s = m.get(id);
    if (!s) m.set(id, (s = new Set()));
    s.add(k);
  };
  for (const e of edges) {
    add(e.src, e.kind);
    add(e.dst, e.kind);
  }
  return m;
}

function cycleConsistency(
  fwd: FunctorSearchResult["mapping"],
  rev: FunctorSearchResult["mapping"],
): number {
  if (fwd.length === 0) return -1;
  const g = new Map<string, string>();
  for (const m of rev) g.set(m.srcId, m.dstId);
  let ok = 0;
  for (const m of fwd) if (g.get(m.dstId) === m.srcId) ok++;
  return ok / fwd.length;
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

function mkGate(
  name: string,
  score: number,
  [floor, ceiling]: [number, number],
  detail: string,
): GateResult {
  return {
    name,
    score,
    threshold: floor,
    ceiling,
    passed: score >= floor - 1e-9,
    passedAtCeiling: score >= ceiling - 1e-9,
    detail,
  };
}

/**
 * Predict which structural gates become non-informative when a port crosses a
 * consistency-model / coordination-layer paradigm boundary. Grounded in the
 * 2026-07-18 logs+quantities run (vertical-slice-logs-quantities.md §3b): a
 * central-authority plugin registry → local-first event log divergence dissolves
 * the source's SHAPE idioms — class/plugin role hierarchies (role coverage),
 * request-time export usage modes (interface preservation), subtype protocol ops
 * (composition preservation), and whole-region matches (cycle consistency) — all
 * eight punch items that run produced were on these four gates. Functor FIDELITY
 * over the pairs that DO map stays a real structure-preservation signal (it hit
 * ceiling that run), so it remains binding. When neither verdict axis diverges,
 * nothing is predicted non-informative and gating is fully binding.
 */
export function predictNonInformativeGates(d: {
  consistencyDiverges: boolean;
  coordinationDiverges: boolean;
}): GateName[] {
  if (!d.consistencyDiverges && !d.coordinationDiverges) return [];
  return [
    "role-coverage",
    "interface-preservation",
    "composition-preservation",
    "cycle-consistency",
  ];
}

/**
 * The meta-structural PRE-BUILD comparison: source paradigm vs target profile.
 * `diverges` (verdict-driving) is true iff consistency_model OR coordination_layer
 * differ; language/deployment are recorded as informative-only (they diverge only
 * when both sides are known and differ). Pre-registers the predicted-non-
 * informative gates so post-run waivers can be classified as expected vs
 * unpredicted.
 */
export function computeParadigmDivergence(
  source: SourceParadigm,
  target: TargetProfile,
  sourceParadigmAssumed: boolean,
): ParadigmDivergence {
  const cmDiverges = source.consistencyModel !== target.consistencyModel;
  const clDiverges = source.coordinationLayer !== target.coordinationLayer;
  const srcLang = source.language ?? null;
  const tgtLang = target.language ?? null;
  const langDiverges = srcLang !== null && tgtLang !== null && srcLang !== tgtLang;
  const srcDep = source.deployment ?? null;
  const tgtDep = target.deployment ?? null;
  const depDiverges = srcDep !== null && tgtDep !== null && srcDep !== tgtDep;

  const diverges = cmDiverges || clDiverges;
  const predictedNonInformative = predictNonInformativeGates({
    consistencyDiverges: cmDiverges,
    coordinationDiverges: clDiverges,
  });
  const binding = ALL_GATES.filter((g) => !predictedNonInformative.includes(g));

  const axes: string[] = [];
  if (cmDiverges) axes.push(`consistency ${source.consistencyModel}→${target.consistencyModel}`);
  if (clDiverges) axes.push(`coordination-layer ${source.coordinationLayer}→${target.coordinationLayer}`);
  const rationale = diverges
    ? `Paradigm divergence on ${axes.join(" & ")}. The source's central-authority shape idioms are expected to dissolve; structural gates ${predictedNonInformative.join("/")} are predicted non-informative and their waivers are pre-registered. Fidelity remains binding.`
    : "No material paradigm divergence — structural gating is binding.";

  return {
    diverges,
    consistencyModel: { source: source.consistencyModel, target: target.consistencyModel, diverges: cmDiverges },
    coordinationLayer: { source: source.coordinationLayer, target: target.coordinationLayer, diverges: clDiverges },
    language: { source: srcLang, target: tgtLang, diverges: langDiverges },
    deployment: { source: srcDep, target: tgtDep, diverges: depDiverges },
    predictedNonInformative,
    binding,
    sourceParadigmAssumed,
    rationale,
  };
}

/**
 * Verify a re-implementation `S'` against the extracted spec of `S`. Returns the
 * §7 punch list + five gate scores. Pure: no artifact I/O, no disk writes — the
 * caller assembles the spec + both side graphs (see `verifyPortFromDataDir`).
 */
export function verifyPort(opts: VerifyPortOptions): PortVerificationReport {
  const th = { ...DEFAULT_GATE_THRESHOLDS, ...opts.thresholds };
  const applyNorm =
    opts.normalization != null && opts.applyNormalization !== false;
  const norm = applyNorm ? opts.normalization! : null;

  let srcObjs = opts.source.objects;
  let srcEdges = opts.source.edges;
  let dstObjs = opts.port.objects;
  let dstEdges = opts.port.edges;
  let foldedSrc = new Set<string>();
  let foldedDst = new Set<string>();
  let srcMembers = opts.source.memberSet ?? null;
  let dstMembers = opts.port.memberSet ?? null;

  if (norm) {
    const alphabet = collapsedAlphabet(BASE_EDGE_KINDS, norm.kind_collapse);
    const ns = normalizeSide(opts.source, norm, alphabet);
    const nd = normalizeSide(opts.port, norm, alphabet);
    srcObjs = ns.objects;
    srcEdges = ns.edges;
    dstObjs = nd.objects;
    dstEdges = nd.edges;
    foldedSrc = ns.foldedOut;
    foldedDst = nd.foldedOut;
    if (srcMembers) srcMembers = new Set([...srcMembers].filter((id) => !foldedSrc.has(id)));
    if (dstMembers) dstMembers = new Set([...dstMembers].filter((id) => !foldedDst.has(id)));
  }

  const cfg = opts.config ?? {};
  const fwd = functorSearch(
    { srcObjects: srcObjs, srcEdges, dstObjects: dstObjs, dstEdges, srcMembers, dstMembers },
    cfg,
  );
  const rev = functorSearch(
    { srcObjects: dstObjs, srcEdges: dstEdges, dstObjects: srcObjs, dstEdges: srcEdges, srcMembers: dstMembers, dstMembers: srcMembers },
    cfg,
  );

  const F = new Map<string, string>();
  for (const m of fwd.mapping) F.set(m.srcId, m.dstId);
  const dstEdgeSet = buildEdgeSet(dstEdges);
  const dstIncident = incidentKinds(dstEdges);
  // effective member set of S after folding (roles/members reference folded ids).
  const foldName = opts.source.qualifiedNames ?? new Map<string, string>();
  const portName = opts.port.qualifiedNames ?? new Map<string, string>();

  const punch: PunchListItem[] = [];

  // ---- Gate 1: role coverage ----
  const gatedRoles = opts.spec.roles.filter(
    (r) => (r.invarianceTier ?? "I") === "I" && !r.isIsolated,
  );
  let coveredRoles = 0;
  for (const r of gatedRoles) {
    const members = r.members.filter((m) => !foldedSrc.has(m));
    if (members.length === 0) {
      // every member folded as an idiom — not a lost role, skip from denominator.
      continue;
    }
    const anyMapped = members.some((m) => F.has(m));
    if (anyMapped) {
      coveredRoles++;
    } else {
      punch.push({
        gate: "role-coverage",
        severity: "blocker",
        cardSection: `roles[role_id=${r.roleId}]`,
        label: r.label,
        detail: `role class "${r.label ?? r.roleId}" (cardinality ${r.cardinality}) has NO member mapped into the port — the port dropped this role`,
        exemplarSlices: [
          {
            symbolId: r.exemplarSymbolId,
            qualifiedName: r.exemplarQualifiedName ?? foldName.get(r.exemplarSymbolId),
            role: r.label ?? r.roleId,
          },
        ],
      });
    }
  }
  const roleDenom = gatedRoles.filter(
    (r) => r.members.filter((m) => !foldedSrc.has(m)).length > 0,
  ).length;
  const roleCoverageScore = roleDenom === 0 ? 1 : coveredRoles / roleDenom;

  // ---- Gate 2: interface preservation ----
  let providesOk = 0;
  const providesGated = opts.spec.provides.filter((p) => !foldedSrc.has(p.internalSymbolId));
  for (const p of providesGated) {
    const img = F.get(p.internalSymbolId);
    if (img === undefined) {
      punch.push({
        gate: "interface-preservation",
        severity: "blocker",
        cardSection: `interface.provides[symbol=${p.internalQualifiedName ?? p.internalSymbolId}]`,
        detail: `provided export "${p.internalQualifiedName ?? p.internalSymbolId}" (modes ${p.usageModes.join("/")}) has no image in the port — the export was lost`,
        exemplarSlices: [
          { symbolId: p.internalSymbolId, qualifiedName: p.internalQualifiedName ?? foldName.get(p.internalSymbolId), role: p.roleId },
        ],
      });
      continue;
    }
    // "used in the same modes": the mapped export participates in an edge of each
    // usage-mode kind (collapsed if normalization is on).
    const collapse = norm ? norm.kind_collapse : {};
    const wantKinds = new Set(p.usageModes.map((k) => collapse[k] ?? k));
    const have = dstIncident.get(img) ?? new Set<string>();
    const missing = [...wantKinds].filter((k) => !have.has(k));
    if (missing.length === 0) {
      providesOk++;
    } else {
      punch.push({
        gate: "interface-preservation",
        severity: "warning",
        cardSection: `interface.provides[symbol=${p.internalQualifiedName ?? p.internalSymbolId}]`,
        detail: `export "${p.internalQualifiedName ?? p.internalSymbolId}" maps to "${portName.get(img) ?? img}" but is not used in mode(s) ${missing.join("/")} there — usage contract changed`,
        exemplarSlices: [
          { symbolId: p.internalSymbolId, qualifiedName: p.internalQualifiedName ?? foldName.get(p.internalSymbolId) },
          { symbolId: img, qualifiedName: portName.get(img) },
        ],
      });
    }
  }
  const ifaceScore = providesGated.length === 0 ? 1 : providesOk / providesGated.length;

  // ---- Gate 3: composition-pattern role-pair witnesses (legacy gate name) ----
  const roleMembers = new Map<string, string[]>();
  for (const r of opts.spec.roles) roleMembers.set(r.roleId, r.members);
  const roleLabel = new Map<string, string>();
  for (const r of opts.spec.roles) roleLabel.set(r.roleId, r.label ?? r.roleId);

  // A role-step passes iff some mapped members a∈rA, b∈rB have a same-kind
  // (kind∈kinds) source edge a→b whose witness F(a)→F(b) exists in the port.
  // This existential witness is independent of every other role-step. It
  // proves neither a connected complete path nor a shared fan-in target.
  // The kind set also does not enforce an ordered edge-kind sequence.
  const srcEdgeAdj = new Map<string, FunctorEdge[]>();
  for (const e of srcEdges) {
    let a = srcEdgeAdj.get(e.src);
    if (!a) srcEdgeAdj.set(e.src, (a = []));
    a.push(e);
  }
  const stepRealizable = (rA: string, rB: string, kinds: Set<string>): boolean => {
    const A = (roleMembers.get(rA) ?? []).filter((m) => !foldedSrc.has(m) && F.has(m));
    const Bset = new Set((roleMembers.get(rB) ?? []).filter((m) => !foldedSrc.has(m) && F.has(m)));
    if (A.length === 0 || Bset.size === 0) return false;
    for (const a of A) {
      for (const e of srcEdgeAdj.get(a) ?? []) {
        if (!kinds.has(e.kind)) continue;
        if (!Bset.has(e.dst)) continue;
        if (dstEdgeSet.has(`${F.get(a)}|${e.kind}|${F.get(e.dst)}`)) return true;
      }
    }
    return false;
  };

  const collapse = norm ? norm.kind_collapse : {};
  const gatedOps = opts.spec.ops.filter(
    (o) => o.opKind !== "non_operadic" && (o.invarianceTier ?? "I") === "I",
  );
  let opsOk = 0;
  for (const op of gatedOps) {
    const kinds = new Set(op.edgeKinds.map((k) => collapse[k] ?? k));
    let realizable: boolean;
    if (op.opKind === "fan_in") {
      // Each input role needs an edge witness to the output role, but the
      // witnesses can end at different concrete targets (not proven fan-in).
      realizable = op.inputRoles.every((r) => stepRealizable(r, op.outputRole, kinds));
    } else {
      // Independent witnesses per consecutive role pair; adjacent steps can
      // use different middle members, so this need not be a connected path.
      const chain = [...op.inputRoles, op.outputRole];
      realizable = true;
      for (let i = 0; i + 1 < chain.length; i++) {
        if (!stepRealizable(chain[i]!, chain[i + 1]!, kinds)) {
          realizable = false;
          break;
        }
      }
    }
    if (realizable) {
      opsOk++;
    } else {
      const roleChain = [...op.inputRoles, op.outputRole].map((r) => roleLabel.get(r) ?? r).join(" ∘ ");
      punch.push({
        gate: "composition-preservation",
        severity: op.isBoundaryOp ? "blocker" : "warning",
        cardSection: `composition_rules[operation_id=${op.operationId}]`,
        label: op.label,
        detail:
          (op.isBoundaryOp ? "Boundary pattern " : "Pattern ") +
          `"${op.label ?? op.operationId}" (${op.opKind} ${roleChain}, kinds ${op.edgeKinds.join("/")}) lacks a mapped role-pair edge witness — ` +
          "this is a structural diagnostic, not proof of a broken execution contract",
        exemplarSlices: (op.exemplarPaths ?? []).slice(0, 2).map((pth) => ({
          symbolId: pth,
          qualifiedName: pth,
        })),
      });
    }
  }
  // Ceiling requires all boundary patterns to pass the same independent
  // role-pair checks; it does not strengthen them to connected realizations.
  const boundaryOps = gatedOps.filter((o) => o.isBoundaryOp);
  const boundaryOk = boundaryOps.filter((op) => {
    const kinds = new Set(op.edgeKinds.map((k) => collapse[k] ?? k));
    if (op.opKind === "fan_in") return op.inputRoles.every((r) => stepRealizable(r, op.outputRole, kinds));
    const chain = [...op.inputRoles, op.outputRole];
    for (let i = 0; i + 1 < chain.length; i++) if (!stepRealizable(chain[i]!, chain[i + 1]!, kinds)) return false;
    return true;
  }).length;
  const compScoreRaw = gatedOps.length === 0 ? 1 : opsOk / gatedOps.length;
  // protocol failures cap the score below ceiling regardless of the raw fraction.
  const compScore =
    boundaryOps.length > 0 && boundaryOk < boundaryOps.length
      ? Math.min(compScoreRaw, th.compositionPreservation[1] - 1e-6)
      : compScoreRaw;

  // ---- Gate 4: fidelity ----
  const fidScore = fwd.fidelity < 0 ? 0 : fwd.fidelity;
  if (!(fidScore >= th.fidelity[0] - 1e-9)) {
    punch.push({
      gate: "fidelity",
      severity: "blocker",
      cardSection: "functor.fidelity",
      detail: `structural-alignment edge fidelity ${fidScore.toFixed(3)} < floor ${th.fidelity[0]} over ${fwd.nEdgesInternal} internal edges — too few mapped typed edges meet the configured threshold`,
      exemplarSlices: [],
    });
  }

  // ---- Gate 5: cycle consistency ----
  const cyc = cycleConsistency(fwd.mapping, rev.mapping);
  const cycScore = cyc < 0 ? 0 : cyc;
  if (!(cycScore >= th.cycleConsistency[0] - 1e-9)) {
    punch.push({
      gate: "cycle-consistency",
      severity: "warning",
      cardSection: "functor.cycle_consistency",
      detail: `cycle consistency G(F(s))=s is ${cycScore.toFixed(3)} < floor ${th.cycleConsistency[0]} — the forward and reverse maps disagree, a sign the match is displaced onto the wrong region`,
      exemplarSlices: [],
    });
  }

  const gates = {
    roleCoverage: mkGate("role coverage", roleCoverageScore, th.roleCoverage, `${coveredRoles}/${roleDenom} tier-I role classes covered`),
    interfacePreservation: mkGate("interface preservation", ifaceScore, th.interfacePreservation, `${providesOk}/${providesGated.length} provided exports preserved`),
    compositionPreservation: mkGate("composition pattern coverage", compScore, th.compositionPreservation, `${opsOk}/${gatedOps.length} patterns have independent role-pair witnesses (${boundaryOk}/${boundaryOps.length} boundary patterns); connected paths and common fan-in targets are not checked`),
    fidelity: mkGate("fidelity", fidScore, th.fidelity, `${fwd.nEdgesPreserved}/${fwd.nEdgesInternal} internal edges preserved`),
    cycleConsistency: mkGate("cycle consistency", cycScore, th.cycleConsistency, `G(F(s))=s on ${cycScore.toFixed(3)} of mapped pairs`),
  };

  const passedAtCeiling =
    gates.roleCoverage.passedAtCeiling &&
    gates.interfacePreservation.passedAtCeiling &&
    gates.compositionPreservation.passedAtCeiling &&
    gates.fidelity.passedAtCeiling &&
    gates.cycleConsistency.passedAtCeiling;

  // punch list sorted: blockers first, then by gate strictness.
  const gateOrder = ["role-coverage", "interface-preservation", "composition-preservation", "fidelity", "cycle-consistency"];
  punch.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "blocker" ? -1 : 1;
    return gateOrder.indexOf(a.gate) - gateOrder.indexOf(b.gate);
  });

  // ---- Waiver processing ----
  // Filter decisions to only those for this subsystem.
  const relevantDecisions = (opts.decisions ?? []).filter(
    (d) => d.subsystem === opts.spec.subsystemId,
  );

  let gatesNet: GatesShape | undefined;
  let waivedCount = 0;
  let staleWaivers: PortDecision[] = [];

  if (relevantDecisions.length > 0) {
    // Build a lookup: cardSection → decision id, for O(1) matching.
    const decisionByTarget = new Map<string, string>();
    for (const d of relevantDecisions) {
      // Last-writer-wins when two decisions share the same targetElement.
      decisionByTarget.set(d.targetElement, d.id);
    }

    // Mark matched punch-list items as waived.
    const matchedTargets = new Set<string>();
    for (const item of punch) {
      const decisionId = decisionByTarget.get(item.cardSection);
      if (decisionId !== undefined) {
        item.waivedBy = decisionId;
        matchedTargets.add(item.cardSection);
        waivedCount++;
      }
    }

    // Stale waivers: decisions whose targetElement matched nothing.
    staleWaivers = relevantDecisions.filter(
      (d) => !matchedTargets.has(d.targetElement),
    );

    // Compute net gates: same score/threshold/ceiling; `passed` is lifted when
    // every punch-list item for that gate is waived; `passedAtCeiling` is never
    // lifted by waivers (can't waive into ceiling territory).
    const allWaivedForGate = (gateName: string): boolean =>
      punch
        .filter((p) => p.gate === gateName)
        .every((p) => p.waivedBy !== undefined);

    const liftGate = (raw: GateResult, gateName: string): GateResult => ({
      ...raw,
      passed: raw.passed || allWaivedForGate(gateName),
      // passedAtCeiling never changes — waivers reclassify floor failures only.
    });

    gatesNet = {
      roleCoverage: liftGate(gates.roleCoverage, "role-coverage"),
      interfacePreservation: liftGate(gates.interfacePreservation, "interface-preservation"),
      compositionPreservation: liftGate(gates.compositionPreservation, "composition-preservation"),
      fidelity: liftGate(gates.fidelity, "fidelity"),
      cycleConsistency: liftGate(gates.cycleConsistency, "cycle-consistency"),
    };
  }

  // ---- Meta-structural pre-build pass: paradigm-divergence (MetaCoding-9h5.1) ----
  // When a target profile is supplied, compare it against the source paradigm
  // (defaulting to central-authority when none was given). A material divergence
  // downgrades the verdict to advisory and turns unpredicted / stale waivers into
  // the first-class structural failure signals.
  let paradigmDivergence: ParadigmDivergence | undefined;
  let verdict: "binding" | "advisory" = "binding";
  let unpredictedWaiverCount = 0;

  if (opts.targetProfile) {
    const sourceParadigmAssumed = opts.sourceParadigm == null;
    const src = opts.sourceParadigm ?? CENTRAL_AUTHORITY_PARADIGM;
    paradigmDivergence = computeParadigmDivergence(src, opts.targetProfile, sourceParadigmAssumed);
    if (paradigmDivergence.diverges) {
      verdict = "advisory";
      const predicted = new Set(paradigmDivergence.predictedNonInformative);
      for (const item of punch) {
        if (item.waivedBy !== undefined && !predicted.has(item.gate)) unpredictedWaiverCount++;
      }
    }
  }

  return {
    subsystemId: opts.spec.subsystemId,
    repo: opts.spec.repo,
    portRepo: opts.port.language ?? "port",
    normalizationApplied: applyNorm,
    normalizationVersion: norm ? norm.version : null,
    verdict,
    ...(paradigmDivergence !== undefined ? { paradigmDivergence } : {}),
    unpredictedWaiverCount,
    staleWaiverCount: staleWaivers.length,
    gates,
    ...(gatesNet !== undefined ? { gatesNet } : {}),
    passedAtCeiling,
    punchList: punch,
    waivedCount,
    staleWaivers,
    functor: {
      coverage: fwd.coverage,
      fidelity: fidScore,
      nMapped: fwd.nMapped,
      nObjectsSrc: fwd.nObjectsSrc,
      cycleConsistency: cycScore,
    },
    mappingCount: fwd.mapping.length,
  };
}

/** Render a report as a human-readable punch list (for the CLI / eval output). */
export function formatReport(r: PortVerificationReport): string {
  const lines: string[] = [];
  const pct = (x: number) => (x * 100).toFixed(1) + "%";
  lines.push(`# Port verification — ${r.repo} / ${r.subsystemId}`);
  lines.push(`normalization: ${r.normalizationApplied ? `on (v${r.normalizationVersion})` : "off"}   passedAtCeiling: ${r.passedAtCeiling}   verdict: ${r.verdict.toUpperCase()}`);
  if (r.verdict === "advisory" && r.paradigmDivergence) {
    const pd = r.paradigmDivergence;
    lines.push("");
    lines.push("┌─ PARADIGM DIVERGENCE — verdict ADVISORY ─────────────────────────");
    lines.push(`│ ${pd.rationale}`);
    if (pd.sourceParadigmAssumed) {
      lines.push("│ source paradigm ASSUMED (central-authority default — no explicit sourceParadigm supplied)");
    }
    const mark = (d: boolean) => (d ? "✗ diverges" : "= same");
    lines.push(`│ consistency_model : ${pd.consistencyModel.source} → ${pd.consistencyModel.target}   ${mark(pd.consistencyModel.diverges)}`);
    lines.push(`│ coordination_layer: ${pd.coordinationLayer.source} → ${pd.coordinationLayer.target}   ${mark(pd.coordinationLayer.diverges)}`);
    if (pd.language.diverges) lines.push(`│ language          : ${pd.language.source} → ${pd.language.target}   (informative)`);
    if (pd.deployment.diverges) lines.push(`│ deployment        : ${pd.deployment.source} → ${pd.deployment.target}   (informative)`);
    lines.push(`│ predicted NON-INFORMATIVE (pre-registered): ${pd.predictedNonInformative.join(", ") || "(none)"}`);
    lines.push(`│ remain BINDING: ${pd.binding.join(", ")}`);
    lines.push("│ ── structural failure signals (advisory mode) ──");
    lines.push(`│ unpredicted waivers: ${r.unpredictedWaiverCount}   stale waivers: ${r.staleWaiverCount}`);
    lines.push("│ acceptance rests on the value-equivalence oracle; this report is the divergence ledger.");
    lines.push("└──────────────────────────────────────────────────────────────────");
  }
  lines.push("");
  lines.push("## Gates (raw)");
  for (const g of Object.values(r.gates)) {
    const mark = g.passedAtCeiling ? "✓✓" : g.passed ? "✓ " : "✗ ";
    lines.push(`  ${mark} ${g.name.padEnd(26)} ${pct(g.score).padStart(7)}  (floor ${g.threshold}, ceiling ${g.ceiling})  — ${g.detail}`);
  }
  if (r.gatesNet !== undefined) {
    lines.push("");
    lines.push(`## Gates (net of ${r.waivedCount} waiver${r.waivedCount === 1 ? "" : "s"})`);
    for (const g of Object.values(r.gatesNet)) {
      const mark = g.passedAtCeiling ? "✓✓" : g.passed ? "✓ " : "✗ ";
      lines.push(`  ${mark} ${g.name.padEnd(26)} ${pct(g.score).padStart(7)}  (floor ${g.threshold}, ceiling ${g.ceiling})  — ${g.detail}`);
    }
  }
  lines.push("");
  const activeItems = r.punchList.filter((p) => p.waivedBy === undefined);
  const waivedItems = r.punchList.filter((p) => p.waivedBy !== undefined);
  lines.push(`## Punch list (${r.punchList.length} item${r.punchList.length === 1 ? "" : "s"}${r.waivedCount > 0 ? `, ${r.waivedCount} waived` : ""})`);
  if (r.punchList.length === 0) {
    lines.push("  (empty — every gate at ceiling)");
  }
  for (const p of activeItems) {
    lines.push(`  [${p.severity}] ${p.gate} → ${p.cardSection}`);
    lines.push(`      ${p.detail}`);
    for (const s of p.exemplarSlices) {
      lines.push(`      · ${s.qualifiedName ?? s.symbolId}${s.role ? ` (role ${s.role})` : ""}`);
    }
  }
  if (waivedItems.length > 0) {
    lines.push("");
    lines.push("  --- waived ---");
    for (const p of waivedItems) {
      lines.push(`  [waived:${p.waivedBy}] ${p.gate} → ${p.cardSection}`);
      lines.push(`      ${p.detail}`);
    }
  }
  if (r.staleWaivers.length > 0) {
    lines.push("");
    lines.push(`## Stale waivers (${r.staleWaivers.length}) — these decision records matched no punch-list item`);
    for (const d of r.staleWaivers) {
      lines.push(`  [stale] ${d.id}  target: ${d.targetElement}`);
      lines.push(`      decision: ${d.decision}  rationale: ${d.rationale}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI recipe (import.meta.main) — thin wrapper documented in §8.2
// ---------------------------------------------------------------------------

if (import.meta.main) {
  // The artifact-reading recipe lives in eval/ctkr/port_verify_experiment.ts
  // (it needs DuckDB + the export JSONL lane). This entry documents the shape.
  process.stderr.write(
    "verifyPort: import { verifyPort } from this module, or run the recipe\n" +
      "  bun run eval/ctkr/port_verify_experiment.ts --data-dir <dir> --spec-subsystem <id> --port-subsystem <id>\n" +
      "The recipe is INSTRUMENT code and stays in this repo; the port artifacts it\n" +
      "reads live in the port workspace (METACODING_PORT_WORKSPACE, default eval/ctkr).\n" +
      "See docs/design/ct-subsystem-extraction.md §7 (T6).\n",
  );
  if (!isAbsolute(process.cwd())) throw new Error("unreachable");
}
