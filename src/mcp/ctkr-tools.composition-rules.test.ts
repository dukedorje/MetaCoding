/**
 * Tests for the ctkr.composition_rules MCP handler (subsystem-extraction §4.3 /
 * §8.2, T4 — scoped operad recovery).
 *
 * Builds an on-disk fixture — operads.parquet + manifest.json — so every branch
 * runs deterministically without an external corpus:
 *   - path + fan_in operations split from non_operadic violations;
 *   - protocol_roles collected from boundary ops;
 *   - view / op_kind / boundary_only / min_support filters;
 *   - unknown-subsystem note + missing-artifact error mode.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { aliasResult } from "./ctkr-alias-test-helpers.ts";
import { compositionRules } from "./ctkr-tools.ts";

const OP_COLSPEC: [string, string][] = [
  ["subsystem_id", "VARCHAR"],
  ["repo", "VARCHAR"],
  ["operation_id", "VARCHAR"],
  ["view", "VARCHAR"],
  ["op_kind", "VARCHAR"],
  ["arity", "INTEGER"],
  ["input_roles", "VARCHAR[]"],
  ["output_role", "VARCHAR"],
  ["edge_kinds", "VARCHAR[]"],
  ["support", "INTEGER"],
  ["is_boundary_op", "BOOLEAN"],
  ["associative_observed", "BOOLEAN"],
  ["law_violations", "INTEGER"],
  ["violation_kind", "VARCHAR"],
  ["exemplar_paths", "VARCHAR[]"],
  ["invariance_tier", "VARCHAR"],
  ["config", "VARCHAR"],
  ["generated_at", "VARCHAR"],
  ["schema_version", "INTEGER"],
];

function op(o: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    subsystem_id: "ss:A", repo: "R", operation_id: "op:x", view: "similarity",
    op_kind: "path", arity: 1, input_roles: ["role:Handler"], output_role: "role:Validator",
    edge_kinds: ["CALLS"], support: 5, is_boundary_op: false, associative_observed: true,
    law_violations: 0, violation_kind: "", exemplar_paths: ["a -> b"], invariance_tier: "I",
    config: "{}", generated_at: "2026-07-14T00:00:00Z", schema_version: 1, ...o,
  };
}

const OPERADS: Record<string, unknown>[] = [
  // ss:A — a boundary path op (Handler public), a plain path op, a fan_in, and
  // two violations. Plus an orbit-view row that the similarity view must hide.
  op({ operation_id: "op:1", op_kind: "path", arity: 1, input_roles: ["role:Handler"],
    output_role: "role:Validator", support: 9, is_boundary_op: true }),
  op({ operation_id: "op:2", op_kind: "path", arity: 2, input_roles: ["role:Validator", "role:Loader"],
    output_role: "role:Store", support: 4, is_boundary_op: false }),
  op({ operation_id: "op:3", op_kind: "fan_in", arity: 2, input_roles: ["role:Handler", "role:Worker"],
    output_role: "role:Serializer", support: 3, is_boundary_op: true }),
  op({ operation_id: "op:4", op_kind: "non_operadic", arity: 2, input_roles: ["role:Cache", "role:Store"],
    output_role: "role:Logger", support: 2, is_boundary_op: true, associative_observed: false,
    law_violations: 1, violation_kind: "missing_composite", edge_kinds: [] }),
  op({ operation_id: "op:5", op_kind: "non_operadic", arity: 2, input_roles: ["role:Orch", "role:Worker"],
    output_role: "role:Orch", support: 6, is_boundary_op: false, associative_observed: false,
    law_violations: 1, violation_kind: "back_call_cycle", edge_kinds: [] }),
  // orbit-view duplicate (must not appear in a similarity query).
  op({ operation_id: "op:6", op_kind: "path", view: "orbit", input_roles: ["role:Handler"],
    output_role: "role:Validator", support: 9, is_boundary_op: true }),
  // a second subsystem, so scoping actually filters.
  op({ operation_id: "op:7", subsystem_id: "ss:B", op_kind: "path", input_roles: ["role:Q"],
    output_role: "role:Z", support: 5, is_boundary_op: false }),
];

async function writeParquet(
  outPath: string, colspec: [string, string][], rows: Record<string, unknown>[],
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

async function buildFixture(dir: string, opts?: { operads?: boolean }): Promise<void> {
  const ctkr = join(dir, "ctkr");
  await mkdir(ctkr, { recursive: true });
  const present = opts?.operads ?? true;
  if (present) {
    await writeParquet(join(ctkr, "operads.parquet"), OP_COLSPEC, OPERADS);
  }
  await Bun.write(
    join(ctkr, "manifest.json"),
    JSON.stringify(
      {
        schema_version: 1, generated_at: "2026-07-14T00:00:00Z", metacoding_data_dir: dir,
        operads: present, n_operads: present ? OPERADS.length : 0,
      },
      null, 2,
    ) + "\n",
  );
}

let dataDir: string;
let originalEnv: string | undefined;

beforeAll(async () => {
  originalEnv = process.env["METACODING_CTKR_DATA_DIR"];
  dataDir = await mkdtemp(join(tmpdir(), "composition-rules-"));
  await buildFixture(dataDir);
  process.env["METACODING_CTKR_DATA_DIR"] = dataDir;
});

afterAll(async () => {
  if (originalEnv === undefined) delete process.env["METACODING_CTKR_DATA_DIR"];
  else process.env["METACODING_CTKR_DATA_DIR"] = originalEnv;
  await rm(dataDir, { recursive: true, force: true });
});

describe("compositionRules", () => {
  test("composition_patterns and legacy alias retain schemas, filters, and diagnostics", async () => {
    const result = await aliasResult("ctkr.composition_patterns", "ctkr.composition_rules", {
      subsystem: "ss:A", boundary_only: true, min_support: 2,
    });
    expect(result.operations).toHaveLength(2);
    expect(result.violations).toHaveLength(1);
    expect(result.protocol_roles).toContain("role:Handler");
    const exact = await aliasResult("ctkr.composition_patterns", "ctkr.composition_rules", {
      subsystem: "ss:A", view: "orbit",
    });
    expect(exact.view).toBe("orbit");
    expect(exact.operations).toHaveLength(1);
  });

  test("scoped operad: operations split from violations", async () => {
    const res = await compositionRules({ subsystem: "ss:A" });
    // 3 real ops (path x2 + fan_in), 2 violations — orbit row excluded (default similarity).
    expect(res.operations.length).toBe(3);
    expect(res.violations.length).toBe(2);
    expect(res.n_operations).toBe(3);
    expect(res.view).toBe("similarity");
    // strongest / protocol first: boundary op op:1 (support 9) leads.
    expect(res.operations[0]!.operation_id).toBe("op:1");
    expect(res.operations.every((o) => o.op_kind !== "non_operadic")).toBe(true);
  });

  test("violation bookkeeping is surfaced by kind", async () => {
    const res = await compositionRules({ subsystem: "ss:A" });
    expect(res.n_missing_composite).toBe(1);
    expect(res.n_back_call_cycle).toBe(1);
    const kinds = res.violations.map((v) => v.violation_kind).sort();
    expect(kinds).toEqual(["back_call_cycle", "missing_composite"]);
  });

  test("protocol_roles collected from boundary ops only", async () => {
    const res = await compositionRules({ subsystem: "ss:A" });
    // boundary ops: op:1 (Handler→Validator), op:3 (Handler,Worker→Serializer),
    // op:4 (Cache,Store→Logger). Non-boundary op:2 / op:5 roles excluded.
    expect(res.protocol_roles).toEqual([
      "role:Cache", "role:Handler", "role:Logger", "role:Serializer",
      "role:Store", "role:Validator", "role:Worker",
    ]);
    expect(res.n_boundary_ops).toBe(3);
  });

  test("op_kind filter returns only that family", async () => {
    const res = await compositionRules({ subsystem: "ss:A", op_kind: "fan_in" });
    expect(res.operations.length).toBe(1);
    expect(res.operations[0]!.op_kind).toBe("fan_in");
    expect(res.violations.length).toBe(0);
  });

  test("boundary_only keeps only protocol operations", async () => {
    const res = await compositionRules({ subsystem: "ss:A", boundary_only: true });
    const all = [...res.operations, ...res.violations];
    expect(all.every((o) => o.is_boundary_op)).toBe(true);
    expect(all.length).toBe(3); // op:1, op:3, op:4
  });

  test("min_support filters weak operations", async () => {
    const res = await compositionRules({ subsystem: "ss:A", min_support: 5 });
    const all = [...res.operations, ...res.violations];
    expect(all.every((o) => o.support >= 5)).toBe(true);
    // op:1 (9) and op:5 (6) survive.
    expect(all.map((o) => o.operation_id).sort()).toEqual(["op:1", "op:5"]);
  });

  test("orbit view returns the orbit-projected operad", async () => {
    const res = await compositionRules({ subsystem: "ss:A", view: "orbit" });
    expect(res.view).toBe("orbit");
    expect(res.operations.map((o) => o.operation_id)).toEqual(["op:6"]);
  });

  test("subsystem scoping filters to one subsystem", async () => {
    const res = await compositionRules({ subsystem: "ss:B" });
    expect(res.operations.length).toBe(1);
    expect(res.operations[0]!.subsystem_id).toBe("ss:B");
  });

  test("unknown subsystem yields a note listing known ids", async () => {
    const res = await compositionRules({ subsystem: "ss:nope" });
    expect(res.operations.length).toBe(0);
    expect(res._note).toContain("unknown subsystem");
    expect(res._note).toContain("ss:A");
  });
});

describe("compositionRules error modes", () => {
  test("missing artifact throws a clear, actionable error", async () => {
    const saved = process.env["METACODING_CTKR_DATA_DIR"];
    const emptyDir = await mkdtemp(join(tmpdir(), "composition-rules-empty-"));
    await buildFixture(emptyDir, { operads: false });
    process.env["METACODING_CTKR_DATA_DIR"] = emptyDir;
    try {
      await expect(compositionRules({ subsystem: "ss:A" })).rejects.toThrow(/ctkr operads/);
    } finally {
      if (saved === undefined) delete process.env["METACODING_CTKR_DATA_DIR"];
      else process.env["METACODING_CTKR_DATA_DIR"] = saved;
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  test("METACODING_CTKR_DATA_DIR unset → throws", async () => {
    const saved = process.env["METACODING_CTKR_DATA_DIR"];
    delete process.env["METACODING_CTKR_DATA_DIR"];
    try {
      await expect(compositionRules({ subsystem: "ss:A" })).rejects.toThrow(
        /METACODING_CTKR_DATA_DIR/,
      );
    } finally {
      process.env["METACODING_CTKR_DATA_DIR"] = saved;
    }
  });
});
