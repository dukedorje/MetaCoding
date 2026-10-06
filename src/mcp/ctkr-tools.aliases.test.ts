import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { z } from "zod";
import { describeApi } from "./tools.ts";
import { aliasResult, registeredCtkrTools } from "./ctkr-alias-test-helpers.ts";

const pairs = [
  ["ctkr.similar_roles", "ctkr.role_equivalent", { symbol_id: "seed", k: 2 }],
  ["ctkr.structural_alignment", "ctkr.functor_between", { repo_a: "A", repo_b: "B", min_margin: 0.1 }],
  ["ctkr.composition_patterns", "ctkr.composition_rules", { subsystem: "s", view: "orbit", min_support: 2 }],
] as const;

test("describe_api and server registrations expose preferred names and compatible schemas", () => {
  const tools = registeredCtkrTools();
  const descriptions = describeApi().tools;
  for (const [preferred, legacy, args] of pairs) {
    const current = tools.get(preferred)!;
    const alias = tools.get(legacy)!;
    expect(current).toBeDefined();
    expect(alias.inputSchema).toBe(current.inputSchema);
    expect(z.object(current.inputSchema).parse(args)).toEqual(args);
    const advertised = descriptions.find((entry) => entry.name === preferred)!;
    const oldAdvertised = descriptions.find((entry) => entry.name === legacy)!;
    expect(advertised.input_schema).toEqual(oldAdvertised.input_schema);
    expect(current.description).toBe(advertised.summary);
    expect(alias.description).toBe(oldAdvertised.summary);
    expect(alias.description).toContain(`Compatibility alias for ${preferred}`);
    expect(current.description).toContain("not");
    expect(Object.keys(current.inputSchema).sort()).toEqual(
      Object.keys((advertised.input_schema as { properties: object }).properties).sort(),
    );
  }
  expect(z.object(tools.get("ctkr.structural_alignment")!.inputSchema).safeParse({ repo_a: "A" }).success).toBe(false);
  expect(z.object(tools.get("ctkr.composition_patterns")!.inputSchema).safeParse({ view: "exact-profile" }).success).toBe(false);
  expect(z.object(tools.get("ctkr.similar_roles")!.inputSchema).safeParse({ k: 0 }).success).toBe(false);
});

let dataDir: string;
let originalEnv: string | undefined;
beforeAll(async () => {
  originalEnv = process.env["METACODING_CTKR_DATA_DIR"];
  dataDir = await mkdtemp(join(tmpdir(), "structural-aliases-"));
  await mkdir(join(dataDir, "ctkr"));
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    await conn.run(`COPY (
      SELECT 'seed' AS symbol_id, 'A' AS repo, 'A.seed' AS qualified_name, [1,0] AS profile_vec, 1 AS schema_version
      UNION ALL SELECT 'same', 'A', 'A.same', [2,0], 1
      UNION ALL SELECT 'near', 'B', 'B.near', [3,0], 1
      UNION ALL SELECT 'far', 'B', 'B.far', [0,1], 1
    ) TO '${join(dataDir, "ctkr/hom_profiles.parquet")}' (FORMAT PARQUET)`);
  } finally { conn.closeSync(); }
  await Bun.write(join(dataDir, "ctkr/manifest.json"), JSON.stringify({
    schema_version: 1, generated_at: "2026-01-01T00:00:00Z", metacoding_data_dir: dataDir,
    hom_profiles: true, n_hom_profiles: 4, profile_vec_dim: 2,
  }));
  process.env["METACODING_CTKR_DATA_DIR"] = dataDir;
});
afterAll(async () => {
  if (originalEnv === undefined) delete process.env["METACODING_CTKR_DATA_DIR"];
  else process.env["METACODING_CTKR_DATA_DIR"] = originalEnv;
  await rm(dataDir, { recursive: true, force: true });
});

test("similar_roles and compatibility alias return identical ranked and scoped rows", async () => {
  const result = await aliasResult("ctkr.similar_roles", "ctkr.role_equivalent", {
    qualified_name: "A.seed", scope: "A", cross_repo_only: true, k: 2,
  });
  expect(result.map((row: { symbol_id: string }) => row.symbol_id)).toEqual(["near", "far"]);
  expect(result[0].hom_profile_distance).toBeCloseTo(0);
  expect(result[1].hom_profile_distance).toBeCloseTo(1);
  expect(await aliasResult("ctkr.similar_roles", "ctkr.role_equivalent", {
    symbol_id: "seed", scope: "B", k: 1,
  })).toEqual([]);
});
