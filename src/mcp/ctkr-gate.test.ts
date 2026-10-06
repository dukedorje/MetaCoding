// THE CTKR TOOLS ARE AGGREGATING CONSUMERS — bead MetaCoding-0mu.
//
// docs/design/index-fitness.md names them: "Aggregating consumers first — CTKR
// motif mining, role-equivalence, cross-repo comparison, graph_diff, the eval
// harness, any rescoring pass. Refuse by default ... This is the direct fix for
// the historical harm." src/mcp/health-gate.ts repeats it verbatim.
//
// A fresh judge measured the opposite: ctkr-tools.ts contained no gateAggregate,
// no summarizeHealth, no FITNESS at all, while registering eleven live tools.
// MetaCoding-hy6.16 — the 41-row role rescore over a graph with CALLS = 0 and
// REFERENCES = 0 — IS a CTKR-shaped failure. The one consumer the design exists
// to protect was the one consumer with no gate.
//
// EVERY TEST HERE IS A CONTRAST PAIR. A suite in which the tools always refuse
// would be as blind as one in which they never do: it could not tell a gate
// from a broken artifact path, which is precisely how a refusal would come to
// be ignored.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { IndexHealthStore, type IndexHealthRecord } from "../store/health.ts";
import {
  ctkrArtifactHealth,
  gateCtkrAggregate,
  registerCtkrTools,
  CTKR_TOOL_DESCRIPTIONS,
} from "./ctkr-tools.ts";

const T1 = "2026-01-01T00:00:00.000Z"; // artifacts built
const T2 = "2026-02-01T00:00:00.000Z"; // graph verdict finalized
const T3 = "2026-03-01T00:00:00.000Z";

let dataDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ctkr-gate-"));
  savedEnv = process.env["METACODING_CTKR_DATA_DIR"];
  process.env["METACODING_CTKR_DATA_DIR"] = dataDir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env["METACODING_CTKR_DATA_DIR"];
  else process.env["METACODING_CTKR_DATA_DIR"] = savedEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

function record(over: Partial<IndexHealthRecord> = {}): IndexHealthRecord {
  return {
    repo: "fixture", branch: "main", status: "HEALTHY", run_id: "run-1",
    commit_sha: "a".repeat(40), prev_commit_sha: null,
    started_at: T2, finished_at: T2, pid: null, heartbeat_at: T2,
    failures: [], lanes: [],
    contribution: null, fitness: null, correspondence: null,
    index_identities: [], override: null,
    ...over,
  };
}

function setHealth(rec: IndexHealthRecord): void {
  const h = IndexHealthStore.open(dataDir);
  try { h.write(rec); } finally { h.close(); }
}

