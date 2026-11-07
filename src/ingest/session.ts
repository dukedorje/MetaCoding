// The INDEX SESSION — root 2 of docs/design/index-fitness.md.
//
// THE SEAM, AND WHY IT IS HERE AND NOT IN THE CLI
// ==============================================
// The previous gate lived in `cmdIndex`, so `metacoding watch` — which ingests
// through the same primitives — had no gate at all, and any future caller would
// have to remember to add one. "Add a call in cmdWatch" fixes one caller and
// leaves the property depending on every future caller's memory. A guard is a
// patch the next reader walks around.
//
// So this module sits ABOVE extractor/scip and BELOW cli, and it is the ONLY
// exported ingest entry point in the tree:
//
//   * `indexDirectory`, `loadScip` and `runScip` are no longer re-exported from
//     `src/extractor` / `src/scip`; this file imports them from their private
//     modules, and they require an IngestTicket only a session can mint.
//     NOT A CONSTRUCTION — see MetaCoding-qv0: `Store.upsertSymbol` and
//     `Store.addEdge` are public on the exported `src/store` barrel, take no
//     ticket and call no gate, so a module can still grow a sealed-looking
//     slice while its record reads the old numbers (measured: 12 -> 28 symbols
//     under a record reporting fitness 12). The ticket guards the layer above
//     the writes. Superseded by docs/design/graph-as-cache.md.
//   * every ingest therefore opens a session, which writes a RUNNING record on
//     entry and finalizes a verdict on exit.
//
// The CLI's remaining job is one line: map the persisted verdict to an exit
// code. THE EXIT CODE IS A VIEW OF THE FACT, NOT THE FACT.
//
// A process that DIES never reaches finalize, so the record says RUNNING
// forever and every reader sees it. MetaCoding-ae5 is closed BY CONSTRUCTION,
// not by detection. That is also why an unexpected throw out of a lane is NOT
// converted into a finalized REFUSED here: a session that did not complete has
// not established anything, and saying so is the honest record.
//
// Not the store's WRITE path: a write path that refuses partial writes cannot
// express deliberate partial indexing and would fight the incremental
// primitives. Fitness is a judgement about a COMPLETED SESSION.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { GraphBuild, type FlushStats, type GraphWriter } from "../store/build.ts";
import type { Store } from "../store";
import {
  IndexHealthStore,
  isFitnessEstablished,
  type IndexHealthRecord,
  type IndexIdentity,
  type LaneRecord,
} from "../store/health.ts";
import { indexDirectory, type WalkStats } from "../extractor/walker.ts";
import { watch as watchTree, type WatchHandle, type WatchOpts } from "../extractor/watcher.ts";
import { loadScip } from "../scip/loader.ts";
import { runScip, type ScipLanguage } from "../scip/run.ts";
import {
  DEFAULT_MIN_COVERAGE,
  censusSourceFiles,
  evaluateIndexOutcome,
  hashIndexFile,
  measureCorrespondence,
  measureGraphFreshness,
  measureRunContribution,
  measureStoreFitness,
  formatGateFailure,
  type GateResult,
} from "./fitness.ts";
import { issueIngestTicket, revokeIngestTicket, type IngestTicket } from "./ticket.ts";

export { formatGateFailure, censusSourceFiles, DEFAULT_MIN_COVERAGE } from "./fitness.ts";

/** Everything a session needs to know about what it is being asked to do. */
export interface IndexIntent {
  repo: string;
  branch: string;
  targetPath: string;
  /** The commit this run claims to index. */
  commitSha: string | null;
  /**
   * The RUN STAMP: one constant per session, written to `Symbol.indexed_at` by
   * every lane. This is what makes per-run attribution possible with no schema
   * change and no migration.
   */
  runStamp: string;
  perCommitIdentity?: boolean;
  /** Run the in-process SCIP indexers. */
  wantScip: boolean;
  /** Ingest a PRE-BUILT external `.scip` instead of running an indexer. */
  loadScipPath?: string;
  scipLanguage?: ScipLanguage;
  phpPsr4Map?: Record<string, string>;
  /** Waive a refusal, recording it as OVERRIDDEN. */
  allowEmptyIndex?: boolean;
  /** Correspondence floor; below DEFAULT_MIN_COVERAGE this is itself an override. */
  minCoverage?: number;
  /** Operator flags supplied verbatim, recorded in the health record forever. */
  overrides?: { flag: string; value: string }[];
  /** SCIP languages to run; defaults to auto-detection over targetPath. */
  scipLanguages?: ScipLanguage[];
}

