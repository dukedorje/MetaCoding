// metacoding doctor — diagnose which indexing lanes are active and what's missing.

import { resolveScipBin } from "../scip";

interface ParsedArgs {
  cmd: string;
  positional: string[];
  flags: Record<string, string>;
}

interface LaneStatus {
  label: string;
  ok: boolean;
  detail: string;
  installHint?: string;
}

/** Try to get the version string from a binary via `--version`. Never throws. */
async function getBinaryVersion(binPath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([binPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, _status] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const line = stdout.trim().split(/\r?\n/)[0] ?? "";
    // Extract something that looks like a version number (e.g. "0.4.0")
    const match = line.match(/\d+\.\d+(?:\.\d+)?/);
    return match ? match[0] : (line.slice(0, 40) || null);
  } catch {
    return null;
  }
}

export async function runDoctor(_args: ParsedArgs): Promise<void> {
  const lanes: LaneStatus[] = [];
  const recommendations: string[] = [];

  // ── SCIP TypeScript ──────────────────────────────────────────────────────
  const scipTsPath = resolveScipBin("scip-typescript");
  if (scipTsPath) {
    const ver = await getBinaryVersion(scipTsPath);
    lanes.push({
      label: "SCIP TypeScript",
      ok: true,
      detail: `found at ${scipTsPath}${ver ? ` (v${ver})` : ""}`,
    });
  } else {
    lanes.push({
      label: "SCIP TypeScript",
      ok: false,
      detail: "not found",
      installHint: "bun add -g @sourcegraph/scip-typescript",
    });
    recommendations.push(
      "Install scip-typescript for CALLS/REFERENCES/IMPLEMENTS edges:\n    bun add -g @sourcegraph/scip-typescript",
    );
  }

  // ── SCIP Python ──────────────────────────────────────────────────────────
  const scipPyPath = resolveScipBin("scip-python");
  if (scipPyPath) {
    const ver = await getBinaryVersion(scipPyPath);
    lanes.push({
      label: "SCIP Python",
      ok: true,
      detail: `found at ${scipPyPath}${ver ? ` (v${ver})` : ""}`,
    });
  } else {
    lanes.push({
      label: "SCIP Python",
      ok: false,
      detail: "not found",
      installHint: "bun add -g @sourcegraph/scip-python",
    });
    recommendations.push(
      "Install scip-python for CALLS/REFERENCES/IMPLEMENTS edges (Python):\n    bun add -g @sourcegraph/scip-python",
    );
  }

  // ── SCIP Rust ────────────────────────────────────────────────────────────
  // rust-analyzer is usually a rustup proxy, which exists on PATH even when
  // the component is not installed — so ask it for a version, not just which.
  const raPath = resolveScipBin("rust-analyzer");
  const raVer = raPath ? await getBinaryVersion(raPath) : null;
  if (raPath && raVer) {
    lanes.push({
      label: "SCIP Rust",
      ok: true,
      detail: `rust-analyzer found at ${raPath} (v${raVer})`,
    });
  } else {
    lanes.push({
      label: "SCIP Rust",
      ok: false,
      detail: raPath ? `${raPath} present but not runnable (component missing?)` : "not found",
      installHint: "rustup component add rust-analyzer",
    });
    recommendations.push(
      "Install rust-analyzer for CALLS/REFERENCES/IMPLEMENTS edges (Rust) — in a repo with\n" +
        "    a rust-toolchain.toml, add it to THAT toolchain:\n    rustup component add rust-analyzer",
    );
  }

  // ── LSP TypeScript ───────────────────────────────────────────────────────
  const tsLspPath = Bun.which("typescript-language-server");
  if (tsLspPath) {
    lanes.push({
      label: "LSP TypeScript",
      ok: true,
      detail: `typescript-language-server found at ${tsLspPath}`,
    });
  } else {
    lanes.push({
      label: "LSP TypeScript",
      ok: false,
      detail: "typescript-language-server not on PATH",
      installHint: "bun add -g typescript-language-server typescript",
    });
    recommendations.push(
      "Install typescript-language-server to enable LSP hover/completions:\n    bun add -g typescript-language-server typescript",
    );
  }

  // ── LSP Python ───────────────────────────────────────────────────────────
  const pyrightPath = Bun.which("pyright") ?? Bun.which("pyright-langserver");
  if (pyrightPath) {
    lanes.push({
      label: "LSP Python",
      ok: true,
      detail: `pyright found at ${pyrightPath}`,
    });
  } else {
    lanes.push({
      label: "LSP Python",
      ok: false,
      detail: "pyright not on PATH",
      installHint: "bun add -g pyright",
    });
    recommendations.push(
      "Install pyright to get LSP coverage for Python:\n    bun add -g pyright",
    );
  }

  // ── Tree-sitter (always available) ───────────────────────────────────────
  lanes.push({
    label: "Tree-sitter",
    ok: true,
    detail: "always available (in-process)",
  });

  // ── FTS5 / SQLite (always available) ─────────────────────────────────────
  lanes.push({
    label: "FTS5 (SQLite)",
    ok: true,
    detail: "always available (in-process)",
  });

  // ── Joern (optional) ─────────────────────────────────────────────────────
  const joernPath = Bun.which("joern");
  if (joernPath) {
    lanes.push({
      label: "Joern (opt-in)",
      ok: true,
      detail: `found at ${joernPath}`,
    });
  } else {
    lanes.push({
      label: "Joern (opt-in)",
      ok: false,
      detail: "not installed (optional, only for graph_taint)",
    });
    // Joern is optional — no recommendation unless user is specifically using graph_taint
  }

  // ── CTKR Phase 2+ readiness ──────────────────────────────────────────────
  const scipAvailable = scipTsPath !== null || scipPyPath !== null;
  const ctkrVerdict = scipAvailable
    ? "✓ All edges needed for hom-profile analysis are populated."
    : "✗ SCIP indexers missing — CALLS/REFERENCES/IMPLEMENTS edges will not be populated.";
  const ctkrStatus = scipAvailable ? "PROCEED" : "BLOCKED";

  // ── Render ───────────────────────────────────────────────────────────────
  const labelWidth = Math.max(...lanes.map((l) => l.label.length));

  console.log("\nLanes:");
  for (const lane of lanes) {
    const mark = lane.ok ? "✓" : "✗";
    const pad = lane.label.padEnd(labelWidth);
    const hint = !lane.ok && lane.installHint ? ` (install: ${lane.installHint})` : "";
    console.log(`  ${mark} ${pad}  ${lane.detail}${hint}`);
  }

  console.log(`\nCTKR Phase 2+ readiness:`);
  console.log(`  ${ctkrVerdict}   (${ctkrStatus}${scipAvailable ? " if SCIP available" : ""})`);

  if (recommendations.length > 0) {
    console.log(`\nRecommendations:`);
    for (const rec of recommendations) {
      console.log(`  - ${rec}`);
    }
  } else {
    console.log(`\nRecommendations:`);
    console.log("  None — all core lanes are active.");
  }

  console.log();
}
