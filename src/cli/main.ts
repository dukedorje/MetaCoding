#!/usr/bin/env bun
// CLI entry point. Not the bin shim — see src/cli/bin.ts. Invoking this
// file directly works in dev (where a local node_modules has the native
// binary already linked) but bypasses the global-install fixup.
//
//   metacoding index <path> [--data-dir <dir>] [--branch <name>]
//   metacoding serve [--data-dir <dir>]
//   metacoding query <cypher> [--data-dir <dir>]

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { Store } from "../store";
import { serveMcp } from "../mcp/server";
import { resolveScipBin, type ScipLanguage } from "../scip";
import { currentGitBranch } from "./branch";
import { resolveDataDir } from "./data-dir";
import { runExport } from "./export";
import { gatherIndexState, formatIndexState } from "../index-state";
import { runDoctor } from "./doctor";
import {
  clearWatchMarker,
  formatGateFailure,
  normalizeScipLang,
  runIndexSession,
  runWatchSession,
  DEFAULT_MIN_COVERAGE,
  type IndexIntent,
  type IndexSessionResult,
} from "../ingest/session.ts";
import { isFitnessEstablished } from "../store/health.ts";

export { normalizeScipLang };

/**
 * Run `git rev-parse HEAD` against `repoPath`.
 * Returns the 40-char SHA on success, or null if the directory is not a git
 * repo, has no commits yet, or git is unavailable. Never throws.
 */
async function getRepoCommitSha(repoPath: string): Promise<string | null> {
  try {
    const result = await Bun.$`git -C ${repoPath} rev-parse HEAD`.quiet();
    return result.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

interface ParsedArgs {
  cmd: string;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const cmd = argv[0] ?? "";
  const rest = argv.slice(1);
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok.startsWith("--")) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[tok.slice(2)] = next;
        i++;
      } else {
        flags[tok.slice(2)] = "true";
      }
    } else {
      positional.push(tok);
    }
  }
  return { cmd, positional, flags };
}

