// Load a .scip file into a Store.
//
// Strategy:
//   Pass 1 — for every Definition occurrence in every Document, MERGE a
//   Symbol node (source='scip') keyed on our hash of the qualified_name.
//   The qualified_name shape matches the Tree-sitter extractor (file::Class::method)
//   so SCIP wins the lane-reconciliation: same id, same MERGE.
//
//   Pass 2 — for every reference Occurrence, find the *innermost enclosing
//   definition* in the same Document via enclosing_range, and emit a single
//   REFERENCES edge per (caller, callee) pair (deduped in-memory).
//
//   Relationships from SymbolInformation:
//     is_implementation -> IMPLEMENTS edge
//     is_type_definition -> TYPE_OF edge
//   subclass-of (extends) is not a first-class relationship in scip-typescript;
//   when we want it, we'll need a heuristic (LSP overlay) in a later phase.

import { readFileSync } from "node:fs";

import { scip } from "@sourcegraph/scip-typescript/src/scip.ts";

import type { GraphWriter } from "../store/build.ts";
import type { Edge, EdgeKind, EdgeProvenance, Symbol } from "../store/types";
import { symbolId } from "../extractor/identity";
import { assertMayIngest, type IngestTicket } from "../ingest/ticket.ts";
import {
  parseScipSymbol,
  qualifiedNameOf,
  shortNameOf,
  kindOf,
  phpQualifiedName,
  phpShortName,
  phpRealFile,
  isRustModuleSymbol,
  rustModulePrefix,
  rustQualifiedName,
  rustShortName,
  rustKindOf,
  rustImplOf,
  type ScipSymbol,
} from "./symbol";

export interface LoadScipOpts {
  /**
   * THE INGEST SEAM (bead MetaCoding-9ed). `loadScip` writes symbols and edges,
   * so it requires a capability issued by an index session — src/ingest/ticket.ts.
   */
  ticket: IngestTicket;
  branch: string;
  repo: string;
  /** Maps the SCIP scheme/file-extension to one of our `language` codes. */
  language?: "ts" | "py" | "php" | "rs";
  /** git rev-parse HEAD at index time; null when not in a git repo. */
  repo_commit_sha?: string | null;
  /** ISO-8601 timestamp (UTC) at the moment the index was started. */
  indexed_at?: string | null;
  /** When true, fold repo_commit_sha into Symbol.id for locally-defined
   *  symbols. External SCIP refs (externalQn at line 139) are NEVER sha-scoped
   *  — they're invariant across branches. bead MetaCoding-izn. */
  perCommitIdentity?: boolean;
  /** PHP only: PSR-4 namespace-prefix -> dir map used to prepare the repo.
   *  Lets the loader recover real file paths from scip-php's namespace-derived
   *  relative_path so PHP symbols reconcile with the Tree-sitter lane. See
   *  phpRealFile in ./symbol and scripts/scip-php-prep.ts (writes the sidecar). */
  phpPsr4Map?: Record<string, string>;
}

export interface LoadScipStats {
  documents: number;
  symbolsUpserted: number;
  edgesAdded: number;
  externalRefsSkipped: number;
  /** Pass-2b edges emitted to a synthesized external boundary node for a
   *  reference whose target is out-of-index but resolves to a Drupal\ symbol
   *  (bead MetaCoding-i00). These are counted here and NOT in
   *  externalRefsSkipped — a Drupal ref becomes a boundary edge, while
   *  everything else external (symfony / PHP stdlib / etc.) is still skipped. */
  externalBoundaryEdges: number;
  durationMs: number;
}

interface DefRecord {
  ourId: string;
  scipSymbol: string;
  docPath: string;
  enclosingRange: number[];   // [startLine, startCol, endLine, endCol] (or [startLine, startCol, endLineSameAsStart, endCol] when 3-tuple)
}

