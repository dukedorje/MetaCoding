/**
 * Tests for the ctkr.functor_between MCP handler (§4 / §6 Task 4).
 *
 * Unlike role-equivalent (which reads a real E2E corpus), this builds a small
 * mixed fixture on disk — functors.parquet + functor_edges.parquet +
 * manifest.json — so every branch is exercised deterministically:
 *   - happy path + mapping, min_pair_fidelity + limit/truncation filters;
 *   - direction: "a_to_b" / "b_to_a" / "both";
 *   - all §4 error / semantic modes: multiple configs, fails-filter,
 *     unknown repo, missing artifact, env unset, staleness;
 *   - min_fidelity=1.0 returns only perfect checked-edge scores from the mixed set.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { aliasResult } from "./ctkr-alias-test-helpers.ts";
import { functorBetween } from "./ctkr-tools.ts";

// Column specs mirror FUNCTORS_COLSPEC / FUNCTOR_EDGES_COLSPEC in functorRunner.ts.
const FUNCTORS_COLSPEC: [string, string][] = [
  ["functor_id", "VARCHAR"],
  ["repo_src", "VARCHAR"],
  ["repo_dst", "VARCHAR"],
  ["n_objects_src", "INTEGER"],
  ["n_mapped", "INTEGER"],
  ["coverage", "FLOAT"],
  ["fidelity", "FLOAT"],
  ["n_edges_internal", "INTEGER"],
  ["n_edges_preserved", "INTEGER"],
  ["path_fidelity_2", "FLOAT"],
  ["cycle_consistency", "FLOAT"],
  ["ambiguity_mass", "FLOAT"],
  ["config", "VARCHAR"],
  ["generated_at", "VARCHAR"],
  ["schema_version", "INTEGER"],
];

const FUNCTOR_EDGES_COLSPEC: [string, string][] = [
  ["functor_id", "VARCHAR"],
  ["src_symbol_id", "VARCHAR"],
  ["src_repo", "VARCHAR"],
  ["src_qualified_name", "VARCHAR"],
  ["dst_symbol_id", "VARCHAR"],
  ["dst_repo", "VARCHAR"],
  ["dst_qualified_name", "VARCHAR"],
  ["similarity", "FLOAT"],
  ["margin", "FLOAT"],
  ["is_ambiguous", "BOOLEAN"],
  ["pair_fidelity", "FLOAT"],
  ["n_edges_incident", "INTEGER"],
  ["n_edges_preserved", "INTEGER"],
  ["schema_version", "INTEGER"],
];

const MANIFEST_GEN = "2026-07-14T00:00:00Z";
const OLD_GEN = "2026-01-01T00:00:00Z";

const cfg = (stamp: string): string =>
  JSON.stringify({ alpha: 0.3, extraction: "greedy", hom_profiles_generated_at: stamp });

// Mixed functor set across repos alpha / beta / gamma.
//   F1 alpha→beta  strict     cov .90 fid 1.00   (chosen over F2)
//   F2 alpha→beta  partial    cov .95 fid 0.80   (alternative config)
//   F3 beta→alpha  partial    cov .80 fid 0.70   (reverse-direction row)
//   F4 alpha→gamma partial    cov .60 fid 0.50   (fails min_fidelity=1.0)
//   F5 gamma→beta  strict/STALE cov .70 fid 1.00 (older hom-profile stamp)
const FUNCTORS: Record<string, unknown>[] = [
  {
    functor_id: "f:strict_ab", repo_src: "alpha", repo_dst: "beta",
    n_objects_src: 10, n_mapped: 9, coverage: 0.9, fidelity: 1.0,
    n_edges_internal: 8, n_edges_preserved: 8, path_fidelity_2: -1,
    cycle_consistency: 0.95, config: cfg(MANIFEST_GEN), generated_at: MANIFEST_GEN, schema_version: 1,
  },
  {
    functor_id: "f:alt_ab", repo_src: "alpha", repo_dst: "beta",
    n_objects_src: 10, n_mapped: 10, coverage: 0.95, fidelity: 0.8,
    n_edges_internal: 10, n_edges_preserved: 8, path_fidelity_2: -1,
    cycle_consistency: 0.5, config: cfg(MANIFEST_GEN), generated_at: MANIFEST_GEN, schema_version: 1,
  },
  {
    functor_id: "f:rev_ba", repo_src: "beta", repo_dst: "alpha",
    n_objects_src: 12, n_mapped: 9, coverage: 0.8, fidelity: 0.7,
    n_edges_internal: 10, n_edges_preserved: 7, path_fidelity_2: -1,
    cycle_consistency: 0.6, config: cfg(MANIFEST_GEN), generated_at: MANIFEST_GEN, schema_version: 1,
  },
  {
    functor_id: "f:partial_ag", repo_src: "alpha", repo_dst: "gamma",
    n_objects_src: 10, n_mapped: 6, coverage: 0.6, fidelity: 0.5,
    n_edges_internal: 6, n_edges_preserved: 3, path_fidelity_2: -1,
    cycle_consistency: 0.3, config: cfg(MANIFEST_GEN), generated_at: MANIFEST_GEN, schema_version: 1,
  },
  {
    functor_id: "f:stale_gb", repo_src: "gamma", repo_dst: "beta",
    n_objects_src: 8, n_mapped: 6, coverage: 0.7, fidelity: 1.0,
    n_edges_internal: 5, n_edges_preserved: 5, path_fidelity_2: -1,
    cycle_consistency: 0.9, config: cfg(OLD_GEN), generated_at: OLD_GEN, schema_version: 1,
  },
  // F6 delta→delta — single-repo ENDOFUNCTOR (MetaCoding-4ty). Its mapping
  // carries two cross-member rows plus a trivial identity row for the read-side
  // exclude_identity filter to drop.
  {
    functor_id: "f:endo_delta", repo_src: "delta", repo_dst: "delta",
    n_objects_src: 3, n_mapped: 3, coverage: 1.0, fidelity: 1.0,
    n_edges_internal: 2, n_edges_preserved: 2, path_fidelity_2: -1,
    cycle_consistency: 1.0, config: cfg(MANIFEST_GEN), generated_at: MANIFEST_GEN, schema_version: 1,
  },
  // F7 epsilon→zeta — SATURATED map (MetaCoding-265): high coverage but
  // ambiguity_mass 0.75, most mappings coin-flip ties. The per-symbol map is
  // aggregate-only; the tool must surface that.
  {
    functor_id: "f:sat_ez", repo_src: "epsilon", repo_dst: "zeta",
    n_objects_src: 4, n_mapped: 4, coverage: 1.0, fidelity: 0.9,
    n_edges_internal: 6, n_edges_preserved: 5, path_fidelity_2: -1,
    cycle_consistency: 0.8, ambiguity_mass: 0.75,
    config: cfg(MANIFEST_GEN), generated_at: MANIFEST_GEN, schema_version: 1,
  },
];

// F1 mapping — 4 rows with a spread of pair_fidelity incl. a −1 no-evidence row.
const EDGES: Record<string, unknown>[] = [
  {
    functor_id: "f:strict_ab", src_symbol_id: "a1", src_repo: "alpha", src_qualified_name: "alpha.A1",
    dst_symbol_id: "b1", dst_repo: "beta", dst_qualified_name: "beta.B1",
    similarity: 0.99, margin: 0.5, pair_fidelity: 1.0, n_edges_incident: 4, n_edges_preserved: 4, schema_version: 1,
  },
  {
    functor_id: "f:strict_ab", src_symbol_id: "a2", src_repo: "alpha", src_qualified_name: "alpha.A2",
    dst_symbol_id: "b2", dst_repo: "beta", dst_qualified_name: "beta.B2",
    similarity: 0.90, margin: 0.2, pair_fidelity: 0.5, n_edges_incident: 2, n_edges_preserved: 1, schema_version: 1,
  },
  {
    functor_id: "f:strict_ab", src_symbol_id: "a3", src_repo: "alpha", src_qualified_name: "alpha.A3",
    dst_symbol_id: "b3", dst_repo: "beta", dst_qualified_name: "beta.B3",
    similarity: 0.80, margin: 0.01, pair_fidelity: 0.0, n_edges_incident: 3, n_edges_preserved: 0, schema_version: 1,
  },
  {
    functor_id: "f:strict_ab", src_symbol_id: "a4", src_repo: "alpha", src_qualified_name: "alpha.A4",
    dst_symbol_id: "b4", dst_repo: "beta", dst_qualified_name: "beta.B4",
    similarity: 0.70, margin: 1.0, pair_fidelity: -1, n_edges_incident: 0, n_edges_preserved: 0, schema_version: 1,
  },
  // F6 delta→delta endofunctor mapping: two cross-member rows + one identity row.
  {
    functor_id: "f:endo_delta", src_symbol_id: "d1", src_repo: "delta", src_qualified_name: "delta.D1",
    dst_symbol_id: "d2", dst_repo: "delta", dst_qualified_name: "delta.D2",
    similarity: 0.99, margin: 0.4, pair_fidelity: 1.0, n_edges_incident: 2, n_edges_preserved: 2, schema_version: 1,
  },
  {
    functor_id: "f:endo_delta", src_symbol_id: "d2", src_repo: "delta", src_qualified_name: "delta.D2",
    dst_symbol_id: "d1", dst_repo: "delta", dst_qualified_name: "delta.D1",
    similarity: 0.98, margin: 0.3, pair_fidelity: 1.0, n_edges_incident: 2, n_edges_preserved: 2, schema_version: 1,
  },
  {
    functor_id: "f:endo_delta", src_symbol_id: "d3", src_repo: "delta", src_qualified_name: "delta.D3",
    dst_symbol_id: "d3", dst_repo: "delta", dst_qualified_name: "delta.D3",
    similarity: 1.0, margin: 0.0, pair_fidelity: 1.0, n_edges_incident: 1, n_edges_preserved: 1, schema_version: 1,
  },
  // F7 saturated mapping: 3 of 4 rows are coin-flip ties (is_ambiguous, tiny
  // margin); e1→z1 is the one confidently-resolved row (margin 0.5).
  {
    functor_id: "f:sat_ez", src_symbol_id: "e1", src_repo: "epsilon", src_qualified_name: "epsilon.E1",
    dst_symbol_id: "z1", dst_repo: "zeta", dst_qualified_name: "zeta.Z1",
    similarity: 0.95, margin: 0.5, is_ambiguous: false, pair_fidelity: 1.0, n_edges_incident: 2, n_edges_preserved: 2, schema_version: 1,
  },
  {
    functor_id: "f:sat_ez", src_symbol_id: "e2", src_repo: "epsilon", src_qualified_name: "epsilon.E2",
    dst_symbol_id: "z2", dst_repo: "zeta", dst_qualified_name: "zeta.Z2",
    similarity: 0.9, margin: 0.005, is_ambiguous: true, pair_fidelity: 0.5, n_edges_incident: 2, n_edges_preserved: 1, schema_version: 1,
  },
  {
    functor_id: "f:sat_ez", src_symbol_id: "e3", src_repo: "epsilon", src_qualified_name: "epsilon.E3",
    dst_symbol_id: "z3", dst_repo: "zeta", dst_qualified_name: "zeta.Z3",
    similarity: 0.88, margin: 0.001, is_ambiguous: true, pair_fidelity: 1.0, n_edges_incident: 1, n_edges_preserved: 1, schema_version: 1,
  },
  {
    functor_id: "f:sat_ez", src_symbol_id: "e4", src_repo: "epsilon", src_qualified_name: "epsilon.E4",
    dst_symbol_id: "z4", dst_repo: "zeta", dst_qualified_name: "zeta.Z4",
    similarity: 0.87, margin: 0.0, is_ambiguous: true, pair_fidelity: 1.0, n_edges_incident: 1, n_edges_preserved: 1, schema_version: 1,
  },
];

async function writeParquet(
  outPath: string,
  colspec: [string, string][],
  rows: Record<string, unknown>[],
): Promise<void> {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const cols = "{" + colspec.map(([n, t]) => `${n}: '${t}'`).join(", ") + "}";
  const nd = outPath + ".src.ndjson";
  await Bun.write(nd, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await conn.run(
    `COPY (SELECT * FROM read_json('${nd}', format='newline_delimited', columns=${cols})) ` +
      `TO '${outPath}' (FORMAT PARQUET)`,
  );
  conn.closeSync();
}

// MetaCoding-265: default the additive ambiguity columns so the pre-265 rows
// above stay terse; rows that exercise ambiguity set the fields explicitly.
const withFunctorDefaults = (r: Record<string, unknown>): Record<string, unknown> => ({
  ambiguity_mass: 0.0,
  ...r,
});
const withEdgeDefaults = (r: Record<string, unknown>): Record<string, unknown> => ({
  is_ambiguous: false,
  ...r,
});

async function buildFixture(dir: string): Promise<void> {
  const ctkr = join(dir, "ctkr");
  await mkdir(ctkr, { recursive: true });
  await writeParquet(
    join(ctkr, "functors.parquet"),
    FUNCTORS_COLSPEC,
    FUNCTORS.map(withFunctorDefaults),
  );
  await writeParquet(
    join(ctkr, "functor_edges.parquet"),
    FUNCTOR_EDGES_COLSPEC,
    EDGES.map(withEdgeDefaults),
  );
  await Bun.write(
    join(ctkr, "manifest.json"),
    JSON.stringify(
      {
        schema_version: 1,
        generated_at: MANIFEST_GEN,
        metacoding_data_dir: dir,
        hom_profiles: true,
        profile_depth: 2,
        functors: true,
        functor_edges: true,
        n_functors: FUNCTORS.length,
        n_functor_edges: EDGES.length,
      },
      null,
      2,
    ) + "\n",
  );
}

let dataDir: string;
let originalEnv: string | undefined;

beforeAll(async () => {
  originalEnv = process.env["METACODING_CTKR_DATA_DIR"];
  dataDir = await mkdtemp(join(tmpdir(), "functor-between-"));
  await buildFixture(dataDir);
  process.env["METACODING_CTKR_DATA_DIR"] = dataDir;
});

afterAll(async () => {
  if (originalEnv === undefined) delete process.env["METACODING_CTKR_DATA_DIR"];
  else process.env["METACODING_CTKR_DATA_DIR"] = originalEnv;
  await rm(dataDir, { recursive: true, force: true });
});

describe("functorBetween", () => {
  test("structural_alignment and legacy alias return identical filtered mappings", async () => {
    const result = await aliasResult("ctkr.structural_alignment", "ctkr.functor_between", {
      repo_a: "alpha", repo_b: "beta", direction: "both", members_a: ["a1", "a2"], limit: 1,
    });
    expect(result.functor).not.toBeNull();
    expect(result.mapping).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result).toHaveProperty("reverse");
  });

  test("happy path: returns the best functor + full mapping for a_to_b", async () => {
    const res = await functorBetween({ repo_a: "alpha", repo_b: "beta" });
    expect(res.functor).not.toBeNull();
    // best by coverage×fidelity: strict (0.9) beats alt (0.76)
    expect(res.functor!.functor_id).toBe("f:strict_ab");
    expect(res.functor!.fidelity).toBeCloseTo(1.0, 5);
    expect(res.functor!.coverage).toBeCloseTo(0.9, 5);
    expect(res.functor!.repo_src).toBe("alpha");
    expect(res.functor!.repo_dst).toBe("beta");
    // path_fidelity_2 is −1 (not computed) → omitted
    expect(res.functor!.path_fidelity_2).toBeUndefined();
    // reverse only for direction:"both"
    expect(res.reverse).toBeUndefined();
    // mapping: 4 rows, sorted pair_fidelity desc, −1 → null and sorts last
    expect(res.mapping.length).toBe(4);
    expect(res.mapping[0]!.pair_fidelity).toBeCloseTo(1.0, 5);
    expect(res.mapping[res.mapping.length - 1]!.src_symbol_id).toBe("a4");
    expect(res.mapping[res.mapping.length - 1]!.pair_fidelity).toBeNull();
    expect(res.truncated).toBe(false);
    // exactly one alternative config note
    expect(res._note).toContain("1 alternative config");
  });

  test("mapping rows expose margin and denormalized names", async () => {
    const res = await functorBetween({ repo_a: "alpha", repo_b: "beta" });
    const top = res.mapping[0]!;
    expect(top.src_symbol_id).toBe("a1");
    expect(top.src_qualified_name).toBe("alpha.A1");
    expect(top.dst_qualified_name).toBe("beta.B1");
    expect(typeof top.margin).toBe("number");
    expect(typeof top.similarity).toBe("number");
  });

  test("min_pair_fidelity filters mapping rows (drops no-evidence + low pairs)", async () => {
    const res = await functorBetween({
      repo_a: "alpha", repo_b: "beta", min_pair_fidelity: 0.6,
    });
    expect(res.mapping.length).toBe(1);
    expect(res.mapping[0]!.src_symbol_id).toBe("a1");
    expect(res.mapping.every((m) => m.pair_fidelity !== null && m.pair_fidelity >= 0.6)).toBe(true);
  });

  test("limit truncates mapping rows and sets truncated", async () => {
    const res = await functorBetween({ repo_a: "alpha", repo_b: "beta", limit: 2 });
    expect(res.mapping.length).toBe(2);
    expect(res.truncated).toBe(true);
    // still the top-2 by pair_fidelity
    expect(res.mapping[0]!.src_symbol_id).toBe("a1");
    expect(res.mapping[1]!.src_symbol_id).toBe("a2");
  });

  test("direction b_to_a returns the reverse-stored functor as primary", async () => {
    const res = await functorBetween({ repo_a: "alpha", repo_b: "beta", direction: "b_to_a" });
    expect(res.functor).not.toBeNull();
    expect(res.functor!.functor_id).toBe("f:rev_ba");
    expect(res.functor!.repo_src).toBe("beta");
    expect(res.functor!.repo_dst).toBe("alpha");
    expect(res.reverse).toBeUndefined();
  });

  test('direction "both" adds the reverse summary', async () => {
    const res = await functorBetween({ repo_a: "alpha", repo_b: "beta", direction: "both" });
    expect(res.functor!.functor_id).toBe("f:strict_ab"); // primary a→b
    expect(res.reverse).not.toBeNull();
    expect(res.reverse!.functor_id).toBe("f:rev_ba"); // reverse b→a
    // primary mapping only
    expect(res.mapping.length).toBe(4);
  });

  test('direction "both" reports null reverse when the reverse pair is absent', async () => {
    const res = await functorBetween({ repo_a: "alpha", repo_b: "gamma", direction: "both" });
    expect(res.functor!.functor_id).toBe("f:partial_ag");
    expect(res.reverse).toBeNull();
    expect(res._note).toContain("no reverse functor gamma→alpha");
  });

  // --- §4 semantics & error modes ---

  test("min_fidelity=1.0 returns perfect checked-edge scores, not functor proofs", async () => {
    // alpha→beta has a strict config → returned.
    const strict = await functorBetween({ repo_a: "alpha", repo_b: "beta", min_fidelity: 1.0 });
    expect(strict.functor).not.toBeNull();
    expect(strict.functor!.fidelity).toBe(1.0);
    // the alternative (0.8) is filtered out → no alternative-config note.
    expect(strict._note ?? "").not.toContain("alternative config");

    // alpha→gamma's best fidelity is 0.5 → no strict functor → functor:null.
    const partial = await functorBetween({ repo_a: "alpha", repo_b: "gamma", min_fidelity: 1.0 });
    expect(partial.functor).toBeNull();
    expect(partial._note).toContain("best available");
    expect(partial._note).toContain("fidelity=0.50");
  });

  test("pair present but below min_coverage → functor:null with best-available note", async () => {
    const res = await functorBetween({ repo_a: "alpha", repo_b: "gamma", min_coverage: 0.95 });
    expect(res.functor).toBeNull();
    expect(res.mapping).toEqual([]);
    expect(res._note).toContain("min_coverage=0.95");
    expect(res._note).toContain("coverage=0.60");
  });

  test("multiple configs: returns max coverage×fidelity, notes the alternative count", async () => {
    const res = await functorBetween({ repo_a: "alpha", repo_b: "beta" });
    expect(res.functor!.functor_id).toBe("f:strict_ab");
    expect(res._note).toContain("1 alternative config");
  });

  test("unknown repo → functor:null listing available repos", async () => {
    const res = await functorBetween({ repo_a: "nope", repo_b: "beta" });
    expect(res.functor).toBeNull();
    expect(res._note).toContain("unknown repo");
    expect(res._note).toContain("nope");
    expect(res._note).toContain("available repos");
    expect(res._note).toContain("alpha");
  });

  test("known repos but ordered pair never discovered → explanatory note", async () => {
    // beta→gamma is absent, but both repos appear elsewhere.
    const res = await functorBetween({ repo_a: "beta", repo_b: "gamma" });
    expect(res.functor).toBeNull();
    expect(res._note).toContain("no functor computed for beta→gamma");
  });

  test("staleness: older structural-profile stamp is flagged in _note", async () => {
    const res = await functorBetween({ repo_a: "gamma", repo_b: "beta" });
    expect(res.functor!.functor_id).toBe("f:stale_gb");
    expect(res._note).toContain("older structural-profile generation");
  });

  test("non-stale functor carries no staleness note", async () => {
    const res = await functorBetween({ repo_a: "alpha", repo_b: "beta" });
    expect(res._note ?? "").not.toContain("older structural-profile generation");
  });

  // --- MetaCoding-4ty: member-set restriction + endofunctor read-side ---

  test("members_a restricts the mapping to in-set domain symbols", async () => {
    const res = await functorBetween({
      repo_a: "alpha", repo_b: "beta", members_a: ["a1", "a2"],
    });
    expect(res.mapping.length).toBe(2);
    for (const m of res.mapping) expect(["a1", "a2"]).toContain(m.src_symbol_id);
  });

  test("members_b restricts the mapping to in-set codomain symbols", async () => {
    const res = await functorBetween({
      repo_a: "alpha", repo_b: "beta", members_b: ["b1"],
    });
    expect(res.mapping.length).toBe(1);
    expect(res.mapping[0]!.src_symbol_id).toBe("a1");
    expect(res.mapping[0]!.dst_symbol_id).toBe("b1");
  });

  test("members_a + members_b intersect (both sides must be in-set)", async () => {
    const res = await functorBetween({
      repo_a: "alpha", repo_b: "beta", members_a: ["a1", "a2"], members_b: ["b2"],
    });
    expect(res.mapping.length).toBe(1);
    expect(res.mapping[0]!.src_symbol_id).toBe("a2");
    expect(res.mapping[0]!.dst_symbol_id).toBe("b2");
  });

  test("member filtering keeps truncation accurate", async () => {
    const res = await functorBetween({
      repo_a: "alpha", repo_b: "beta", members_a: ["a1", "a2", "a3"], limit: 2,
    });
    expect(res.mapping.length).toBe(2);
    expect(res.truncated).toBe(true);
  });

  test("endofunctor: repo_a===repo_b drops the identity row by default", async () => {
    const res = await functorBetween({ repo_a: "delta", repo_b: "delta" });
    expect(res.functor!.functor_id).toBe("f:endo_delta");
    expect(res.mapping.length).toBe(2); // d3→d3 identity dropped
    for (const m of res.mapping) expect(m.src_symbol_id).not.toBe(m.dst_symbol_id);
    const srcs = res.mapping.map((m) => m.src_symbol_id).sort();
    expect(srcs).toEqual(["d1", "d2"]);
  });

  test("endofunctor: exclude_identity=false keeps the identity row", async () => {
    const res = await functorBetween({
      repo_a: "delta", repo_b: "delta", exclude_identity: false,
    });
    expect(res.mapping.length).toBe(3);
    expect(res.mapping.some((m) => m.src_symbol_id === "d3" && m.dst_symbol_id === "d3")).toBe(true);
  });

  test("exclude_identity can be forced on for a cross-repo pair (no-op here)", async () => {
    // alpha→beta has no self-maps, so forcing the filter changes nothing.
    const res = await functorBetween({
      repo_a: "alpha", repo_b: "beta", exclude_identity: true,
    });
    expect(res.mapping.length).toBe(4);
  });

  // --- MetaCoding-265: margin-aware honesty ---

  test("saturated functor surfaces ambiguity_mass, n_ambiguous, is_ambiguous", async () => {
    const res = await functorBetween({ repo_a: "epsilon", repo_b: "zeta" });
    expect(res.functor!.functor_id).toBe("f:sat_ez");
    // The functor-level honesty metric rides on the summary.
    expect(res.functor!.ambiguity_mass).toBeCloseTo(0.75, 5);
    // 3 of 4 returned rows are coin-flip ties.
    expect(res.mapping.length).toBe(4);
    expect(res.n_ambiguous).toBe(3);
    expect(res.mapping.filter((m) => m.is_ambiguous).length).toBe(3);
    // The honest-framing note fires (>=50% coin-flip).
    expect(res._note).toContain("ambiguity_mass=75%");
    expect(res._note).toContain("UNRELIABLE");
  });

  test("min_margin drops coin-flip-tie mapping rows (keeps only resolved)", async () => {
    const res = await functorBetween({
      repo_a: "epsilon", repo_b: "zeta", min_margin: 0.1,
    });
    // Only e1→z1 (margin 0.5) clears the floor; the three ties are dropped.
    expect(res.mapping.length).toBe(1);
    expect(res.mapping[0]!.src_symbol_id).toBe("e1");
    expect(res.mapping.every((m) => m.margin >= 0.1)).toBe(true);
    expect(res.n_ambiguous).toBe(0);
  });

  test("a clean (low-ambiguity) functor carries no ambiguity note", async () => {
    const res = await functorBetween({ repo_a: "alpha", repo_b: "beta" });
    expect(res.functor!.ambiguity_mass).toBe(0);
    expect(res.n_ambiguous).toBe(0);
    expect(res._note ?? "").not.toContain("UNRELIABLE");
  });
});

describe("functorBetween error modes (isolated env)", () => {
  test("METACODING_CTKR_DATA_DIR unset → throws", async () => {
    const saved = process.env["METACODING_CTKR_DATA_DIR"];
    delete process.env["METACODING_CTKR_DATA_DIR"];
    try {
      await expect(functorBetween({ repo_a: "alpha", repo_b: "beta" })).rejects.toThrow(
        /METACODING_CTKR_DATA_DIR/,
      );
    } finally {
      process.env["METACODING_CTKR_DATA_DIR"] = saved;
    }
  });

  describe("missing functor artifacts", () => {
    let emptyDir: string;
    let saved: string | undefined;

    beforeEach(async () => {
      saved = process.env["METACODING_CTKR_DATA_DIR"];
      emptyDir = await mkdtemp(join(tmpdir(), "functor-between-empty-"));
      const ctkr = join(emptyDir, "ctkr");
      await mkdir(ctkr, { recursive: true });
      await Bun.write(
        join(ctkr, "manifest.json"),
        JSON.stringify({ schema_version: 1, generated_at: MANIFEST_GEN, functors: false }, null, 2) + "\n",
      );
      process.env["METACODING_CTKR_DATA_DIR"] = emptyDir;
    });

    afterEach(async () => {
      if (saved === undefined) delete process.env["METACODING_CTKR_DATA_DIR"];
      else process.env["METACODING_CTKR_DATA_DIR"] = saved;
      await rm(emptyDir, { recursive: true, force: true });
    });

    test("functors.parquet absent → throws the runner-specific message", async () => {
      await expect(functorBetween({ repo_a: "alpha", repo_b: "beta" })).rejects.toThrow(
        /functor artifacts not found in .* — run the functor discovery runner first/,
      );
    });
  });
});