export interface IndexSessionResult {
  treeSitter: WalkStats;
  scip?: Record<string, unknown>;
  /** The FINALIZED persisted verdict. The exit code is derived from this. */
  health: IndexHealthRecord;
  gate: GateResult;
  /** What the single bulk write to the store actually did (src/store/build.ts). */
  flush: FlushStats;
}

/** Normalize a user-supplied scip-language token to the loader's code. */
export function normalizeScipLang(token: string): "ts" | "py" | "php" | "rs" {
  switch (token.toLowerCase()) {
    case "ts":
    case "typescript":
      return "ts";
    case "py":
    case "python":
      return "py";
    case "php":
      return "php";
    case "rs":
    case "rust":
      return "rs";
    default:
      throw new Error(
        `unknown --scip-language '${token}' (expected ts|typescript|py|python|php|rs|rust)`,
      );
  }
}

/**
 * The `--load-scip` step: ingest a PRE-BUILT external `.scip` (the out-of-band
 * Docker full-site scip-php build, bead MetaCoding-i00).
 *
 * INTERNAL to the session. It is exported only so src/cli/load-scip.test.ts can
 * pin this wiring against `loadScip` directly — the defect that test exists for
 * was the CLI path and the measurement harness DIVERGING. It is not an ingest
 * entry point: it requires an IngestTicket, which only a session mints.
 * That is a guard, not a construction — see MetaCoding-qv0.
 */
export async function ingestPrebuiltScip(
  store: GraphWriter,
  scipPath: string,
  opts: {
    /** The session's write capability — src/ingest/ticket.ts. */
    ticket: IngestTicket;
    repo: string;
    branch: string;
    scipLanguage?: ScipLanguage;
    phpPsr4Map?: Record<string, string>;
    commitSha?: string | null;
    runStamp?: string | null;
    perCommitIdentity?: boolean;
  },
): ReturnType<typeof loadScip> {
  if (!existsSync(scipPath)) {
    throw new Error(`--load-scip: index file not found: ${scipPath}`);
  }
  const language = normalizeScipLang(opts.scipLanguage ?? "php");
  return loadScip(store, scipPath, {
    ticket: opts.ticket,
    branch: opts.branch,
    repo: opts.repo,
    language,
    repo_commit_sha: opts.commitSha,
    indexed_at: opts.runStamp,
    perCommitIdentity: opts.perCommitIdentity,
    phpPsr4Map: language === "php" ? opts.phpPsr4Map : undefined,
  });
}

/** The commit of the last record whose fitness was actually ESTABLISHED. */
function previousEstablishedCommit(prev: IndexHealthRecord | null): string | null {
  if (!prev) return null;
  if (!isFitnessEstablished(prev.status)) return null;
  return prev.commit_sha ?? null;
}

/**
 * Run one index session against `store`, persisting a RUNNING record on entry
 * and a HEALTHY / REFUSED / OVERRIDDEN verdict on exit.
 *
 * Never throws for a REFUSED verdict — refusal is a fact in the record, and the
 * caller renders it. It DOES propagate an unexpected error out of a lane, and
 * in that case the record deliberately stays RUNNING.
 */