export async function loadScip(
  store: GraphWriter,
  scipPath: string,
  opts: LoadScipOpts,
): Promise<LoadScipStats> {
  const t0 = performance.now();
  assertMayIngest(
    opts?.ticket,
    { repo: opts?.repo, branch: opts?.branch, dataDir: store?.dataDir },
    "loadScip",
  );
  const bytes = readFileSync(scipPath);
  const idx = scip.Index.deserialize(bytes);

  // ----- Pass 1: upsert all defined Symbols -----
  const defByScip = new Map<string, DefRecord>();
  let symbolsUpserted = 0;

  // The kind each defined symbol was actually written with, keyed on the SCIP
  // symbol string — pass 2 picks edge kinds from it.
  const kindByScip = new Map<string, string>();
  const isRust = opts.language === "rs";

  // SymbolInformation map per document (for kind hint and relationships).
  for (const doc of idx.documents) {
    const infoBySymbol = new Map<string, scip.SymbolInformation>();
    for (const info of doc.symbols) infoBySymbol.set(info.symbol, info);
    const rust = isRust ? rustDocModule(doc) : null;

    for (const occ of doc.occurrences) {
      if (!(occ.symbol_roles & scip.SymbolRole.Definition)) continue;
      const parsed = parseScipSymbol(occ.symbol);
      if (!parsed || parsed.isLocal) continue;
      // PHP (scip-php) names symbols by FQN, not file path; reconcile against
      // the Tree-sitter lane's `<file>::Class::member` shape. scip-php's
      // relative_path is namespace-derived (elides the PSR-4 `/src/` root), so
      // when a PSR-4 map is available we recover the true path; otherwise we
      // fall back to relative_path. See phpQualifiedName / phpRealFile.
      const isPhp = opts.language === "php";
      const phpFile = isPhp
        ? (opts.phpPsr4Map && phpRealFile(parsed, opts.phpPsr4Map)) || doc.relative_path
        : doc.relative_path;
      const info = infoBySymbol.get(occ.symbol);
      // Rust: the document's own file-module definition IS the file symbol the
      // Tree-sitter lane writes (qn = path); everything else is rebuilt under it.
      const isRustFile = !!rust && rust.fileModuleSymbol === occ.symbol;
      const qn = isPhp
        ? phpQualifiedName(parsed, phpFile)
        : isRust
          ? (isRustFile ? doc.relative_path : rustQualifiedName(parsed, doc.relative_path, rust?.prefix ?? []))
          : qualifiedNameOf(parsed);
      const lang = opts.language ?? guessLanguageFromQn(qn);
      const idSha = opts.perCommitIdentity ? opts.repo_commit_sha ?? undefined : undefined;
      const id = symbolId(lang, opts.repo, qn, idSha);

      const kind = isRust
        ? (isRustFile ? "file" : rustKindOf(parsed, info?.kind))
        : kindOf(parsed, info?.kind);
      const shortName = isPhp
        ? phpShortName(parsed)
        : isRust
          ? (isRustFile ? doc.relative_path.split("/").pop() ?? doc.relative_path : rustShortName(parsed, rust?.prefix ?? []))
          : shortNameOf(parsed);
      kindByScip.set(occ.symbol, kind);
      const sym: Symbol = {
        id,
        kind,
        language: lang,
        repo: opts.repo,
        qualified_name: qn,
        short_name: shortName,
        file: phpFile,
        line: occ.range[0] ?? 0,
        col: occ.range[1] ?? 0,
        end_line: occ.range[2] ?? occ.range[0] ?? 0,
        end_col: occ.range[3] ?? occ.range[1] ?? 0,
        signature: null,
        visibility: null,
        is_abstract: false,
        is_static: false,
        ast_hash: null,
        branch: opts.branch,
        source: "scip",
        repo_commit_sha: opts.repo_commit_sha ?? null,
        indexed_at: opts.indexed_at ?? null,
      };
      await store.upsertSymbol(sym, { preserveStructural: true });
      symbolsUpserted++;

      defByScip.set(occ.symbol, {
        ourId: id,
        scipSymbol: occ.symbol,
        docPath: doc.relative_path,
        enclosingRange:
          occ.enclosing_range && occ.enclosing_range.length > 0
            ? occ.enclosing_range
            : occ.range,
      });
    }
  }

  // ----- Pass 2: edges -----
  const edgePairs = new Set<string>();   // de-dup (kind|src|dst)
  const edgesQueued: Edge[] = [];
  let externalRefsSkipped = 0;
  let externalBoundaryEdges = 0;

  const enqueue = (
    kind: EdgeKind,
    srcId: string,
    dstId: string,
    provenance?: EdgeProvenance,
  ): void => {
    if (srcId === dstId) return;
    const k = `${kind}|${srcId}|${dstId}`;
    if (edgePairs.has(k)) return;
    edgePairs.add(k);
    edgesQueued.push({ kind, src_id: srcId, dst_id: dstId, provenance });
  };

  // Boundary nodes for out-of-index external targets (bead MetaCoding-i00).
  // Keyed on the SAME `external::<ShortName>` scheme the Tree-sitter lane uses
  // (src/extractor/walker.ts ensureBoundaryNode) so scip-php REFERENCES/CALLS
  // and tree-sitter EXTENDS/IMPLEMENTS/USES_TRAIT collapse onto ONE node per
  // Drupal-core class — the role-cluster signal (ContentEntityBase, FormBase,
  // ControllerBase, …). Idempotent within this load via `boundaryUpserted`;
  // upsertSymbol is itself a MERGE so cross-load repeats are harmless.
  const boundaryUpserted = new Set<string>();
  const ensureExternalBoundary = async (shortName: string): Promise<string> => {
    const qn = `external::${shortName}`;
    const bid = symbolId("external", opts.repo, qn);
    if (boundaryUpserted.has(bid)) return bid;
    boundaryUpserted.add(bid);
    const sym: Symbol = {
      id: bid,
      kind: "class",
      language: "external",
      repo: opts.repo,
      qualified_name: qn,
      short_name: shortName,
      file: "",
      line: 0, col: 0, end_line: 0, end_col: 0,
      signature: null,
      visibility: null,
      is_abstract: false,
      is_static: false,
      ast_hash: null,
      branch: "",
      source: "scip",
      repo_commit_sha: null,
      indexed_at: null,
    };
    await store.upsertSymbol(sym, { preserveStructural: true });
    return bid;
  };

  // Rust trait impls. rust-analyzer emits no is_implementation relationship;
  // the impl is instead spelled into the member's symbol, `impl#[Self][Trait]m().`.
  // Resolve Self and Trait by name against the types defined in this index
  // (only when the name is unambiguous) and emit Self IMPLEMENTS Trait, plus
  // the member IMPLEMENTS the trait's declaration of it.
  if (isRust) {
    const byName = { trait: new Map<string, string[]>(), type: new Map<string, string[]>() };
    for (const [scipSym, kind] of kindByScip) {
      const bucket = kind === "interface" ? byName.trait
        : kind === "class" || kind === "enum" ? byName.type : null;
      if (!bucket) continue;
      const parsed = parseScipSymbol(scipSym);
      const last = parsed?.descriptors[parsed.descriptors.length - 1];
      if (!last || last.suffix !== "type" || last.name === "impl") continue;
      const list = bucket.get(last.name) ?? [];
      list.push(scipSym);
      bucket.set(last.name, list);
    }
    const unique = (m: Map<string, string[]>, name: string): string | undefined => {
      const l = m.get(name);
      return l && l.length === 1 ? l[0] : undefined;
    };
    for (const [scipSym, def] of defByScip) {
      if (!scipSym.includes("impl#[")) continue;
      const parsed = parseScipSymbol(scipSym);
      const impl = parsed ? rustImplOf(parsed) : null;
      if (!impl?.trait) continue;
      const traitSym = unique(byName.trait, impl.trait);
      if (!traitSym) continue;
      const selfSym = unique(byName.type, impl.self);
      if (selfSym) enqueue("IMPLEMENTS", defByScip.get(selfSym)!.ourId, defByScip.get(traitSym)!.ourId);
      const traitMember = defByScip.get(`${traitSym}${impl.member}().`) ?? defByScip.get(`${traitSym}${impl.member}#`);
      if (traitMember) enqueue("IMPLEMENTS", def.ourId, traitMember.ourId);
    }
  }

  // 2a — relationships (IMPLEMENTS, TYPE_OF, RETURNS_TYPE) from SymbolInformation.
  //
  // RETURNS_TYPE: when `is_type_definition` is set AND the *source* symbol is a
  // function or method, SCIP is saying "this symbol is defined as a type — its
  // return type is <rel.symbol>".  We emit RETURNS_TYPE in that case rather than
  // TYPE_OF to keep the two edge kinds semantically separate.
  for (const doc of idx.documents) {
    for (const info of doc.symbols) {
      const srcDef = defByScip.get(info.symbol);
      if (!srcDef) continue;
      const srcKind = kindByScip.get(info.symbol) ?? "";
      for (const rel of info.relationships) {
        const tgtDef = defByScip.get(rel.symbol);
        const dstId = tgtDef?.ourId
          ?? symbolId(opts.language ?? "ts", opts.repo, externalQn(rel.symbol));
        if (rel.is_implementation) enqueue("IMPLEMENTS", srcDef.ourId, dstId);
        if (rel.is_type_definition) {
          if (srcKind === "function" || srcKind === "method") {
            // Source is a callable — treat the related type as its return type.
            enqueue("RETURNS_TYPE", srcDef.ourId, dstId);
          } else {
            enqueue("TYPE_OF", srcDef.ourId, dstId);
          }
        }
      }
    }
  }

  // 2b — references: each non-Definition Occurrence becomes one or more edges
  // from its innermost-enclosing definition in the same document to the target.
  //
  // Edge selection:
  //   WriteAccess + target is field  → WRITES_FIELD
  //   ReadAccess  + target is field  → READS_FIELD
  //   No access flags + target is constructor (type suffix) → CONSTRUCTS
  //   Otherwise                      → REFERENCES
  for (const doc of idx.documents) {
    // Pre-compute defs in this document, sorted with the most-specific
    // (smallest enclosing range) first, so the first containment hit wins.
    const docDefs: { sym: string; range: number[]; ourId: string }[] = [];
    for (const occ of doc.occurrences) {
      if (!(occ.symbol_roles & scip.SymbolRole.Definition)) continue;
      const def = defByScip.get(occ.symbol);
      if (!def) continue;
      docDefs.push({
        sym: occ.symbol,
        range: occ.enclosing_range && occ.enclosing_range.length > 0
          ? occ.enclosing_range
          : occ.range,
        ourId: def.ourId,
      });
    }
    docDefs.sort((a, b) => rangeArea(a.range) - rangeArea(b.range));

    // Some indexers (scip-php) emit no enclosing_range on definitions, so the
    // range-containment lookup above can never match — a def's `range` is just
    // its name token. In that case, synthesize scopes from definition START
    // positions: a reference belongs to the container definition (class /
    // interface / enum / function / method) with the greatest start position at
    // or before the reference. Sorted ascending, the last such container is the
    // innermost (methods start after their enclosing class), giving
    // method-level attribution with class-level fallback.
    const hasEnclosing = doc.occurrences.some(
      (o) =>
        !!(o.symbol_roles & scip.SymbolRole.Definition) &&
        !!o.enclosing_range &&
        o.enclosing_range.length > 0,
    );
    const containerDefs = hasEnclosing
      ? []
      : doc.occurrences
          .filter((o) => {
            if (!(o.symbol_roles & scip.SymbolRole.Definition)) return false;
            if (!defByScip.has(o.symbol)) return false;
            const k = kindByScip.get(o.symbol) ?? "";
            return (
              k === "method" ||
              k === "function" ||
              k === "class" ||
              k === "interface" ||
              k === "enum"
            );
          })
          .map((o) => ({ start: o.range, ourId: defByScip.get(o.symbol)!.ourId }))
          .sort((a, b) => a.start[0]! - b.start[0]! || a.start[1]! - b.start[1]!);

    const findCaller = (occRange: number[]): { ourId: string } | undefined => {
      if (hasEnclosing) return docDefs.find((d) => rangeContains(d.range, occRange));
      // Greatest container start <= reference start (containerDefs is ascending).
      let best: { ourId: string } | undefined;
      for (const c of containerDefs) {
        if (posLE(c.start, occRange)) best = c;
        else break;
      }
      return best;
    };

    for (const occ of doc.occurrences) {
      if (occ.symbol_roles & scip.SymbolRole.Definition) continue;
      const targetDef = defByScip.get(occ.symbol);
      if (!targetDef) {
        // Out-of-index target (a symbol not defined anywhere in this .scip).
        // For Drupal\ targets — e.g. a farmOS class referencing / calling into
        // Drupal core (ContentEntityBase, FormBase, ControllerBase) once the
        // full-site index resolves them — keep the edge by pointing at a
        // name-keyed boundary node. Gated to the Drupal\ namespace so we don't
        // flood the graph with symfony / PHP-stdlib boundary noise. Everything
        // else stays counted as skipped. bead MetaCoding-i00.
        const boundaryClass = drupalBoundaryClass(occ.symbol);
        if (!boundaryClass) {
          externalRefsSkipped++;
          continue;
        }
        const extCaller = findCaller(occ.range);
        if (!extCaller) {
          externalRefsSkipped++;
          continue;
        }
        const boundaryId = await ensureExternalBoundary(boundaryClass);
        // Edge kind from the external target's descriptor shape. We emit
        // REFERENCES for every kept occurrence and additionally CALLS when the
        // target is a method — the clean incremental signal (a farmOS method
        // invoking a resolved Drupal-core method). We deliberately do NOT guess
        // CONSTRUCTS here: a bare type reference is indistinguishable from an
        // extends/implements clause or a type-hint at the symbol level, and the
        // Tree-sitter lane already carries typed EXTENDS/IMPLEMENTS/USES_TRAIT
        // edges to this same boundary node.
        enqueue("REFERENCES", extCaller.ourId, boundaryId);
        if (isMethodSymbol(occ.symbol)) enqueue("CALLS", extCaller.ourId, boundaryId);
        externalBoundaryEdges++;
        continue;
      }
      const caller = findCaller(occ.range);
      if (!caller) continue;

      const targetKind = kindByScip.get(occ.symbol) ?? "";
      const isWrite = !!(occ.symbol_roles & scip.SymbolRole.WriteAccess);
      const isRead  = !!(occ.symbol_roles & scip.SymbolRole.ReadAccess);

      if (targetKind === "field" && isWrite) {
        enqueue("WRITES_FIELD", caller.ourId, targetDef.ourId, "scip");
      } else if (targetKind === "field" && isRead) {
        enqueue("READS_FIELD", caller.ourId, targetDef.ourId, "scip");
      } else if (!isRust && isConstructorSymbol(occ.symbol) && !isRead && !isWrite) {
        // Not Rust: a bare reference to a Rust type is as likely a signature
        // or a trait bound as a struct literal, and Rust has no constructors.
        enqueue("CONSTRUCTS", caller.ourId, targetDef.ourId);
      } else {
        enqueue("REFERENCES", caller.ourId, targetDef.ourId);
        // CALLS derivation (bead MetaCoding-slh). SCIP's occurrence model has
        // no "call" role, so scip-python/scip-typescript emit every call-site
        // as a plain REFERENCES occurrence and the typed CALLS edge — the
        // single highest-leverage who-calls-whom signal for the CTKR
        // hom-profiles — is never produced (CALLS was empirically 0 on the
        // Orchestrators corpus). A reference whose resolved target is a
        // callable (function or method) is, to high recall, an invocation, so
        // we ADD a distinct CALLS edge here while KEEPING the REFERENCES edge
        // (a call-site is legitimately both). Heuristic caveat: a function
        // reference is usually but not always a call — e.g. higher-order
        // passing (`map(fn)`) or taking a method reference without invoking it
        // — so this is high-recall, not exact. CALLS is a distinct, populated
        // profile dimension; REFERENCES semantics are preserved unchanged.
        if (targetKind === "function" || targetKind === "method") {
          enqueue("CALLS", caller.ourId, targetDef.ourId);
        }
      }
    }
  }

  // Flush edges to the Store.
  for (const e of edgesQueued) await store.addEdge(e);

  return {
    documents: idx.documents.length,
    symbolsUpserted,
    edgesAdded: edgesQueued.length,
    externalRefsSkipped,
    externalBoundaryEdges,
    durationMs: performance.now() - t0,
  };
}