function usage(): never {
  console.error(`metacoding 0.1.4 — local-first code-graph DB

Usage:
  metacoding index <path>      [--data-dir <dir>] [--repo <name>] [--branch <name>] [--scip] [--per-commit-identity]
                               [--load-scip <index.scip> [--scip-language ts|py|php|rs] [--scip-psr4 <sidecar.json>]]
                               [--allow-empty-index] [--min-coverage <0..1>]
  metacoding index-all <parent>[--data-dir <dir>] [--branch <name>] [--scip] [--per-commit-identity]
                               [--allow-empty-index] [--min-coverage <0..1>]
  metacoding watch <path>      [--data-dir <dir>] [--repo <name>] [--branch <name>] [--per-commit-identity]
                               [--scip] [--load-scip <index.scip>] [--allow-empty-index] [--min-coverage <0..1>]
  metacoding serve             [--data-dir <dir>] [--workspace <path>]
  metacoding status [path]     [--data-dir <dir>] [--workspace <path>] [--json]
  metacoding query <cypher>    [--data-dir <dir>]
  metacoding export <out-dir>  [--data-dir <dir>]
  metacoding doctor
  metacoding install-skill     [--dir <skills-root>]

Flags:
  --scip [true|false]
                Force SCIP indexers on or off. Default: auto-detect. SCIP
                delivers CALLS / REFERENCES / IMPLEMENTS edges (required for
                CTKR Phase 2+ categorical analysis); the tree-sitter lane
                alone cannot populate them. The indexers ship bundled with
                metacoding, so a normal install already has them. To override
                with your own (e.g. on PATH for other tools):
                  bun add -g @sourcegraph/scip-typescript @sourcegraph/scip-python
  --repo        repo identifier tagged onto every Symbol/edge/token
                (defaults to the basename of the indexed path).
  --workspace   workspace root the LSP attaches to (defaults to cwd).
  --per-commit-identity
                fold repo_commit_sha into Symbol.id so multiple commits
                coexist in one DB (default off; overwrite semantics).
                External SCIP refs are never sha-scoped.
  --allow-empty-index [true|false]
                waive the index fitness gate. By default a run whose graph is
                unusable — no lane read a file, no symbols in the store, no
                relational edges while SCIP was requested, no store-visible
                SCIP symbol from THIS run, zero contribution while claiming a
                NEW commit, or correspondence to the local tree below
                --min-coverage — is recorded as REFUSED and exits non-zero
                (docs/design/index-fitness.md). Passing this records the run as
                OVERRIDDEN, with the flag and value, in index-health.sqlite —
                where every reader sees it, forever. Takes no value or exactly
                true|false; anything else is an error rather than a guess.
  --min-coverage <0..1>
                minimum share of the repo's source files that must correspond
                to a file in the graph (default 0.1). Correspondence is a set
                intersection over Symbol.file, measured at the first of four
                granularities that intersects at all: exact path, path suffix
                (survives a container prefix), basename, else UNMEASURABLE —
                and the granularity used is part of the record. A value below
                the default is itself an override: the run is re-evaluated at
                the default and recorded as OVERRIDDEN if the floor was what
                changed the answer.

Defaults:
  --data-dir    ./.metacoding if it exists (legacy), else
                $XDG_DATA_HOME/metacoding/<repo-id>/ (default
                ~/.local/share/metacoding/<repo-id>/). repo-id is
                derived from remote.origin.url or the repo's
                git-common-dir so worktrees share one store.
  --repo        basename of the indexed path
  --branch      auto-detected from .git/HEAD (fallback "main")
  --workspace   .

index-all walks every direct subdirectory of <parent> and runs 'index'
for each, tagging --repo with the subdirectory's name.

watch runs the SAME gated index session as 'index' for its initial pass —
it refuses on the same terms and records the same verdict — then watches for
incremental changes. It does not start watching a graph the gate refused.

status reports whether the workspace is indexed, the symbol count and
per-repo breakdown, staleness relative to HEAD (indexed commit vs current
commit, dirty-file count), and the PERSISTED INDEX FITNESS per repo
(HEALTHY / OVERRIDDEN / REFUSED / RUNNING / UNKNOWN). A symbol count cannot
tell a finished run from a killed one; only the fitness record can. Use
--json for machine-readable output.`);
  process.exit(2);
}

/**
 * Build the session intent from CLI flags. Shared by `index`, `index-all` and
 * `watch` so all three inherit exactly the same gate — the seam is in the
 * session, not in any one command (docs/design/index-fitness.md).
 */
async function intentFromArgs(
  args: ParsedArgs,
  targetAbs: string,
  overrides: { repo?: string; branch?: string } = {},
): Promise<IndexIntent> {
  const branch = overrides.branch ?? args.flags["branch"] ?? currentGitBranch(targetAbs);
  const repo = overrides.repo ?? args.flags["repo"] ?? basename(targetAbs);
  // Pre-built external index ingest (out-of-band Docker full-site build). When
  // --load-scip is given we skip the in-process indexer, so we must NOT run
  // resolveScipWanted (which exits when no scip binary is on PATH).
  const loadScipPath = args.flags["load-scip"] ? resolve(args.flags["load-scip"]) : undefined;
  const phpPsr4Map =
    loadScipPath && args.flags["scip-psr4"]
      ? (JSON.parse(readFileSync(resolve(args.flags["scip-psr4"]), "utf-8")) as Record<string, string>)
      : undefined;
  const gateFlags = parseGateFlags(args);
  return {
    repo,
    branch,
    targetPath: targetAbs,
    commitSha: await getRepoCommitSha(targetAbs),
    runStamp: new Date().toISOString(),
    perCommitIdentity: args.flags["per-commit-identity"] === "true",
    wantScip: loadScipPath ? false : resolveScipWanted(args.flags["scip"]),
    loadScipPath,
    scipLanguage: loadScipPath
      ? ((args.flags["scip-language"] ?? "php") as ScipLanguage)
      : undefined,
    phpPsr4Map,
    allowEmptyIndex: gateFlags.allowEmptyIndex,
    minCoverage: gateFlags.minCoverage,
    overrides: gateFlags.overrides,
  };
}

