// Directory walker — runs Tree-sitter extractors over every supported file
// in a tree and pumps results into a GraphWriter.
//
// WHOLE-TREE IS NOT INCREMENTAL (bead MetaCoding-9jt). `indexDirectory` walks
// and extracts EVERY file, every time. It used to skip files whose content hash
// matched the stored ast_hash, and that skip was a correctness defect, not an
// optimization: cross-file edge candidates are resolved at the end of the walk
// against a SymbolResolver populated BY the walk, so a skipped file is absent
// from the resolver and every candidate pointing at it is dropped — silently,
// permanently, and while every freshness check still passes. Meanwhile the
// changed file's `deleteFileData` had already DETACH DELETEd edges owned by
// those very files. Measured: fresh 14 edges, incremental 12, both HEALTHY.
//
// The skip was also never where the time went. Parse + extract of this repo's
// 92 files is 269ms; the write path was 76s. See src/store/build.ts.
//
// `indexFile` / `removeFile` (watch mode) still write per-file into a live
// Store and still carry the defect above — deliberately, per
// docs/design/graph-as-cache.md, which names watch as a mutable scratch entry.
//
// Multi-repo: callers pass `repo` (defaults to the basename of the
// indexed root). Symbol ids include repo so cross-repo names don't clash.
//
// Multi-language dispatch: `.ts` / `.tsx` -> TypeScript extractor;
// `.js` / `.mjs` / `.cjs` -> JavaScript; `.py` -> Python; `.php` -> PHP;
// `.rs` -> Rust; `.kt` / `.kts` -> Kotlin; `.swift` -> Swift.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import type { Store } from "../store";
import type { GraphWriter } from "../store/build.ts";
import type { Edge, Symbol } from "../store/types";
import {
  extractEdgeCandidates,
  SymbolResolver,
  type EdgeCandidate,
} from "./edges";
import { fileContentHash, symbolId } from "./identity";
import { loadLanguage, makeParser, type TsParser } from "./parser";
import { extractTypeScript, type ExtractOpts as TsExtractOpts } from "./typescript";
import { extractPython, type ExtractPyOpts } from "./python";
import { extractPhp, type ExtractPhpOpts } from "./php";
import { extractStructural, type ExtractStructuralOpts } from "./structural";
import { assertMayIngest, type IngestTicket } from "../ingest/ticket.ts";
import { toolchainDigest } from "../toolchain/identity.ts";

/**
 * Every grammar this walker can parse with, ENUMERABLE AT RUNTIME.
 *
 * It was a bare union type (bead MetaCoding-7sv). A fifth grammar added there
 * would have been loaded, folded into every layer-2 key, and declared in
 * toolchain.lock.json never — the live preflight fixture hardcoded the four
 * names, so nothing could notice. `Grammar` is now DERIVED from this array, so
 * a new grammar cannot typecheck without joining the list, and the list is what
 * src/toolchain/preflight.test.ts checks the lock against.
 */
export const GRAMMARS = [
  "typescript",
  "tsx",
  "javascript",
  "python",
  "php",
  "rust",
  "kotlin",
  "swift",
] as const;
type Grammar = (typeof GRAMMARS)[number];

export interface WalkOpts {
  /**
   * THE INGEST SEAM (bead MetaCoding-9ed). Every function in this file WRITES to
   * the Store, so every one of them requires a capability issued by an index
   * session — see src/ingest/ticket.ts. Required, and nominal: there is no
   * import shape that reaches these functions without one.
   */
  ticket: IngestTicket;
  branch?: string;
  repo?: string;
  excludeDirs?: string[];
  /** git rev-parse HEAD at the moment the index was started; null when not in a git repo. */
  repo_commit_sha?: string | null;
  /** ISO-8601 timestamp (UTC) at the moment the index was started. */
  indexed_at?: string | null;
  /** When true, fold repo_commit_sha into Symbol.id so multiple commits coexist
   *  in one DB. Default false (existing overwrite behaviour). bead MetaCoding-izn. */
  perCommitIdentity?: boolean;
}