// SCIP ranges are [startLine, startCol, endCol] (3-tuple, same line)
// or [startLine, startCol, endLine, endCol] (4-tuple).
function expand(range: number[]): { sl: number; sc: number; el: number; ec: number } {
  if (range.length === 3) return { sl: range[0]!, sc: range[1]!, el: range[0]!, ec: range[2]! };
  return { sl: range[0]!, sc: range[1]!, el: range[2]!, ec: range[3]! };
}

function rangeArea(range: number[]): number {
  const r = expand(range);
  // Approximate "size" by line span; finer-grained ordering not needed.
  return (r.el - r.sl) * 1_000_000 + (r.ec - r.sc);
}

// True when position `a` (a [line, col, ...] range start) is at or before the
// start of range `b`. Used to attribute a reference to the nearest preceding
// container definition when enclosing_range is absent (scip-php).
function posLE(a: number[], b: number[]): boolean {
  const al = a[0] ?? 0, ac = a[1] ?? 0;
  const bl = b[0] ?? 0, bc = b[1] ?? 0;
  return al < bl || (al === bl && ac <= bc);
}

function rangeContains(outer: number[], inner: number[]): boolean {
  const o = expand(outer);
  const i = expand(inner);
  if (i.sl < o.sl) return false;
  if (i.sl === o.sl && i.sc < o.sc) return false;
  if (i.el > o.el) return false;
  if (i.el === o.el && i.ec > o.ec) return false;
  return true;
}