/** Render a session result as the JSON summary, and map the VERDICT to stdout. */
function printSessionSummary(dataDir: string, r: IndexSessionResult): void {
  console.log(
    JSON.stringify(
      {
        dataDir,
        repo: r.health.repo,
        branch: r.health.branch,
        treeSitter: r.treeSitter,
        scip: r.scip,
        health: r.health,
      },
      null,
      2,
    ),
  );
}

async function cmdIndex(args: ParsedArgs): Promise<void> {
  const target = args.positional[0];
  if (!target) usage();
  const targetAbs = resolve(target);
  const dataDir = await resolveDataDir(targetAbs, args.flags["data-dir"]);
  const intent = await intentFromArgs(args, targetAbs);

  const store = await Store.open(dataDir);
  let result: IndexSessionResult;
  try {
    result = await runIndexSession(store, dataDir, intent);
  } finally {
    await store.close();
  }
  printSessionSummary(dataDir, result);

  // The CLI's whole remaining job: map the PERSISTED VERDICT to an exit code.
  // The exit code is a VIEW of the fact, not the fact — the fact is in
  // index-health.sqlite beside the graph, where every reader can see it.
  if (result.health.status === "REFUSED") {
    console.error(formatGateFailure(intent.repo, targetAbs, result.gate));
    process.exit(1);
  }
  if (result.health.status === "OVERRIDDEN") {
    console.error(
      `metacoding: index gate would have REFUSED '${intent.repo}' but ` +
        `${result.health.override?.flag}=${result.health.override?.value} was passed. ` +
        `Recorded as OVERRIDDEN in index-health.sqlite — every reader will see it:\n` +
        result.health.failures.map((f) => `  [${f.code}] ${f.message}`).join("\n"),
    );
  }
}

/**
 * `--allow-empty-index` / `--min-coverage <0..1>`, parsed STRICTLY.
 *
 * The judge measured two accident modes in the previous parser, and both are
 * closed here:
 *   * ANY value other than the literal "false" ENABLED --allow-empty-index, so
 *     `--allow-empty-index 0`, `no`, and `off` all turned the gate OFF. Now only
 *     an explicit true/false (or the bare flag) is accepted; anything else exits 2.
 *   * `--min-coverage 0` was accepted and SILENTLY disabled the floor. It is
 *     still accepted — an operator may genuinely want it — but it is recorded as
 *     an OVERRIDE, and the session evaluates the run a second time at the strict
 *     default so a lowered floor cannot pass as HEALTHY.
 */
function parseGateFlags(args: ParsedArgs): {
  allowEmptyIndex: boolean;
  minCoverage: number;
  overrides: { flag: string; value: string }[];
} {
  const overrides: { flag: string; value: string }[] = [];
  let allowEmptyIndex = false;
  if ("allow-empty-index" in args.flags) {
    const raw = args.flags["allow-empty-index"]!;
    if (raw === "true") allowEmptyIndex = true;
    else if (raw === "false") allowEmptyIndex = false;
    else {
      console.error(
        `metacoding: --allow-empty-index takes no value or exactly true|false ` +
          `(got '${raw}').\n` +
          `  Refusing to guess: a parser that treated every non-'false' value as ` +
          `TRUE turned the gate OFF for '--allow-empty-index 0', 'no' and 'off'.`,
      );
      process.exit(2);
    }
    if (allowEmptyIndex) overrides.push({ flag: "--allow-empty-index", value: "true" });
  }

  const raw = args.flags["min-coverage"];
  let minCoverage = DEFAULT_MIN_COVERAGE;
  if (raw !== undefined) {
    const v = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(v) || v < 0 || v > 1) {
      console.error(`metacoding: --min-coverage must be a number in [0,1] (got '${raw}')`);
      process.exit(2);
    }
    minCoverage = v;
    if (v < DEFAULT_MIN_COVERAGE) overrides.push({ flag: "--min-coverage", value: raw });
  }
  return { allowEmptyIndex, minCoverage, overrides };
}