export interface WalkStats {
  filesScanned: number;
  filesSkipped: number;
  filesUpdated: number;
  filesDeleted: number;
  symbols: number;
  edges: number;
  tokens: number;
  durationMs: number;
  /**
   * THE TOOLCHAIN THIS BUILD PARSED WITH (bead MetaCoding-0bm; blocking finding
   * 2 on MetaCoding-0bd's judgment).
   *
   * src/toolchain/identity.ts could measure every loaded .wasm and fold it into
   * `layer2Key`, and NOTHING IN PRODUCTION CALLED EITHER. A judge grepped
   * `layer2Key|toolchainDigest|loadedArtifacts` across src/ and scripts/ and
   * found the loader's registrations at one end, the key's fixtures at the
   * other, and no path between them that a real index run takes. A mechanism
   * that only its own tests execute is a document with an exit code
   * (docs/design/enforceability.md).
   *
   * So the whole-tree build now STATES the digest of the toolchain that
   * produced its facts, taken from the process registry — the same default
   * binding F3.1b holds. 0bm's own description is what this serves: "the cache
   * model requires a reader to RECOMPUTE a key from the artifact's own recorded
   * inputs".
   *
   * AND IT IS RECORDED, which for one release it was not (bead
   * MetaCoding-1j5). This field's whole consumer chain ended at a
   * `console.log` in src/cli/main.ts while this comment already called it
   * "recorded", so nothing that later opened the store could recover which
   * grammar produced its facts — a claim in a comment the code did not
   * implement. `runIndexSession` now writes it into the health record beside
   * `index_identities`, the persisted channel that already carries the SCIP
   * lane's input identities and is already read back from the store
   * (src/ingest/toolchain-recorded.test.ts).
   *
   * NOT YET the sealed keyed entry. `layer2Key` still has no production caller
   * because there is no manifest to put a key in (bead MetaCoding-ev9, named in
   * src/store/build.ts:33). The FOLD executes here; the KEY's other six inputs
   * do not exist, and inventing placeholders for them would fold constants into
   * a key, which is the defect this file's digest exists to remove.
   */
  toolchain_digest: string;
}

/** Directory names never descended by the walker. Exported so the index
 *  productivity gate (src/cli/index-gate.ts, bead MetaCoding-0sd) counts its
 *  coverage denominator over exactly the tree a lane could have indexed. */
export const DEFAULT_EXCLUDE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  "coverage",
  ".omc",
  ".metacoding",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "site-packages",
];

interface ScannedFile {
  abs: string;
  rel: string;
  grammar: Grammar;
}

type ParserCache = Record<Grammar, TsParser>;

let cachedParsers: ParserCache | null = null;
/**
 * FOUND BY F3.5, not by review (src/extractor/walker.toolchain.test.ts).
 *
 * src/extractor/parser.ts:47 already had to fix exactly this: registering the
 * digest only on the cache MISS hands out a grammar with no measurement behind
 * it. This module has a SECOND cache in front of that one, and it had the same
 * hole one layer up — `if (cachedParsers) return cachedParsers` returns four
 * parsers without ever reaching `loadLanguage`, so the registry that
 * `toolchainDigest()` reads stays as whatever the last caller left it. The
 * fixture that emptied the registry and indexed a tree got NO_ARTIFACTS.
 *
 * So the hit path re-asserts through `loadLanguage`, whose own hit path
 * re-registers from the identity it measured when it read the bytes. It is a
 * Map lookup and a Map set per grammar; no file is re-read and no digest is
 * recomputed, which is the point — the measurement is still the one taken from
 * the buffer that became the grammar.
 */
async function getParsers(): Promise<ParserCache> {
  if (cachedParsers) {
    for (const g of GRAMMARS) await loadLanguage(g);
    return cachedParsers;
  }
  const built = {} as ParserCache;
  for (const g of GRAMMARS) built[g] = await makeParser(g);
  cachedParsers = built;
  return cachedParsers;
}

