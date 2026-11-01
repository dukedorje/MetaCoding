// F3.2, F3.3, F3.4 — and the live check that puts this mechanism on `bun test`.
//
// docs/design/lessons-as-mechanism.md:163-165. F3.2 is the one the design
// document calls "the single most important fixture in the document", because
// the failure it catches is invisible: the check runs, reports OK, and is
// measuring itself.
//
//   > "If identity.ts reads package.json versions instead of hashing the loaded
//   >  artifact, it is a declaration validating itself and it will pass forever."
//
// So F3.2 below does the real thing: it builds an install root out of a COPY of
// the real .wasm blob, mutates the BLOB, leaves package.json BYTE-IDENTICAL,
// and asserts the outcome moves. The assertion that package.json did not change
// is part of the fixture, not decoration — without it the pair proves only that
// something changed, and "something" is what a version comparison also sees.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discriminate } from "../testkit/discriminate.ts";
import {
  type ArtifactIdentity,
  digestBytes,
  grammarLane,
  loadedArtifacts,
  repoRoot,
  resetLoadedArtifacts,
  wasmDirFrom,
} from "./identity.ts";
import {
  type LaneOutcome,
  type Lockfile,
  LOCK_VERSION,
  PreflightRefused,
  SUPPORTED_LOCK_VERSIONS,
  assertCoverage,
  assertToolchain,
  coverageGaps,
  observeToolchain,
  readLockfile,
  relock,
} from "./preflight.ts";

const ROOT = repoRoot();
const REAL_LOCK = join(ROOT, "toolchain.lock.json");
const REAL_PHP_WASM = join(wasmDirFrom(ROOT), "tree-sitter-php.wasm");
const PHP_REL = "node_modules/tree-sitter-wasms/out/tree-sitter-php.wasm";

let sandbox: string;
let sandboxLock: string;
let manifestPath: string;
let sandboxWasm: string;