async function cmdIndexAll(args: ParsedArgs): Promise<void> {
  const parent = args.positional[0];
  if (!parent) usage();
  const parentAbs = resolve(parent);
  const dataDir = await resolveDataDir(parentAbs, args.flags["data-dir"]);
  const branch = args.flags["branch"] ?? "main";

  if (!existsSync(parentAbs)) {
    console.error(`metacoding: ${parentAbs} does not exist`);
    process.exit(1);
  }

  const subdirs = readdirSync(parentAbs)
    .filter((n) => !n.startsWith(".") && n !== "node_modules")
    .map((n) => join(parentAbs, n))
    .filter((p) => {
      try { return statSync(p).isDirectory(); } catch { return false; }
    });

  const store = await Store.open(dataDir);
  const results: Record<string, unknown>[] = [];
  try {
    for (const subdir of subdirs) {
      const repo = basename(subdir);
      const subBranch = args.flags["branch"] ?? currentGitBranch(subdir) ?? branch;
      const t0 = performance.now();
      try {
        const intent = await intentFromArgs(args, subdir, { repo, branch: subBranch });
        const r = await runIndexSession(store, dataDir, intent);
        const established = isFitnessEstablished(r.health.status);
        results.push({
          repo,
          branch: subBranch,
          ok: established,
          status: r.health.status,
          durationMs: Math.round(performance.now() - t0),
          treeSitter: r.treeSitter,
          scip: r.scip,
          health: r.health,
        });
        console.error(
          established
            ? `[index-all] ${repo}: ${r.health.status} — ` +
              `${r.treeSitter.filesUpdated}/${r.treeSitter.filesScanned} files, ` +
              `${r.health.fitness?.symbols ?? 0} symbols in store, ` +
              `${Math.round(performance.now() - t0)}ms`
            : `[index-all] ${repo}: ${r.health.status}\n` +
              formatGateFailure(repo, subdir, r.gate),
        );
      } catch (e) {
        // An unexpected throw leaves the health record RUNNING on purpose: a
        // session that did not complete established nothing, and saying so is
        // the honest record (bead MetaCoding-ae5).
        results.push({
          repo,
          branch: subBranch,
          ok: false,
          status: "RUNNING",
          error: (e as Error).message,
        });
        console.error(`[index-all] ${repo}: FAILED — ${(e as Error).message.slice(0, 200)}`);
      }
    }
  } finally {
    await store.close();
  }
  console.log(JSON.stringify({ dataDir, repos: results }, null, 2));
  // A per-repo failure used to leave index-all exiting 0 — the same
  // "reports success over an empty result" shape as MetaCoding-0sd, one level up.
  const failed = results.filter((r) => r["ok"] === false).map((r) => r["repo"]);
  if (failed.length > 0) {
    console.error(`metacoding: index-all FAILED for ${failed.length} repo(s): ${failed.join(", ")}`);
    process.exit(1);
  }
}

function haveScipBinary(name: string): boolean {
  // Single source of truth shared with runScip: local repo dep, then
  // metacoding's bundled @sourcegraph/scip-* copy, then PATH. Using the
  // same resolver means --scip detection can't claim "missing" for a
  // binary runScip would actually have found (e.g. the bundled one in a
  // global `bun add -g @identikey/metacoding` install).
  return resolveScipBin(name) !== null;
}

function haveScipBinaries(): { typescript: boolean; python: boolean; rust: boolean; any: boolean } {
  const ts = haveScipBinary("scip-typescript");
  const py = haveScipBinary("scip-python");
  const rs = haveScipBinary("rust-analyzer");
  return { typescript: ts, python: py, rust: rs, any: ts || py || rs };
}