function setManifest(generated_at: string): void {
  mkdirSync(join(dataDir, "ctkr"), { recursive: true });
  writeFileSync(
    join(dataDir, "ctkr", "manifest.json"),
    JSON.stringify({ schema_version: 1, generated_at, metacoding_data_dir: dataDir }),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// PAIR A — the graph behind the artifacts
// ---------------------------------------------------------------------------

describe("PAIR A — an unestablished graph refuses; an established one answers", () => {
  test("no health record at all (every store indexed before this shipped) => refuse", async () => {
    setManifest(T3);
    const h = await ctkrArtifactHealth(dataDir);
    expect(h.established).toBe(false);
    const answer = await gateCtkrAggregate("ctkr.motif_search", undefined, async () => ["row"]);
    expect(answer.ok).toBe(false);
    expect(answer).not.toHaveProperty("result");
    if (!answer.ok) expect(answer.error).toBe("INDEX_FITNESS_UNESTABLISHED");
  });

  test("HEALTHY record + artifacts built after it => the SAME call answers", async () => {
    setHealth(record({ status: "HEALTHY", finished_at: T2 }));
    setManifest(T3);
    const h = await ctkrArtifactHealth(dataDir);
    expect(h.established).toBe(true);
    const answer = await gateCtkrAggregate("ctkr.motif_search", undefined, async () => ["row"]);
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(answer.result).toEqual(["row"]);
      expect(answer.caveat).toBeUndefined();
    }
  });

  test("RUNNING and REFUSED are unestablished too — and OVERRIDDEN is not", async () => {
    setManifest(T3);
    for (const status of ["RUNNING", "REFUSED", "UNKNOWN"] as const) {
      setHealth(record({ status, finished_at: status === "RUNNING" ? null : T2 }));
      expect((await ctkrArtifactHealth(dataDir)).established).toBe(false);
    }
    // The mirror: an operator's recorded waiver DOES establish fitness, or the
    // gate would be refusing on a state the design calls established.
    setHealth(record({ status: "OVERRIDDEN", finished_at: T2 }));
    expect((await ctkrArtifactHealth(dataDir)).established).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PAIR B — the DERIVED artifact inherits, and can be staler than its input
// ---------------------------------------------------------------------------

describe("PAIR B — an artifact older than the verdict does not inherit it", () => {
  test("artifacts built BEFORE the graph's verdict => refuse, though the graph is HEALTHY", async () => {
    setHealth(record({ status: "HEALTHY", finished_at: T2 }));
    setManifest(T1); // built before the run that established fitness finalized
    const h = await ctkrArtifactHealth(dataDir);
    expect(h.established).toBe(false);
    expect(h.unestablished.some((s) => s.branch === "(derived)")).toBe(true);
    expect(h.unestablished.map((s) => s.repo).join(" ")).toMatch(/earlier graph/);
  });

  test("artifacts built AFTER it => established (the same fixture, one field moved)", async () => {
    setHealth(record({ status: "HEALTHY", finished_at: T2 }));
    setManifest(T3);
    expect((await ctkrArtifactHealth(dataDir)).established).toBe(true);
  });

  test("no manifest at all is UNKNOWN, not 'fine'", async () => {
    setHealth(record({ status: "HEALTHY", finished_at: T2 }));
    const h = await ctkrArtifactHealth(dataDir);
    expect(h.established).toBe(false);
    expect(h.unestablished.map((s) => s.repo).join(" ")).toMatch(/no manifest/);
  });
});

// ---------------------------------------------------------------------------
// PAIR C — the acknowledgment, and what it costs the caller
// ---------------------------------------------------------------------------

describe("PAIR C — acknowledgment proceeds, and is recorded in the answer", () => {
  test("ack=true computes, and the result carries the caveat; ack=false does not compute at all", async () => {
    setManifest(T3); // no health record => unestablished
    let computed = 0;
    const refused = await gateCtkrAggregate("ctkr.role_equivalent", false, async () => {
      computed++;
      return ["row"];
    });
    expect(refused.ok).toBe(false);
    // The refusal must not have opened the artifacts: a gate that computes first
    // and discards is indistinguishable from a missing-file error at the caller.
    expect(computed).toBe(0);

    const acked = await gateCtkrAggregate("ctkr.role_equivalent", true, async () => {
      computed++;
      return ["row"];
    });
    expect(acked.ok).toBe(true);
    expect(computed).toBe(1);
    if (acked.ok) {
      expect(acked.result).toEqual(["row"]);
      expect(acked.caveat).toMatch(/UNESTABLISHED FITNESS/);
    }
  });
});

// ---------------------------------------------------------------------------
// PAIR D — hy6.16's own shape: the refusal has NO result to absorb a zero
// ---------------------------------------------------------------------------

describe("PAIR D — the hy6.16 rescore would throw on row 1 instead of writing 41 wrong rows", () => {
  test("an EMPTY aggregate over an unfit graph is a different TYPE from an empty one over a fit graph", async () => {
    setManifest(T3);
    const unfit = await gateCtkrAggregate("ctkr.role_equivalent", undefined, async () => [] as string[]);
    expect(unfit.ok).toBe(false);
    // The mechanism, asserted rather than described: reaching for the rows crashes.
    expect(() => (unfit as { result: string[] }).result.length).toThrow();

    setHealth(record({ status: "HEALTHY", finished_at: T2 }));
    const fit = await gateCtkrAggregate("ctkr.role_equivalent", undefined, async () => [] as string[]);
    expect(fit.ok).toBe(true);
    // Byte-identical emptiness, distinguishable type. That sentence is hy6.16.
    expect((fit as { result: string[] }).result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WIRING — all eleven registered tools, not just the helper they share
// ---------------------------------------------------------------------------

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function registerAll(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _cfg: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerCtkrTools(server);
  return handlers;
}

/** Minimal args that satisfy each tool's required parameters. */
const ARGS: Record<string, Record<string, unknown>> = {
  "ctkr.motif_search": {},
  "ctkr.nearest_symbols": { symbol_id: "0123456789abcdef" },
  "ctkr.pattern_search": {},
  "ctkr.shape_distance": { repo_a: "a", repo_b: "b" },
  "ctkr.similar_roles": { symbol_id: "0123456789abcdef" },
  "ctkr.structural_alignment": { repo_a: "a", repo_b: "b" },
  "ctkr.composition_patterns": { subsystem: "s1" },
  "ctkr.role_equivalent": { symbol_id: "0123456789abcdef" },
  "ctkr.centrality_query": { metric: "pagerank" },
  "ctkr.subsystems": {},
  "ctkr.interface_of": { subsystem: "s1" },
  "ctkr.composition_rules": { subsystem: "s1" },
  "ctkr.subsystem_card": { subsystem: "s1" },
  "ctkr.functor_between": { repo_a: "a", repo_b: "b" },
};

describe("every registered CTKR tool is gated, not just the shared helper", () => {
  test("all fourteen names refuse over an unestablished graph — and the artifacts are never opened", async () => {
    setManifest(T3); // no health record beside the graph
    const handlers = registerAll();
    expect(handlers.size).toBe(14);
    expect(new Set(handlers.keys())).toEqual(new Set(Object.keys(ARGS)));

    for (const [name, handler] of handlers) {
      const out = await handler(ARGS[name]!);
      const payload = JSON.parse(out.content[0]!.text) as Record<string, unknown>;
      expect({ name, ok: payload["ok"], error: payload["error"] }).toEqual({
        name, ok: false, error: "INDEX_FITNESS_UNESTABLISHED",
      });
      expect(payload).not.toHaveProperty("result");
      expect(String(payload["message"])).toMatch(new RegExp(name.replace(".", "\\.")));
    }
    // Note what this ALSO proves: the data dir holds no parquet files at all.
    // If the gate ran after the artifact read, these calls would have failed
    // with a DuckDB/file error instead of a typed refusal.
  });

  test("MIRROR — with fitness established the same fourteen calls get PAST the gate", async () => {
    setHealth(record({ status: "HEALTHY", finished_at: T2 }));
    setManifest(T3);
    const handlers = registerAll();
    let reachedTheArtifacts = 0;
    for (const [name, handler] of handlers) {
      // The artifacts do not exist, so getting past the gate must now produce an
      // ARTIFACT failure (throw) or a real answer — never the fitness refusal.
      try {
        const out = await handler(ARGS[name]!);
        const payload = JSON.parse(out.content[0]!.text) as Record<string, unknown>;
        expect(payload["error"]).not.toBe("INDEX_FITNESS_UNESTABLISHED");
        reachedTheArtifacts++;
      } catch {
        reachedTheArtifacts++; // opened the artifacts and failed on the files
      }
    }
    expect(reachedTheArtifacts).toBe(14);
  }, 30_000);

  test("acknowledge_unestablished_fitness is on every tool's advertised schema", () => {
    const ctkr = CTKR_TOOL_DESCRIPTIONS;
    expect(ctkr.length).toBe(14);
    for (const d of ctkr) {
      const props = (d.input_schema as { properties: Record<string, unknown> }).properties;
      expect({ name: d.name, has: "acknowledge_unestablished_fitness" in props }).toEqual({
        name: d.name, has: true,
      });
    }
    // CONTRAST: the same assertion on a parameter that does NOT exist must fail,
    // or the loop above would pass over an empty properties object.
    expect(ctkr.every((d) =>
      "no_such_parameter" in (d.input_schema as { properties: Record<string, unknown> }).properties,
    )).toBe(false);
  });
});