beforeAll(() => {
  // A whole-repo copy is not needed and the volume is nearly full: copy exactly
  // the two files this fixture mutates and reads.
  sandbox = mkdtempSync(join(tmpdir(), "toolchain-f32-"));
  mkdirSync(join(sandbox, "node_modules", "tree-sitter-wasms", "out"), { recursive: true });
  sandboxWasm = join(sandbox, PHP_REL);
  copyFileSync(REAL_PHP_WASM, sandboxWasm);
  manifestPath = join(sandbox, "node_modules", "tree-sitter-wasms", "package.json");
  writeFileSync(manifestPath, JSON.stringify({ name: "tree-sitter-wasms", version: "0.1.13" }));

  const declared = digestBytes(readFileSync(REAL_PHP_WASM));
  const lock: Lockfile = {
    version: 1,
    lanes: { "tree-sitter:php": { kind: "file", source: PHP_REL, digest: declared } },
  };
  sandboxLock = join(sandbox, "toolchain.lock.json");
  writeFileSync(sandboxLock, JSON.stringify(lock));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function phpOutcome(root: string, lockPath: string): LaneOutcome {
  const r = observeToolchain({ root, lockPath, inspectDocker: () => null });
  return r.lanes.find((l) => l.lane === "tree-sitter:php")!.outcome;
}

describe("F3.2 — the digest comes from the ARTIFACT, not the declaration", () => {
  test("mutating the .wasm bytes with package.json untouched moves the outcome", async () => {
    const manifestBefore = readFileSync(manifestPath);

    await discriminate<"pristine" | "mutated">({
      name: "a grammar blob edited in place is seen, though its manifest never moved",
      verdict: (state) => {
        if (state === "pristine") copyFileSync(REAL_PHP_WASM, sandboxWasm);
        else {
          // A grammar upgrade, in the only form that matters to a parse: the
          // bytes the loader will read are different ones.
          const bytes = readFileSync(REAL_PHP_WASM);
          bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
          writeFileSync(sandboxWasm, bytes);
        }
        return phpOutcome(sandbox, sandboxLock);
      },
      cases: { OK: "pristine", DRIFT: "mutated" },
    });

    // THE HALF THAT MAKES THIS FIXTURE DISCRIMINATE. A version comparison would
    // have reported OK across both cases, because this file never changed.
    expect(readFileSync(manifestPath)).toEqual(manifestBefore);
    expect(JSON.parse(manifestBefore.toString()).version).toBe("0.1.13");
  });

  test("MISSING: the declared artifact is not on disk — a failure, not a skip", () => {
    rmSync(sandboxWasm);
    expect(phpOutcome(sandbox, sandboxLock)).toBe("MISSING");
    expect(observeToolchain({ root: sandbox, lockPath: sandboxLock }).ok).toBe(false);
    copyFileSync(REAL_PHP_WASM, sandboxWasm); // restore for the OK contrast below
    expect(phpOutcome(sandbox, sandboxLock)).toBe("OK");
  });
});

describe("F3.3 — a lock that checks nothing is a FAILURE, never a pass", () => {
  const cases: Array<[string, string, string]> = [
    ["LOCK_EMPTY", "empty.json", JSON.stringify({ version: 1, lanes: {} })],
    ["LOCK_UNPARSEABLE", "bad.json", "{not json"],
    ["LOCK_MALFORMED", "nolanes.json", JSON.stringify({ version: 1 })],
    [
      "LOCK_MALFORMED",
      "unknownkind.json",
      JSON.stringify({ version: 1, lanes: { x: { kind: "wasm", source: "s", digest: null, why: "w" } } }),
    ],
    [
      "LOCK_MALFORMED",
      "silentunpinned.json",
      JSON.stringify({ version: 1, lanes: { x: { kind: "file", source: "s", digest: null } } }),
    ],
    [
      "LOCK_MALFORMED",
      "placeholder.json",
      JSON.stringify({ version: 1, lanes: { x: { kind: "file", source: "s", digest: "TODO" } } }),
    ],
  ];

  for (const [kind, name, body] of cases) {
    test(`${name} -> ${kind}`, () => {
      const p = join(sandbox, name);
      writeFileSync(p, body);
      try {
        readLockfile(p);
        throw new Error(`expected ${kind}, got a parsed lockfile`);
      } catch (e) {
        expect(e).toBeInstanceOf(PreflightRefused);
        expect((e as PreflightRefused).kind).toBe(kind as never);
      }
    });
  }

  test("LOCK_UNREADABLE: an absent lock is a refusal, not an empty clean run", () => {
    expect(() => readLockfile(join(sandbox, "nope.json"))).toThrow(PreflightRefused);
  });

  test("CONTRAST: the real committed lock parses and declares its lanes", () => {
    const lock = readLockfile(REAL_LOCK);
    expect(Object.keys(lock.lanes).length).toBeGreaterThanOrEqual(8);
  });

  // MUTATION N22's fix. `version` was read with `Number(lock.version ?? 0)` and
  // DISCARDED, and the exported LOCK_VERSION had no consumer — so a v2 lock read
  // by a v1 checker was silently accepted and reported clean. A checker that
  // evaluates a format it does not know is guessing, and this file's whole
  // thesis is that a guess must never be spelled OK.
  test("LOCK_VERSION_UNSUPPORTED: a version this checker cannot read is REFUSED", () => {
    const lane = { kind: "file", source: PHP_REL, digest: "sha256:" + "a".repeat(64) };
    const refused: Record<string, unknown> = {
      future_v2: 2,
      far_future: 99,
      zero: 0,
      absent: undefined,
      null_version: null,
      string_one: "1",
      float: 1.5,
    };
    for (const [why, version] of Object.entries(refused)) {
      const p = join(sandbox, `ver-${why}.json`);
      writeFileSync(p, JSON.stringify({ version, lanes: { "tree-sitter:php": lane } }));
      let kind = "ACCEPTED";
      try {
        readLockfile(p);
      } catch (e) {
        kind = (e as PreflightRefused).kind;
      }
      expect(`${why}:${kind}`).toBe(`${why}:LOCK_VERSION_UNSUPPORTED`);
    }
    // CONTRAST, identical in every other byte: version 1 parses.
    const ok = join(sandbox, "ver-one.json");
    writeFileSync(ok, JSON.stringify({ version: 1, lanes: { "tree-sitter:php": lane } }));
    expect(readLockfile(ok).version).toBe(1);
    // and the constant is the thing that decides, not a literal somewhere else
    expect(SUPPORTED_LOCK_VERSIONS).toContain(LOCK_VERSION);
    expect(readLockfile(REAL_LOCK).version).toBe(LOCK_VERSION);
  });
});

// ---------------------------------------------------------------------------
// COVERAGE — bead MetaCoding-7sv. Everything above asks "is what I declared
// still installed". Nothing asked "did I declare what I used", and those are
// different questions.
// ---------------------------------------------------------------------------
describe("the lock must COVER what the process actually loaded", () => {
  test("UNDECLARED: a lane this process loaded and the lock does not name", () => {
    const lock = readLockfile(REAL_LOCK);
    const invented: ArtifactIdentity = {
      lane: grammarLane("ruby"), // the fifth grammar, as it would arrive
      kind: "file",
      source: "out/tree-sitter-ruby.wasm",
      digest: digestBytes("ruby"),
    };
    const gaps = coverageGaps(lock, [invented]);
    expect(gaps.map((g) => g.outcome)).toEqual(["UNDECLARED"]);
    expect(() => assertCoverage(lock, [invented])).toThrow(PreflightRefused);
  });

  test("DRIFT: a lane the lock names, loaded with DIFFERENT bytes", () => {
    // This is the path/require.resolve divergence made concrete: the lock is
    // measured from <root>/node_modules by path, the loader resolves its own.
    const lock = readLockfile(REAL_LOCK);
    const wrong: ArtifactIdentity = {
      lane: grammarLane("php"),
      kind: "file",
      source: "/somewhere/else/tree-sitter-php.wasm",
      digest: digestBytes("not the php grammar"),
    };
    expect(coverageGaps(lock, [wrong]).map((g) => g.outcome)).toEqual(["DRIFT"]);
    expect(() => assertCoverage(lock, [wrong])).toThrow(/DRIFT/);
  });

  test("REFUSAL: coverage asserted over ZERO artifacts is not a pass", () => {
    // The parse-zero shape, one level over. A coverage check with nothing to
    // cover is green forever and measures nothing.
    expect(() => assertCoverage(readLockfile(REAL_LOCK), [])).toThrow(PreflightRefused);
    try {
      assertCoverage(readLockfile(REAL_LOCK), []);
    } catch (e) {
      expect((e as PreflightRefused).kind).toBe("LOCK_EMPTY");
    }
  });

  test("CONTRAST, AND THE LIVE ONE: every grammar the walker declares loads to a lane the lock covers", async () => {
    const { makeParser } = await import("../extractor/parser.ts");
    const { GRAMMARS } = await import("../extractor/walker.ts");
    resetLoadedArtifacts();
    for (const g of GRAMMARS) await makeParser(g);

    // Not a hardcoded list of four: GRAMMARS is what `Grammar` is DERIVED from,
    // so a fifth grammar added to walker.ts arrives here automatically and, if
    // it is not in toolchain.lock.json, turns this red. That is 7sv's "a fifth
    // grammar would be silently undeclared".
    const measured = loadedArtifacts();
    expect(measured.map((a) => a.lane).sort()).toEqual(GRAMMARS.map(grammarLane).sort());

    // The load-bearing assertion: the digest of the blob the LOADER consumed
    // (resolved via require.resolve) equals the digest the LOCK declares
    // (measured by path from the install root). Nothing compared these before.
    const cov = assertCoverage(readLockfile(REAL_LOCK), measured);
    expect(cov.map((c) => c.outcome)).toEqual(GRAMMARS.map(() => "OK"));
    expect(cov.length).toBe(GRAMMARS.length);
    resetLoadedArtifacts();
  });

  // GRAMMARS is a DECLARATION, and a check derived from a declaration cannot
  // notice the declaration being wrong — the fixture above would stay green if
  // GRAMMARS lost a member, because it would then load, cover and assert three.
  // This ties the list to the RUNTIME DETECTOR: detectGrammar is what actually
  // decides which grammar parses a file, so anything it can return must be in
  // the list, and everything in the list must be reachable from it.
  test("GRAMMARS is what detectGrammar can actually return — both directions", async () => {
    const { GRAMMARS, detectGrammar } = await import("../extractor/walker.ts");
    const probes = [
      "a.ts", "a.tsx", "a.py", "a.php", "a.phtml", "a.inc",
      "a.module", "a.install", "a.theme", "a.profile", "a.engine",
      "a.js", "a.mjs", "a.cjs", "a.rs", "a.kt", "a.kts", "a.swift",
      "a.d.ts", "a.go", "README.md",
    ];
    const reachable = new Set<string>();
    for (const p of probes) {
      const g = detectGrammar(p);
      if (g !== null) {
        // FORWARD: nothing the detector routes to may be absent from the list,
        // or it parses facts into the graph with no lock lane behind it.
        expect(`${p}->${g}:${GRAMMARS.includes(g) ? "DECLARED" : "UNDECLARED"}`).toBe(
          `${p}->${g}:DECLARED`,
        );
        reachable.add(g);
      }
    }
    // BACKWARD: nothing in the list may be unreachable — a phantom member would
    // inflate the floor and demand a lock lane for a grammar nobody parses with.
    expect([...reachable].sort()).toEqual([...GRAMMARS].sort());
    // and the probe set is not vacuous: some of it must NOT match.
    expect(detectGrammar("a.go")).toBeNull();
    expect(detectGrammar("a.rs")).toBe("rust");
    expect(detectGrammar("a.d.ts")).toBeNull();
  });
});

describe("the lock's COVERAGE of what the design document names", () => {
  // lessons-as-mechanism.md:149-152 names three caret-ranged dependencies with
  // exactly this problem. None was a lane; the document said so and the lock
  // did not answer. Naming them in a design paragraph is not declaring them.
  test("the three caret deps the design names are declared lanes with digests", () => {
    const lock = readLockfile(REAL_LOCK);
    for (const name of ["intelephense", "typescript-language-server", "@ladybugdb/core"]) {
      const decl = lock.lanes[`npm:${name}`];
      expect(`${name}:${decl === undefined ? "UNDECLARED" : decl.kind}`).toBe(`${name}:package`);
      expect(`${name}:${decl!.digest === null ? "UNPINNED" : "PINNED"}`).toBe(`${name}:PINNED`);
    }
  });

  test("tree-sitter-wasms is pinned EXACTLY in package.json, not by a caret", () => {
    // The other half of 0bm's acceptance criterion, and the one a `bun install`
    // could quietly undo. A range here is what made the grammar mobile.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const range =
      pkg.dependencies?.["tree-sitter-wasms"] ?? pkg.devDependencies?.["tree-sitter-wasms"];
    expect(range).toBeDefined();
    expect(`tree-sitter-wasms:${/^\d+\.\d+\.\d+$/.test(range!) ? "EXACT" : range}`).toBe(
      "tree-sitter-wasms:EXACT",
    );
  });

  test("the docker lane declares the image that would actually RUN", async () => {
    // 7sv: the lock hardcoded "davidrjenni/scip-php:latest" while src/scip/run.ts
    // reads METACODING_SCIP_PHP_IMAGE, so the declared source need not be the
    // image that runs. If that env var is set to something else, THIS GOES RED —
    // which is the correct answer, not a nuisance: the toolchain that ran is not
    // the toolchain that was declared.
    const { SCIP_PHP_IMAGE } = await import("../scip/run.ts");
    const lock = readLockfile(REAL_LOCK);
    const dockerLanes = Object.values(lock.lanes).filter((l) => l.kind === "docker");
    expect(dockerLanes.length).toBeGreaterThan(0);
    expect(dockerLanes.map((l) => l.source)).toContain(SCIP_PHP_IMAGE);
  });
});

describe("F3.4 — three outcomes from one docker code path, three distinct tags", () => {
  const image = "davidrjenni/scip-php:latest";
  const declared = "sha256:" + "d".repeat(64);
  const drifted = "sha256:" + "e".repeat(64);

  function lockWith(digest: string | null): string {
    const p = join(sandbox, `docker-${digest === null ? "unpinned" : digest.slice(7, 13)}.json`);
    const lane =
      digest === null
        ? { kind: "docker" as const, source: image, digest: null, why: "not pulled here" }
        : { kind: "docker" as const, source: image, digest };
    writeFileSync(p, JSON.stringify({ version: 1, lanes: { "docker:scip-php": lane } }));
    return p;
  }

  const pinned = () => lockWith(declared);

  test("unavailable / drifted / matching are three named outcomes", async () => {
    await discriminate<{ lock: string; inspect: () => string | null }>({
      name: "docker lane: no answer is not no drift",
      verdict: ({ lock, inspect }) =>
        observeToolchain({ root: sandbox, lockPath: lock, inspectDocker: inspect })
          .lanes[0]!.outcome,
      cases: {
        SKIP_UNAVAILABLE: { lock: pinned(), inspect: () => null },
        DRIFT: { lock: pinned(), inspect: () => drifted },
        OK: { lock: pinned(), inspect: () => declared },
        UNPINNED: { lock: lockWith(null), inspect: () => declared },
      },
    });
  });

  test("a skip exits 0 by default and FAILS under --require-lanes", () => {
    const base = { root: sandbox, lockPath: pinned(), inspectDocker: () => null };
    expect(observeToolchain(base).ok).toBe(true);
    expect(observeToolchain({ ...base, requireLanes: true }).ok).toBe(false);
    // The skip is LOUD in both: the lane is named either way.
    expect(observeToolchain(base).lanes[0]!.detail).toContain(image);
  });

  test("an UNPINNED lane also exits 0 by default and FAILS under --require-lanes", () => {
    const base = { root: sandbox, lockPath: lockWith(null), inspectDocker: () => declared };
    expect(observeToolchain(base).ok).toBe(true);
    expect(observeToolchain({ ...base, requireLanes: true }).ok).toBe(false);
  });

  test("CONTRAST: drift fails whether or not --require-lanes is set", () => {
    const base = { root: sandbox, lockPath: pinned(), inspectDocker: () => drifted };
    expect(observeToolchain(base).ok).toBe(false);
    expect(observeToolchain({ ...base, requireLanes: true }).ok).toBe(false);
  });

  test("relock does NOT unpin a lane just because the daemon is down", () => {
    const next = relock({ root: sandbox, lockPath: pinned(), inspectDocker: () => null });
    expect(next.lanes["docker:scip-php"]!.digest).toBe(declared);
  });
});

describe("the live check — this is what puts the mechanism on `bun test`", () => {
  test("the installed toolchain matches the committed toolchain.lock.json", () => {
    // If `bun install` resolves a different grammar, THIS goes red. That is the
    // whole point of bead 0bm: before it, the same event was silent and every
    // sealed entry stayed a cache hit.
    const r = assertToolchain({ root: ROOT, lockPath: REAL_LOCK });
    expect(r.counts.DRIFT).toBe(0);
    expect(r.counts.MISSING).toBe(0);
    // Every grammar the walker loads is declared AND matching.
    for (const g of ["typescript", "tsx", "javascript", "python", "php", "rust", "kotlin", "swift"]) {
      const lane = r.lanes.find((l) => l.lane === `tree-sitter:${g}`);
      expect(lane?.outcome).toBe("OK");
    }
  });

  test("what is NOT checked here is named, not implied", () => {
    const r = observeToolchain({ root: ROOT, lockPath: REAL_LOCK });
    const loud = r.lanes.filter(
      (l) => l.outcome === "UNPINNED" || l.outcome === "SKIP_UNAVAILABLE",
    );
    // This assertion is deliberately about the SHAPE, not the count: on a
    // machine that has pulled scip-php it is 0, here it is 1. What must hold
    // everywhere is that an unchecked lane carries a reason a reader can act on.
    for (const l of loud) expect(l.detail.length).toBeGreaterThan(20);
  });
});
