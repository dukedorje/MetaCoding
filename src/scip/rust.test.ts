// The Rust SCIP lane against REAL rust-analyzer output.
//
// fixtures/rust-crate/index.scip was produced by
//   rust-analyzer scip src/scip/fixtures/rust-crate --output index.scip
// (rust-analyzer 1.96.0) over the sources beside it. The test needs no
// rust-analyzer: it pins what the loader makes of that output, and — the point
// of the lane — that SCIP ids land on the SAME ids the Tree-sitter lane writes
// for the same files, so SCIP edges attach to tree-sitter nodes.

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadScip } from "./loader.ts";
import { parseScipSymbol, rustQualifiedName, rustKindOf } from "./symbol.ts";
import { rustSelfTypeName } from "../extractor/rust-names.ts";
import { makeParser, type TsParser } from "../extractor/parser.ts";
import { extractStructural } from "../extractor/structural.ts";
import { issueIngestTicket } from "../ingest/ticket.ts";
import type { Edge, Symbol } from "../store/types.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "rust-crate");
const REPO = "rust-fixture";
const OPTS = {
  ticket: issueIngestTicket({ repo: REPO, branch: "main", runStamp: "rust-test" }),
  branch: "main",
  repo: REPO,
  language: "rs" as const,
};

function captureStore() {
  const symbols: Symbol[] = [];
  const edges: Edge[] = [];
  const store = {
    async upsertSymbol(s: Symbol) { symbols.push(s); },
    async addEdge(e: Edge) { edges.push(e); },
    async fileHash() { return null; },
    async deleteFileData() {},
    writeTokens() {},
  } as unknown as Parameters<typeof loadScip>[0];
  return { symbols, edges, store };
}

let scipSyms: Symbol[];
let scipEdges: Edge[];
let rust: TsParser;

beforeAll(async () => {
  const c = captureStore();
  await loadScip(c.store, join(FIXTURE, "index.scip"), OPTS);
  scipSyms = c.symbols;
  scipEdges = c.edges;
  rust = await makeParser("rust");
});

const qnOf = (id: string) => scipSyms.find((s) => s.id === id)?.qualified_name ?? `?${id}`;
const edgesOf = (kind: string) =>
  scipEdges.filter((e) => e.kind === kind).map((e) => `${qnOf(e.src_id)} -> ${qnOf(e.dst_id)}`);