export async function runIndexSession(
  store: Store,
  dataDir: string,
  intent: IndexIntent,
): Promise<IndexSessionResult> {
  const health = IndexHealthStore.open(dataDir);
  const heartbeatMs = 5_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticket: IngestTicket | null = null;
  try {
    const prev = health.read(intent.repo, intent.branch);
    const prevCommitSha = previousEstablishedCommit(prev);

    // --- ON ENTRY: RUNNING. A process that dies never gets past here. --------
    let record: IndexHealthRecord = {
      repo: intent.repo,
      branch: intent.branch,
      status: "RUNNING",
      run_id: intent.runStamp,
      commit_sha: intent.commitSha,
      prev_commit_sha: prevCommitSha,
      // The previous run's ingested-index identities, carried forward so open
      // red #2's citation can actually be COMPARED (bead MetaCoding-19g). The
      // record already does exactly this for commits; this is the same shape.
      prev_index_identities: prev?.index_identities ?? [],
      started_at: new Date().toISOString(),
      finished_at: null,
      pid: process.pid,
      heartbeat_at: new Date().toISOString(),
      failures: [],
      lanes: [],
      contribution: null,
      fitness: null,
      correspondence: null,
      index_identities: [],
      // Not yet measured: the walk that loads the grammars has not run. Absent
      // means UNRECORDED, never "no toolchain" (bead MetaCoding-1j5).
      toolchain_digest: null,
      override: null,
    };
    health.write(record);
    timer = setInterval(() => {
      try {
        health.write({ ...record, heartbeat_at: new Date().toISOString() });
      } catch { /* the finalize path owns correctness; a missed beat is cosmetic */ }
    }, heartbeatMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    // The write capability. Minted AFTER the RUNNING record is persisted, and
    // revoked at finalize: for the whole window in which writes are possible,
    // the slice reads RUNNING, so no reader can mistake it for established.
    // Nothing in src/ can write to the graph without one (bead MetaCoding-9ed,
    // src/ingest/ticket.ts).
    ticket = issueIngestTicket({
      repo: intent.repo,
      branch: intent.branch,
      runStamp: intent.runStamp,
    });

    // --- THE LANES ----------------------------------------------------------
    //
    // Every lane writes into an in-memory BUILD, not into the store. The store
    // is touched exactly once, at the flush below, which replaces this slice
    // wholesale. That is what closes MetaCoding-9jt: a whole-tree index can no
    // longer skip a file (so cross-file candidates always resolve) and can no
    // longer DETACH DELETE one file's symbols out from under another file's
    // edges. It is also ~400x faster than the MERGE-per-row path it replaces.
    // See src/store/build.ts for the measurements.
    const build = new GraphBuild(dataDir, {
      repo: intent.repo,
      branch: intent.branch,
      commitSha: intent.commitSha,
      perCommitIdentity: intent.perCommitIdentity,
    });
    const lanes: LaneRecord[] = [];
    const identities: IndexIdentity[] = [];
    const walkOpts = {
      ticket,
      branch: intent.branch,
      repo: intent.repo,
      repo_commit_sha: intent.commitSha,
      indexed_at: intent.runStamp,
      perCommitIdentity: intent.perCommitIdentity,
    };

    const tsStats = await indexDirectory(build, intent.targetPath, walkOpts);
    lanes.push({ lane: "tree-sitter", ok: true, files: tsStats.filesScanned });
    let scipSummary: Record<string, unknown> | undefined;

    if (intent.loadScipPath) {
      if (!existsSync(intent.loadScipPath)) {
        throw new Error(`--load-scip: index file not found: ${intent.loadScipPath}`);
      }
      // Open red #2 (docs/design/index-fitness.md): re-ingesting yesterday's
      // .scip at a new commit re-stamps every symbol, so contribution reads
      // large while the graph holds yesterday's facts. Recording the file's
      // identity makes that visible to a reader. NOT closed by this.
      identities.push(await hashIndexFile(intent.loadScipPath));
      const stats = await ingestPrebuiltScip(build, intent.loadScipPath, { ...intent, ticket });
      lanes.push({ lane: "scip:load-scip", ok: true, files: stats.documents });
      scipSummary = { source: "load-scip", scipPath: intent.loadScipPath, ...stats };
    } else if (intent.wantScip) {
      const langs = intent.scipLanguages ?? detectScipLanguages(intent.targetPath);
      const accum = {
        documents: 0, symbolsUpserted: 0, edgesAdded: 0,
        externalRefsSkipped: 0, externalBoundaryEdges: 0, indexerDurationMs: 0,
      };
      for (const lang of langs) {
        try {
          const { scipPath, durationMs } = await runScip({
            language: lang,
            targetRepo: intent.targetPath,
            output: join(intent.targetPath, `index.${lang}.scip`),
            projectName: intent.repo,
            projectVersion: intent.branch,
          });
          identities.push(await hashIndexFile(scipPath));
          const stats = await loadScip(build, scipPath, {
            ticket,
            branch: intent.branch,
            repo: intent.repo,
            language: normalizeScipLang(lang),
            repo_commit_sha: intent.commitSha,
            indexed_at: intent.runStamp,
            perCommitIdentity: intent.perCommitIdentity,
          });
          accum.documents += stats.documents;
          accum.symbolsUpserted += stats.symbolsUpserted;
          accum.edgesAdded += stats.edgesAdded;
          accum.externalRefsSkipped += stats.externalRefsSkipped;
          accum.externalBoundaryEdges += stats.externalBoundaryEdges;
          accum.indexerDurationMs += durationMs;
          lanes.push({ lane: `scip:${lang}`, ok: true, files: stats.documents });
        } catch (e) {
          // NOT swallowed (MetaCoding-0sd): this catch used to print one stderr
          // line and let the run report success. We continue the loop so EVERY
          // lane's fate is reported, not just the first to die.
          const msg = (e as Error).message.slice(0, 400);
          console.error(`scip-${lang} failed: ${msg}`);
          lanes.push({ lane: `scip:${lang}`, ok: false, error: msg, files: 0 });
        }
      }
      scipSummary = accum;
    }

    // --- THE FLUSH: the one and only write to the store ----------------------
    // Ordered AFTER every lane so the SCIP lane's COALESCE-preserving merge onto
    // tree-sitter symbols happens in the buffer, exactly as it used to happen in
    // the graph. Ordered BEFORE the measurements because every measurement below
    // reads the store, and a measurement of a store the build has not landed in
    // would be measuring the previous run.
    const flush = await build.flush(store);
    if (flush.edgesDropped > 0) {
      // Reported, never thresholded. These edges were dropped by the old write
      // path too — it just never said so.
      console.error(
        `index: ${flush.edgesDropped} edge(s) dropped — endpoint symbol not in the built slice`,
      );
    }

    // --- THE MEASUREMENTS, each scoped to its claim's subject ----------------
    const scipRequested = Boolean(intent.wantScip || intent.loadScipPath);
    const source = censusSourceFiles(intent.targetPath);
    const contribution = await measureRunContribution(
      store, intent.repo, intent.branch, intent.runStamp,
    );
    const fitness = await measureStoreFitness(store, intent.repo, intent.branch);
    const correspondence = await measureCorrespondence(
      store, intent.repo, intent.branch, source,
    );
    // Does the graph still BE the tree? (bead MetaCoding-c03) The tree-sitter
    // lane skips files whose content hash is unchanged and therefore re-stamps
    // NOTHING on a commit that touched no indexed source file, so contribution
    // reads 0 on a graph that is correct and complete. Only this measurement can
    // tell that apart from a lane that silently stopped working.
    const freshness = await measureGraphFreshness(
      store, intent.repo, intent.branch, intent.targetPath,
    );

    const gateInput = {
      repo: intent.repo,
      targetPath: intent.targetPath,
      lanes,
      source,
      contribution,
      fitness,
      correspondence,
      freshness,
      scipRequested,
      commitSha: intent.commitSha,
      prevCommitSha,
    };
    const gate = evaluateIndexOutcome({ ...gateInput, minCoverage: intent.minCoverage });
    // Evaluated a SECOND time at the strict default so a lowered --min-coverage
    // cannot silently disable the floor: if the strict verdict differs, the
    // operator's flag CHANGED the answer and the record says OVERRIDDEN.
    const strict = evaluateIndexOutcome({ ...gateInput, minCoverage: DEFAULT_MIN_COVERAGE });

    // --- ON EXIT: FINALIZE --------------------------------------------------
    let status: IndexHealthRecord["status"];
    let override: IndexHealthRecord["override"] = null;
    if (!gate.ok && intent.allowEmptyIndex) {
      status = "OVERRIDDEN";
      override = { flag: "--allow-empty-index", value: "true" };
    } else if (!gate.ok) {
      status = "REFUSED";
    } else if (!strict.ok) {
      status = "OVERRIDDEN";
      override = { flag: "--min-coverage", value: String(intent.minCoverage) };
    } else {
      status = "HEALTHY";
    }

    record = {
      ...record,
      status,
      finished_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      failures: (status === "OVERRIDDEN" && gate.ok ? strict : gate).failures.map((f) => ({
        code: f.code, message: f.message,
      })),
      lanes,
      contribution,
      fitness,
      correspondence,
      freshness,
      index_identities: identities,
      // THE TREE-SITTER LANE'S IDENTITY, PERSISTED (bead MetaCoding-1j5).
      //
      // The walker has computed this on every whole-tree build since 9880f18
      // and it went to stdout and nowhere else, while `index_identities` — the
      // channel built to record exactly this for the SCIP lane, already read
      // back from the store by fitness.test.ts — sat beside it holding none of
      // it. A digest that is printed is not an input a reader can recompute
      // from; it is the same distance from the artifact as no digest at all.
      //
      // Taken from the walk's own return value rather than re-read from the
      // registry here: this must be the toolchain THAT BUILD parsed with, and
      // the registry at finalize time is a different moment.
      toolchain_digest: tsStats.toolchain_digest,
      override,
    };
    if (timer) { clearInterval(timer); timer = null; }
    // Revoke BEFORE the verdict is persisted: a reference to this ticket kept
    // past the end of the session must not be able to grow the store the record
    // is about. After this line the ticket fails `assertMayIngest`.
    revokeIngestTicket(ticket);
    ticket = null;
    health.write(record);

    return { treeSitter: tsStats, scip: scipSummary, health: record, gate, flush };
  } finally {
    if (timer) clearInterval(timer);
    // A lane that threw leaves the record RUNNING (deliberately) — but it must
    // not leave a live write capability behind.
    if (ticket) revokeIngestTicket(ticket);
    health.close();
  }
}

/**
 * `metacoding watch`, which is an INDEX SESSION followed by an incremental
 * watcher — not a separate ingest path.
 *
 * The initial full pass runs inside `runIndexSession`, so watch produces
 * exactly the same refusal as `metacoding index` over the same tree. That is
 * the point of putting the seam here rather than in `cmdIndex`.
 *
 * The record is finalized before the watcher starts (rather than held RUNNING
 * for the watcher's whole lifetime) because a marker that reads "unestablished"
 * for hours while a healthy graph serves queries is a marker users learn to
 * ignore. `watching: true` and the owning pid are recorded instead, so a reader
 * can see that incremental writes are ongoing. Named, not hidden: incremental
 * per-file updates after the initial pass are not re-gated.
 */
export async function runWatchSession(
  store: Store,
  dataDir: string,
  intent: IndexIntent,
  watchOpts: Omit<WatchOpts, "ticket" | "repo" | "branch" | "indexed_at" | "repo_commit_sha">,
): Promise<{ session: IndexSessionResult; handle: WatchHandle | null }> {
  const session = await runIndexSession(store, dataDir, intent);
  if (!isFitnessEstablished(session.health.status)) {
    // Refused: do NOT start watching. Starting an incremental watcher over a
    // graph whose fitness was refused would keep mutating a store every reader
    // must refuse anyway.
    return { session, handle: null };
  }
  const health = IndexHealthStore.open(dataDir);
  try {
    health.write({ ...session.health, watching: true, pid: process.pid });
  } finally {
    health.close();
  }
  // A WATCH-MODE capability. The session's own ticket was revoked at finalize;
  // this one is admitted against the now-established record only because that
  // record carries `watching: true` with the SAME run id (src/ingest/ticket.ts).
  // The design names incremental writes as not re-judged — this makes the state
  // that licenses them a persisted, readable fact rather than an assumption.
  const watchTicket = issueIngestTicket({
    repo: intent.repo,
    branch: intent.branch,
    runStamp: intent.runStamp,
    mode: "watch",
  });
  const handle = await watchTree(store, intent.targetPath, {
    ...watchOpts,
    ticket: watchTicket,
    branch: intent.branch,
    repo: intent.repo,
    repo_commit_sha: intent.commitSha,
    indexed_at: intent.runStamp,
    perCommitIdentity: intent.perCommitIdentity,
    skipInitialIndex: true, // the session above already did the full pass
  });
  return { session, handle };
}

/** Clear the `watching` marker when a watcher shuts down cleanly. */
export function clearWatchMarker(dataDir: string, repo: string, branch: string): void {
  const health = IndexHealthStore.open(dataDir);
  try {
    const rec = health.read(repo, branch);
    if (rec) health.write({ ...rec, watching: false });
  } catch { /* shutdown path — never throw */ } finally {
    health.close();
  }
}

/** Which in-process SCIP indexers to run for a tree. */
export function detectScipLanguages(repoPath: string): ScipLanguage[] {
  const langs: ScipLanguage[] = [];
  if (hasFileExt(repoPath, /\.(ts|tsx|mts|cts)$/, 6) ||
      existsSync(join(repoPath, "tsconfig.json")) ||
      existsSync(join(repoPath, "package.json"))) {
    langs.push("typescript");
  }
  if (hasFileExt(repoPath, /\.py$/, 6) ||
      existsSync(join(repoPath, "pyproject.toml")) ||
      existsSync(join(repoPath, "setup.py"))) {
    langs.push("python");
  }
  // rust-analyzer needs a Cargo project to load, so a stray .rs file is not
  // enough — the target must be (the root of) a crate or workspace.
  if (existsSync(join(repoPath, "Cargo.toml"))) {
    langs.push("rust");
  }
  return langs;
}

function hasFileExt(dir: string, pattern: RegExp, maxDepth: number): boolean {
  if (maxDepth <= 0) return false;
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const p = join(dir, entry);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isFile() && pattern.test(entry)) return true;
      if (st.isDirectory() && hasFileExt(p, pattern, maxDepth - 1)) return true;
    }
  } catch { /* permission/race */ }
  return false;
}