// For an out-of-index SCIP symbol, return the short class name to key its
// boundary node on IFF the symbol lives under the PHP `Drupal\` namespace root
// (scip-php descriptors: namespace "Drupal", …, type "<Class>"). Returns null
// for non-Drupal symbols (symfony, PHP stdlib, local, procedural) and for any
// symbol with no enclosing type descriptor. The returned name matches the
// Tree-sitter lane's `external::<ShortName>` boundary key so the two lanes
// merge onto one node per Drupal-core class. bead MetaCoding-i00.
function drupalBoundaryClass(scipSymbol: string): string | null {
  const parsed = parseScipSymbol(scipSymbol);
  if (!parsed || parsed.isLocal) return null;
  const firstNs = parsed.descriptors.find((d) => d.suffix === "namespace");
  if (!firstNs || firstNs.name !== "Drupal") return null;
  // The class this symbol belongs to = the last `type`-suffix descriptor.
  const types = parsed.descriptors.filter((d) => d.suffix === "type");
  const cls = types[types.length - 1];
  return cls ? cls.name : null;
}

// True when the SCIP symbol's last meaningful descriptor is a method — used to
// add a CALLS edge alongside REFERENCES for a resolved external method target.
function isMethodSymbol(scipSymbol: string): boolean {
  const parsed = parseScipSymbol(scipSymbol);
  if (!parsed || parsed.isLocal) return false;
  const meaningful = parsed.descriptors.filter(
    (d) => d.suffix !== "type_parameter" && d.suffix !== "parameter",
  );
  return meaningful[meaningful.length - 1]?.suffix === "method";
}