describe("rust-analyzer SCIP → Tree-sitter-shaped names", () => {
  test("module-path symbols are rebuilt under the real file", () => {
    const byQn = new Map(scipSyms.map((s) => [s.qualified_name, s.kind]));
    expect(Object.fromEntries(byQn)).toMatchObject({
      "src/lib.rs": "file",
      "src/lib.rs::Greeter": "interface",
      "src/lib.rs::Greeter::greet": "method",
      "src/lib.rs::Person": "class",
      "src/lib.rs::Person::name": "field",
      "src/lib.rs::Person::new": "method",
      "src/lib.rs::run": "function",
      "src/lib.rs::inner": "module",
      "src/lib.rs::inner::helper": "function",
      "src/shapes.rs": "file",
      "src/shapes.rs::Kind": "enum",
      "src/shapes.rs::Kind::Round": "field",
      "src/shapes.rs::Circle": "class",
      "src/shapes.rs::Circle::r": "field",
      "src/shapes.rs::Circle::unit": "method",
      "src/shapes.rs::Circle::greet": "method",
      "src/shapes.rs::Radius": "type_alias",
      "src/shapes.rs::area": "function",
      "src/shapes.rs::MAX_SIDES": "field",
      "src/shapes.rs::twice": "function",
    });
    // Trait impl member hangs off the self type, never the trait.
    expect(byQn.get("src/lib.rs::Greeter::greet")).toBe("method");
    expect([...byQn.keys()].some((q) => q.includes("impl"))).toBe(false);
  });

  test("every Tree-sitter declaration in the fixture has the same id in the SCIP lane", () => {
    const scipIds = new Set(scipSyms.map((s) => s.id));
    const missing: string[] = [];
    for (const file of ["src/lib.rs", "src/shapes.rs"]) {
      const tree = rust.parse(readFileSync(join(FIXTURE, file), "utf-8"));
      const ex = extractStructural(tree, { filePath: file, grammar: "rust", branch: "main", repo: REPO });
      tree.delete();
      for (const s of ex.symbols) if (!scipIds.has(s.id)) missing.push(s.qualified_name);
    }
    // The one tree-sitter node with no SCIP twin: the bodyless `pub mod shapes;`
    // declaration. rust-analyzer defines that module in src/shapes.rs, where it
    // is the file symbol; in lib.rs it is only a reference (lib.rs -> shapes.rs).
    expect(missing).toEqual(["src/lib.rs::shapes"]);
    expect(edgesOf("REFERENCES")).toContain("src/lib.rs -> src/shapes.rs");
  });

  test("calls and references attribute to the enclosing definition, across files", () => {
    const calls = edgesOf("CALLS");
    expect(calls).toContain("src/lib.rs::run -> src/lib.rs::Person::new");
    expect(calls).toContain("src/lib.rs::run -> src/shapes.rs::Circle::unit");
    expect(calls).toContain("src/lib.rs::run -> src/lib.rs::inner::helper");
    expect(calls).toContain("src/lib.rs::run -> src/shapes.rs::area");
    expect(calls).toContain("src/lib.rs::run -> src/lib.rs::Person::greet");
    expect(calls).toContain("src/shapes.rs::doubled -> src/shapes.rs::twice");
    expect(edgesOf("REFERENCES")).toContain("src/shapes.rs::area -> src/shapes.rs::Circle::r");
  });

  test("Rust type references are REFERENCES, not CONSTRUCTS", () => {
    expect(edgesOf("CONSTRUCTS")).toEqual([]);
    expect(edgesOf("REFERENCES")).toContain("src/lib.rs::Person::new -> src/lib.rs::Person");
  });

  test("trait impls become IMPLEMENTS at type and member level", () => {
    const impls = edgesOf("IMPLEMENTS");
    expect(impls).toContain("src/lib.rs::Person -> src/lib.rs::Greeter");
    expect(impls).toContain("src/shapes.rs::Circle -> src/lib.rs::Greeter");
    expect(impls).toContain("src/lib.rs::Person::greet -> src/lib.rs::Greeter::greet");
    expect(impls).toContain("src/shapes.rs::Circle::greet -> src/lib.rs::Greeter::greet");
  });
});

describe("rust symbol helpers", () => {
  test("self-type reduction", () => {
    expect(rustSelfTypeName("Circle<T>")).toBe("Circle");
    expect(rustSelfTypeName("&'a mut Person")).toBe("Person");
    expect(rustSelfTypeName("crate::shapes::Circle<f64>")).toBe("Circle");
    expect(rustSelfTypeName("dyn Greeter")).toBe("Greeter");
    expect(rustSelfTypeName("Box<dyn Greeter>")).toBe("Box");
  });

  test("a symbol outside the document's module keeps its full module chain", () => {
    const sym = parseScipSymbol("rust-analyzer cargo c 0.1.0 a/b/Foo#bar().")!;
    expect(rustQualifiedName(sym, "src/a/b.rs", ["a", "b"])).toBe("src/a/b.rs::Foo::bar");
    expect(rustQualifiedName(sym, "src/a.rs", ["a"])).toBe("src/a.rs::b::Foo::bar");
    expect(rustKindOf(sym)).toBe("method");
  });

  test("descriptor fallback kinds when SymbolInformation.kind is absent", () => {
    const k = (s: string) => rustKindOf(parseScipSymbol(`rust-analyzer cargo c 0.1.0 ${s}`)!);
    expect(k("run().")).toBe("function");
    expect(k("Kind#Round#")).toBe("field");
    expect(k("Kind#")).toBe("class");
    expect(k("twice!")).toBe("function");
    expect(k("inner/")).toBe("module");
  });
});