export async function indexDirectory(
  writer: GraphWriter,
  rootPath: string,
  opts: WalkOpts,
): Promise<WalkStats> {
  const t0 = performance.now();
  const branch = opts.branch ?? "main";
  const repo = opts.repo ?? basename(resolve(rootPath));
  assertMayIngest(opts?.ticket, { repo, branch, dataDir: writer?.dataDir }, "indexDirectory");

  // TOOLCHAIN BEFORE THE WALK (bead MetaCoding-0bm). The grammars are loaded —
  // and therefore MEASURED — before the first file is read, not lazily on the
  // first parseable one. Otherwise a tree that happens to contain no parseable
  // file produces a build with an empty registry, and `toolchainDigest()` below
  // would refuse a run that did nothing wrong. Loading up front makes the
  // refusal mean the one thing it should: the loader handed out a grammar it
  // did not measure. `getParsers` is process-cached, so this costs one wasm
  // read per process, not per index.
  await getParsers();

  const exclude = new Set([...DEFAULT_EXCLUDE_DIRS, ...(opts.excludeDirs ?? [])]);

  const files: ScannedFile[] = [];
  walkFs(rootPath, rootPath, exclude, files);

  let symbols = 0;
  let edges = 0;
  let tokens = 0;
  let filesSkipped = 0;
  let filesUpdated = 0;

  // Cross-file edge resolution (MetaCoding-3s5). Collected per-file during the
  // main pass, then resolved against an in-memory index of *all* symbols seen
  // in this directory walk so cross-file `new Foo()` finds Foo's class node.
  //
  // This is the invariant the removed content-hash skip violated: EVERY unit
  // must be in the resolver for ANY unit's cross-file edges to resolve. The
  // only files counted as skipped now are ones no grammar could parse.
  const resolver = new SymbolResolver();
  const pendingCandidates: EdgeCandidate[] = [];

  for (const f of files) {
    const r = await indexOne(
      writer, f, repo, branch,
      opts.repo_commit_sha, opts.indexed_at, opts.perCommitIdentity,
      resolver, pendingCandidates,
    );
    if (r.skipped) filesSkipped++;
    else {
      filesUpdated++;
      symbols += r.symbols;
      edges += r.edges;
      tokens += r.tokens;
    }
  }

  // Resolve and flush the deferred behavior-edges (WRITES_FIELD, CONSTRUCTS,
  // RETURNS_TYPE). Dangling refs (target name not in the repo) are dropped.
  edges += await flushCandidates(writer, pendingCandidates, resolver, repo);

  return {
    filesScanned: files.length,
    filesSkipped,
    filesUpdated,
    filesDeleted: 0,
    symbols,
    edges,
    tokens,
    durationMs: performance.now() - t0,
    // NO ARGUMENT, deliberately. The default IS the link from the loader's
    // registry to the key (F3.1b), and this is the production call site that
    // exercises it. A build whose parsers were never measured throws
    // NO_ARTIFACTS here rather than reporting facts nobody can recompute.
    toolchain_digest: toolchainDigest(),
  };
}

export async function indexFile(
  store: Store,
  rootPath: string,
  filePath: string,
  opts: WalkOpts,
): Promise<{ skipped: boolean; symbols: number; edges: number; tokens: number }> {
  const branch = opts.branch ?? "main";
  const repo = opts.repo ?? basename(resolve(rootPath));
  // indexFile writes symbols, edges AND tokens. It was exported from the
  // extractor barrel and absent from the old guard list entirely — the judge's
  // bypass G needed no evasion at all (bead MetaCoding-9ed).
  assertMayIngest(opts?.ticket, { repo, branch, dataDir: store?.dataDir }, "indexFile");
  const abs = isAbsolute(filePath) ? filePath : resolve(rootPath, filePath);
  const grammar = detectGrammar(abs);
  if (!grammar) return { skipped: true, symbols: 0, edges: 0, tokens: 0 };
  const rel = relative(rootPath, abs);
  // For single-file indexing (watch mode), we resolve edge candidates against
  // a resolver hydrated with this file's own symbols PLUS a best-effort lookup
  // against symbols already in the store for the same repo. Cross-file targets
  // from other-file writes/constructs are best resolved in the directory pass.
  //
  // Perf (MetaCoding-zq2): rather than materialize the ENTIRE per-repo symbol
  // table on every single-file save, we run the extract pass FIRST to collect
  // this file's edge candidates, then hydrate the resolver only for the
  // `short_name`s those candidates can actually resolve against. A candidate
  // whose target short_name is absent from the store can never resolve, so
  // omitting it from the hydrate changes no edge — it's a pure scoping win.
  const resolver = new SymbolResolver();
  const pending: EdgeCandidate[] = [];
  const r = await indexOne(
    store, { abs, rel, grammar }, repo, branch,
    opts.repo_commit_sha, opts.indexed_at, opts.perCommitIdentity,
    resolver, pending,
    store, // watch mode keeps the per-file hash skip + delete against a live Store
  );
  // Hydrate only the short_names the pending candidates reference. Empty set
  // (no behavior edges in this file) skips the store query entirely.
  const neededNames = collectCandidateShortNames(pending);
  if (neededNames.length > 0) {
    await hydrateResolverFromStore(store, resolver, repo, branch, neededNames);
  }
  const flushed = await flushCandidates(store, pending, resolver, repo);
  return { ...r, edges: r.edges + flushed };
}