function externalQn(scipSymbol: string): string {
  // For symbols we don't have a definition for (cross-package references),
  // hash the SCIP symbol string itself so the edge has a stable target id.
  // The target node may not exist in our graph; that's expected — the agent
  // can still see "this symbol references something external".
  return `external::${scipSymbol}`;
}

function guessLanguageFromQn(qn: string): "ts" | "py" | "rs" {
  if (/\.rs(::|$)/.test(qn)) return "rs";
  return /\.(py|pyi)(::|$)/.test(qn) ? "py" : "ts";
}

// A rust-analyzer document's own module: the namespace-only symbol DEFINED in
// it over the whole file (range starting 0:0). An inline `mod x {}` is also a
// namespace definition, but its range is its name token, never 0:0.
function rustDocModule(doc: scip.Document): { fileModuleSymbol: string | null; prefix: string[] } {
  for (const occ of doc.occurrences) {
    if (!(occ.symbol_roles & scip.SymbolRole.Definition)) continue;
    if (occ.range[0] !== 0 || occ.range[1] !== 0) continue;
    const parsed: ScipSymbol | null = parseScipSymbol(occ.symbol);
    if (!parsed || parsed.isLocal || !isRustModuleSymbol(parsed)) continue;
    return { fileModuleSymbol: occ.symbol, prefix: rustModulePrefix(parsed) };
  }
  return { fileModuleSymbol: null, prefix: [] };
}