function resolveScipWanted(flag: string | undefined): boolean {
  const have = haveScipBinaries();
  if (flag === "false") return false;
  if (flag === "true") {
    if (!have.any) {
      console.error(
        "metacoding: --scip requested but neither scip-typescript nor " +
          "scip-python could be resolved (bundled copy, local dep, or PATH).\n" +
          "  They normally ship with metacoding; if missing, install via:\n" +
          "    bun add -g @sourcegraph/scip-typescript @sourcegraph/scip-python",
      );
      process.exit(1);
    }
    return true;
  }
  if (have.any) return true;
  console.error(
    "metacoding: SCIP indexers not detected — refusing to index.\n" +
      "  A tree-sitter-only index lacks the CALLS/REFERENCES/IMPLEMENTS edges\n" +
      "  that hom-profiles, role-equivalence, and CTKR Phase 2+ depend on —\n" +
      "  it is almost not worth building. They normally ship bundled with\n" +
      "  metacoding; if missing, install via:\n" +
      "    bun add -g @sourcegraph/scip-typescript @sourcegraph/scip-python\n" +
      "  To index anyway in degraded tree-sitter-only mode, pass --scip false.",
  );
  process.exit(1);
}

async function cmdStatus(args: ParsedArgs): Promise<void> {
  const workspace = resolve(args.flags["workspace"] ?? args.positional[0] ?? ".");
  const dataDir = await resolveDataDir(workspace, args.flags["data-dir"]);
  // Read-only: status must work while an index is running on the same store.
  const store = await Store.open(dataDir, { readOnly: true });
  try {
    const state = await gatherIndexState(store, workspace);
    if (args.flags["json"] === "true") {
      console.log(JSON.stringify(state, null, 2));
    } else {
      console.log(formatIndexState(state));
    }
  } finally {
    await store.close();
  }
}

async function cmdQuery(args: ParsedArgs): Promise<void> {
  const cypher = args.positional[0];
  if (!cypher) usage();
  const dataDir = await resolveDataDir(process.cwd(), args.flags["data-dir"]);

  // Read-only: a read query should never take the writer lock or block on a
  // running index, and a fresh open reflects the latest checkpoint.
  const store = await Store.open(dataDir, { readOnly: true });
  try {
    const rows = await store.query(cypher);
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await store.close();
  }
}