export async function removeFile(
  store: Store,
  rootPath: string,
  filePath: string,
  opts: WalkOpts,
): Promise<void> {
  const branch = opts.branch ?? "main";
  const repo = opts.repo ?? basename(resolve(rootPath));
  // Deleting a file's symbols mutates the graph the verdict describes just as
  // surely as adding them.
  assertMayIngest(opts?.ticket, { repo, branch, dataDir: store?.dataDir }, "removeFile");
  const abs = isAbsolute(filePath) ? filePath : resolve(rootPath, filePath);
  const rel = relative(rootPath, abs);
  await store.deleteFileData(repo, rel, branch);
}

async function indexOne(
  writer: GraphWriter,
  f: ScannedFile,
  repo: string,
  branch: string,
  repo_commit_sha?: string | null,
  indexed_at?: string | null,
  perCommitIdentity?: boolean,
  resolver?: SymbolResolver,
  pendingCandidates?: EdgeCandidate[],
  /**
   * WATCH MODE ONLY. When present, this file's prior data is looked up by
   * content hash and deleted in place before re-extraction.
   *
   * The whole-tree path passes nothing, and that is the fix for
   * MetaCoding-9jt: skipping a file removes it from the SymbolResolver, so
   * OTHER files' cross-file edges into it are dropped as unresolvable, while
   * `deleteFileData` has already destroyed the copies those files owned.
   */
  incremental?: Store,
): Promise<{ skipped: boolean; symbols: number; edges: number; tokens: number }> {
  const source = readFileSync(f.abs, "utf-8");
  const newHash = fileContentHash(source);

  // In per-commit-identity mode every commit produces its own row family
  // (Symbol.id is sha-scoped), so the (repo, file, branch) cache key is
  // ambiguous — skip the incremental cache and the cross-commit wipe.
  if (incremental && !perCommitIdentity) {
    const oldHash = await incremental.fileHash(repo, f.rel, branch);
    if (oldHash === newHash) {
      return { skipped: true, symbols: 0, edges: 0, tokens: 0 };
    }
    if (oldHash) {
      await incremental.deleteFileData(repo, f.rel, branch);
    }
  }

  const parsers = await getParsers();
  const tree = parsers[f.grammar].parse(source);
  if (!tree) return { skipped: true, symbols: 0, edges: 0, tokens: 0 };

  let result;
  if (f.grammar === "python") {
    const eo: ExtractPyOpts = {
      filePath: f.rel, branch, repo, repo_commit_sha, indexed_at, perCommitIdentity,
    };
    result = extractPython(tree, eo);
  } else if (f.grammar === "php") {
    const eo: ExtractPhpOpts = {
      filePath: f.rel, branch, repo, repo_commit_sha, indexed_at, perCommitIdentity,
    };
    result = extractPhp(tree, eo);
  } else if (f.grammar === "typescript" || f.grammar === "tsx") {
    const eo: TsExtractOpts = {
      filePath: f.rel, grammar: f.grammar, branch, repo, repo_commit_sha, indexed_at, perCommitIdentity,
    };
    result = extractTypeScript(tree, eo);
  } else {
    const eo: ExtractStructuralOpts = {
      filePath: f.rel, grammar: f.grammar, branch, repo, repo_commit_sha, indexed_at, perCommitIdentity,
    };
    result = extractStructural(tree, eo);
  }

  // Stamp the file Symbol's ast_hash with the content hash so the next
  // pass can skip when content is unchanged.
  for (const sym of result.symbols) {
    if (sym.kind === "file" && sym.file === f.rel) sym.ast_hash = newHash;
  }

  for (const sym of result.symbols) await writer.upsertSymbol(sym);
  for (const edge of result.edges) await writer.addEdge(edge);
  writer.writeTokens(result.tokens);

  // Behavior-edge pass (MetaCoding-3s5). Feed every extracted symbol into the
  // resolver, then collect WRITES_FIELD / CONSTRUCTS / RETURNS_TYPE candidates.
  // Targets are resolved later (end of directory walk) when all repo symbols
  // are in the index — supports cross-file `new Foo()` etc.
  //
  if (resolver && pendingCandidates) {
    for (const sym of result.symbols) resolver.add(sym);
    const edgeLang = f.grammar === "python" ? "py" : f.grammar === "php" ? "php" : f.grammar === "typescript" || f.grammar === "tsx" ? "ts" : null;
    if (edgeLang) {
      const er = extractEdgeCandidates(tree, {
        language: edgeLang,
        filePath: f.rel,
        symbols: result.symbols,
      });
      for (const c of er.candidates) pendingCandidates.push(c);
    }
  }

  tree.delete();
  return {
    skipped: false,
    symbols: result.symbols.length,
    edges: result.edges.length,
    tokens: result.tokens.length,
  };
}