// Detect whether a SCIP symbol string refers to a constructor.
// In scip-typescript (v0.4.0), constructors appear as method descriptors with
// the backtick-quoted, angle-bracketed name `<constructor>` and an empty
// disambiguator (e.g., `... ClassName#`<constructor>`().`). Verified against
// real scip-typescript output — see the "isConstructorSymbol" tests, which
// assert the actual emitted symbol shape.
// In scip-python (v0.6.6), `__init__` methods serve as constructors
// (e.g., `... MyClass#__init__().`).
// We also treat an occurrence whose *last meaningful descriptor* is a
// `type` suffix (class definition symbol) as a CONSTRUCTS target — this
// handles `new Foo()` resolved to the class symbol when no explicit
// constructor is emitted.
function isConstructorSymbol(scipSymbol: string): boolean {
  // Fast path: check common constructor patterns before full parse.
  // The disambiguator is normally empty (`()`) but is matched permissively
  // ([^)]*) in case scip-typescript emits one for overloaded constructors.
  if (
    /`<constructor>`\([^)]*\)\./.test(scipSymbol) || // scip-typescript constructor
    /__init__\([^)]*\)\./.test(scipSymbol)           // scip-python __init__
  ) {
    return true;
  }
  // Structural check: if the last meaningful descriptor is a `type` suffix
  // (class), a reference to it without read/write flags is construction.
  const parsed = parseScipSymbol(scipSymbol);
  if (!parsed || parsed.isLocal) return false;
  const meaningful = parsed.descriptors.filter(
    (d) => d.suffix !== "type_parameter" && d.suffix !== "parameter",
  );
  const last = meaningful[meaningful.length - 1];
  return last?.suffix === "type";
}