async function cmdWatch(args: ParsedArgs): Promise<void> {
  const target = args.positional[0];
  if (!target) usage();
  const root = resolve(target);
  const dataDir = await resolveDataDir(root, args.flags["data-dir"]);
  // `watch` INHERITS THE GATE. It used to call indexDirectory straight out of
  // the extractor barrel, so the whole fitness gate simply did not apply to it
  // (fresh-judge finding on MetaCoding-0sd). It now runs the same
  // runIndexSession as `index` and refuses on the same terms — not because this
  // caller was patched, but because the ingest primitives are no longer
  // reachable from here at all (docs/design/index-fitness.md).
  const intent = await intentFromArgs(args, root);
  // MetaCoding-cx6: Per-commit-identity watch — re-read HEAD before each
  // incremental event so every indexed file is stamped with the sha that was
  // actually current at processing time, not the sha frozen at watch-start.
  const perCommitIdentity = intent.perCommitIdentity === true;

  const store = await Store.open(dataDir);
  const { session, handle } = await runWatchSession(store, dataDir, intent, {
    ...(perCommitIdentity ? { refreshRepoCommitSha: () => getRepoCommitSha(root) } : {}),
    onProcessed: (event, path) => {
      const at = new Date().toISOString().slice(11, 19);
      console.log(`${at} ${event.padEnd(6)} ${path}`);
    },
  });

  if (handle === null) {
    // Same refusal as `metacoding index`, from the same measurement, recorded
    // in the same place. Watching a refused graph would keep mutating a store
    // every reader must refuse anyway.
    console.error(formatGateFailure(intent.repo, root, session.gate));
    await store.close();
    process.exit(1);
  }

  console.log(`watching ${root} on branch ${intent.branch}; data dir ${dataDir}`);
  console.log(`index fitness: ${session.health.status}`);
  console.log("press Ctrl-C to stop");

  const shutdown = async () => {
    try { await handle.close(); } catch {}
    try { clearWatchMarker(dataDir, intent.repo, intent.branch); } catch {}
    try { await store.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdServe(args: ParsedArgs): Promise<void> {
  const workspace = resolve(args.flags["workspace"] ?? ".");
  const dataDir = await resolveDataDir(workspace, args.flags["data-dir"]);
  await serveMcp({ dataDir, workspace });
}

async function cmdExport(args: ParsedArgs): Promise<void> {
  const outDir = args.positional[0];
  if (!outDir) usage();
  const dataDir = await resolveDataDir(process.cwd(), args.flags["data-dir"]);
  const r = await runExport({ dataDir, outDir });
  console.log(JSON.stringify(r, null, 2));
}

async function cmdInstallSkill(args: ParsedArgs): Promise<void> {
  // The /metacoding skill ships inside the package at
  // .claude/skills/metacoding/. import.meta.dir is .../src/cli, so the
  // package root is two levels up.
  const src = resolve(import.meta.dir, "../../.claude/skills/metacoding");
  if (!existsSync(join(src, "SKILL.md"))) {
    console.error(`metacoding: skill source not found at ${src}`);
    process.exit(1);
  }
  // Default target is the Claude Code personal skills dir; --dir lets you
  // target any harness's skills root (e.g. a Hermes category dir).
  const baseDir = args.flags["dir"] ?? join(homedir(), ".claude", "skills");
  const dest = join(baseDir, "metacoding");
  // If dest already resolves to src (e.g. a dev symlink into the repo), a
  // recursive copy onto itself would throw — treat it as already installed.
  if (existsSync(dest) && realpathSync(dest) === realpathSync(src)) {
    console.log(`metacoding: /metacoding skill already present at ${dest}`);
    return;
  }
  mkdirSync(baseDir, { recursive: true });
  // Copy (not symlink): when run via `bunx`, src lives in a cache dir that
  // may be pruned. A copy is self-contained; re-run install-skill to update.
  cpSync(src, dest, { recursive: true });
  console.log(`metacoding: installed /metacoding skill -> ${dest}`);
  console.log("Reload skills (restart the agent) to pick it up.");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.cmd) {
    case "doctor":
      return runDoctor(args);
    case "install-skill":
      return cmdInstallSkill(args);
    case "index":
      return cmdIndex(args);
    case "index-all":
      return cmdIndexAll(args);
    case "status":
      return cmdStatus(args);
    case "query":
      return cmdQuery(args);
    case "watch":
      return cmdWatch(args);
    case "serve":
      return cmdServe(args);
    case "export":
      return cmdExport(args);
    case "--help":
    case "-h":
    case "help":
    case "":
      usage();
    default:
      console.error(`unknown command: ${args.cmd}`);
      usage();
  }
}

const KEEP_ALIVE = new Set(["serve", "watch"]);

/** CLI entry. Called by bin.ts (after the ladybug fixup) and when main.ts is
 *  run directly (`bun src/cli/main.ts …`). NOT invoked on plain import, so the
 *  module's exported helpers (ingestPrebuiltScip, normalizeScipLang) can be
 *  unit-tested without spawning a command. */
export function run(): void {
  main()
    .then(() => {
      // Long-lived commands (serve, watch) own their own lifecycle.
      if (!KEEP_ALIVE.has(process.argv[2] ?? "")) process.exit(0);
    })
    .catch((err) => {
      console.error("metacoding:", err?.message ?? err);
      process.exit(1);
    });
}

// Auto-run only when this file is the process entry point (dev invocation).
// Via bin.ts the entry is bin.ts, so bin.ts calls run() explicitly after the
// ladybug fixup side-effect module has loaded.
if (import.meta.main) run();