/**
 * Resolve every pending edge candidate against the symbol index, dedupe by
 * (kind, src, dst), and add to the store. Returns the count of edges flushed.
 *
 * Dropped candidates (target not in repo) are counted in the returned summary.
 */
async function flushCandidates(
  writer: GraphWriter,
  candidates: EdgeCandidate[],
  resolver: SymbolResolver,
  repo: string,
): Promise<number> {
  if (candidates.length === 0) return 0;
  const dedupe = new Set<string>();
  const boundaryUpserted = new Set<string>();
  let flushed = 0;
  for (const c of candidates) {
    let dst = resolver.resolve(c.target, repo);
    if (!dst && c.target.externalFallback) {
      // No in-repo definition — keep the edge by pointing at a name-keyed
      // boundary node (e.g. Drupal's ContentEntityBase). All references to the
      // same name collapse to one node, which is exactly the role-cluster
      // signal we want. Boundary nodes use language "external" so their ids
      // never collide with real symbols. bead MetaCoding-1xd.
      dst = await ensureBoundaryNode(writer, repo, c.target, boundaryUpserted);
    }
    if (!dst) continue;
    if (dst === c.src_id) continue;   // self-edges are noise
    const key = `${c.kind}|${c.src_id}|${dst}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    const edge: Edge = { kind: c.kind, src_id: c.src_id, dst_id: dst };
    // Field-access edges from this lane are Tree-sitter heuristics, not SCIP
    // access-role occurrences — mark them so consumers can distinguish the two
    // (bead MetaCoding-vju). For PHP this is the ONLY source of these edges,
    // since scip-php emits no ReadAccess/WriteAccess roles at all.
    if (c.kind === "READS_FIELD" || c.kind === "WRITES_FIELD") {
      edge.provenance = "tree_sitter_heuristic";
    }
    await writer.addEdge(edge);
    flushed++;
  }
  return flushed;
}

/**
 * Ensure a name-keyed boundary Symbol exists for an unresolved external target
 * (e.g. a base class defined outside the repo) and return its id. Idempotent
 * within a flush via `seen`; upsertSymbol is itself a MERGE so repeated calls
 * across flushes are harmless. Boundary nodes use language "external" and carry
 * no file/position — they exist only as shared edge targets. bead MetaCoding-1xd.
 */
async function ensureBoundaryNode(
  writer: GraphWriter,
  repo: string,
  target: { kinds: string[]; shortName: string },
  seen: Set<string>,
): Promise<string> {
  const qn = `external::${target.shortName}`;
  const id = symbolId("external", repo, qn);
  if (seen.has(id)) return id;
  seen.add(id);
  const sym: Symbol = {
    id,
    kind: (target.kinds[0] as Symbol["kind"]) ?? "class",
    language: "external",
    repo,
    qualified_name: qn,
    short_name: target.shortName,
    file: "",
    line: 0, col: 0, end_line: 0, end_col: 0,
    signature: null,
    visibility: null,
    is_abstract: false,
    is_static: false,
    ast_hash: null,
    branch: "",
    source: "tree_sitter",
    repo_commit_sha: null,
    indexed_at: null,
  };
  await writer.upsertSymbol(sym);
  return id;
}

/**
 * Collect the distinct target `short_name`s referenced by a batch of pending
 * edge candidates. Used to scope the watch-mode resolver hydrate (MetaCoding-zq2)
 * so we only pull store symbols that a candidate could actually resolve against.
 */
function collectCandidateShortNames(candidates: EdgeCandidate[]): string[] {
  const names = new Set<string>();
  for (const c of candidates) names.add(c.target.shortName);
  return [...names];
}

/**
 * Populate a SymbolResolver from symbols already in the store for a given
 * (repo, branch). Used by single-file indexing (watch mode) so cross-file
 * targets from already-indexed files can still resolve.
 *
 * `names` scopes the hydrate to symbols whose `short_name` is in the list
 * (MetaCoding-zq2 perf): materializing the full per-repo symbol table on every
 * save is hundreds of ms + tens of MB for large repos, and only symbols whose
 * short_name a pending candidate references can ever resolve anyway. Callers
 * MUST pass a non-empty list — an empty list would match nothing, so skip the
 * call entirely in that case.
 */
async function hydrateResolverFromStore(
  store: Store,
  resolver: SymbolResolver,
  repo: string,
  branch: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) return;
  type Row = { id: string; repo: string; kind: string; short_name: string; qualified_name: string };
  const rows = await store.query<Row>(
    `MATCH (s:Symbol)
     WHERE s.repo = $repo AND s.branch = $branch AND s.short_name IN $names
     RETURN s.id AS id, s.repo AS repo, s.kind AS kind,
            s.short_name AS short_name, s.qualified_name AS qualified_name`,
    { repo, branch, names },
  );
  for (const r of rows) {
    resolver.add({
      id: r.id,
      kind: r.kind as Symbol["kind"],
      language: "ts",
      repo: r.repo,
      qualified_name: r.qualified_name,
      short_name: r.short_name,
      file: "",
      line: 0,
      col: 0,
      end_line: 0,
      end_col: 0,
      signature: null,
      visibility: null,
      is_abstract: false,
      is_static: false,
      ast_hash: null,
      branch,
      source: "tree_sitter",
    });
  }
}

function walkFs(
  root: string,
  dir: string,
  exclude: Set<string>,
  out: ScannedFile[],
): void {
  for (const name of readdirSync(dir)) {
    if (exclude.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      // Hidden directories are tool state, never source (MetaCoding-wg7:
      // .claude/worktrees/agent-* held literal copies of src files, so
      // role-equivalence twins were dominated by cos-1.0 worktree
      // duplicates). The property is broader than a denylist entry: NO
      // dot-directory is descended, so the next tool's hidden dir cannot
      // re-open the hole. Hidden FILES are unaffected (none of the
      // indexed grammars hide in dot-files).
      if (name.startsWith(".")) continue;
      walkFs(root, abs, exclude, out);
    } else if (st.isFile()) {
      const grammar = detectGrammar(name);
      if (grammar) out.push({ abs, rel: relative(root, abs), grammar });
    }
  }
}

export function detectGrammar(filename: string): Grammar | null {
  if (filename.endsWith(".d.ts")) return null;
  if (filename.endsWith(".tsx")) return "tsx";
  if (filename.endsWith(".mts") || filename.endsWith(".cts")) return "typescript";
  if (filename.endsWith(".ts")) return "typescript";
  if (filename.endsWith(".mjs") || filename.endsWith(".cjs") || filename.endsWith(".js")) return "javascript";
  if (filename.endsWith(".py")) return "python";
  if (filename.endsWith(".rs")) return "rust";
  if (filename.endsWith(".kt") || filename.endsWith(".kts")) return "kotlin";
  if (filename.endsWith(".swift")) return "swift";
  // PHP, plus the extensionless-`<?php` file types Drupal uses (farmOS and
  // other Drupal codebases put real PHP in .module/.install/.theme/etc.).
  if (
    filename.endsWith(".php") ||
    filename.endsWith(".phtml") ||
    filename.endsWith(".inc") ||
    filename.endsWith(".module") ||
    filename.endsWith(".install") ||
    filename.endsWith(".theme") ||
    filename.endsWith(".profile") ||
    filename.endsWith(".engine")
  ) {
    return "php";
  }
  return null;
}
