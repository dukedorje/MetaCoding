// SCIP symbol-string parser.
//
// SCIP symbol grammar (excerpt; full at https://github.com/sourcegraph/scip):
//
//   <scheme> ' ' <manager> ' ' <name> ' ' <version> ' ' <descriptors>+
//
//   namespace      ::= <name> '/'
//   type           ::= <name> '#'
//   term           ::= <name> '.'
//   method         ::= <name> '(' <disambiguator> ')' '.'
//   type-parameter ::= '[' <name> ']'
//   parameter      ::= '(' <name> ')'
//   meta           ::= <name> ':'
//   macro          ::= <name> '!'
//   local          ::= 'local ' <id>
//
//   <name> = <identifier> | '`' <text> '`'   (backticks may contain spaces / suffix chars)
//
// We don't need to round-trip; we just need enough structure to drive the
// loader: package, descriptors with suffix, and the file path (the first
// namespace descriptor whose name has a recognized source-file extension).

import type { SymbolKind } from "../store/types";
import { scip } from "@sourcegraph/scip-typescript/src/scip.ts";

import { rustSelfTypeName } from "../extractor/rust-names";

export type ScipSuffix =
  | "namespace"
  | "type"
  | "term"
  | "method"
  | "type_parameter"
  | "parameter"
  | "meta"
  | "macro";

export interface ScipDescriptor {
  name: string;
  suffix: ScipSuffix;
  disambiguator?: string;
}

export interface ScipSymbol {
  raw: string;
  scheme: string;
  pkg: { manager: string; name: string; version: string };
  descriptors: ScipDescriptor[];
  isLocal: boolean;
}

export function parseScipSymbol(raw: string): ScipSymbol | null {
  if (!raw) return null;
  if (raw.startsWith("local ")) {
    return {
      raw,
      scheme: "local",
      pkg: { manager: "", name: "", version: "" },
      descriptors: [{ name: raw.slice(6), suffix: "term" }],
      isLocal: true,
    };
  }

  const cursor = { i: 0, src: raw };
  const scheme = readSpaceTerm(cursor);
  const manager = readSpaceTerm(cursor);
  const pkgName = unquote(readSpaceTerm(cursor));
  const version = readSpaceTerm(cursor);
  const descriptors: ScipDescriptor[] = [];
  while (cursor.i < cursor.src.length) {
    const d = readDescriptor(cursor);
    if (!d) break;
    descriptors.push(d);
  }
  return {
    raw,
    scheme,
    pkg: { manager, name: pkgName, version },
    descriptors,
    isLocal: false,
  };
}

interface Cursor { i: number; src: string }

function readSpaceTerm(c: Cursor): string {
  let out = "";
  let inBacktick = false;
  while (c.i < c.src.length) {
    const ch = c.src[c.i]!;
    if (ch === "`") {
      inBacktick = !inBacktick;
      out += ch;
      c.i++;
      continue;
    }
    if (!inBacktick && ch === " ") {
      c.i++;
      return out;
    }
    out += ch;
    c.i++;
  }
  return out;
}

function readDescriptor(c: Cursor): ScipDescriptor | null {
  if (c.i >= c.src.length) return null;
  const first = c.src[c.i];
  // Pure-suffix descriptors.
  if (first === "[") {
    const close = findClose(c.src, c.i, "[", "]");
    const name = unquote(c.src.slice(c.i + 1, close));
    c.i = close + 1;
    return { name, suffix: "type_parameter" };
  }
  if (first === "(") {
    // Standalone (...) before any name = parameter descriptor.
    const close = findClose(c.src, c.i, "(", ")");
    const name = unquote(c.src.slice(c.i + 1, close));
    c.i = close + 1;
    return { name, suffix: "parameter" };
  }
  // Read a name until a terminator.
  const start = c.i;
  let inBacktick = false;
  while (c.i < c.src.length) {
    const ch = c.src[c.i]!;
    if (ch === "`") {
      inBacktick = !inBacktick;
      c.i++;
      continue;
    }
    if (inBacktick) {
      c.i++;
      continue;
    }
    if (ch === "/") {
      const name = unquote(c.src.slice(start, c.i));
      c.i++;
      return { name, suffix: "namespace" };
    }
    if (ch === "#") {
      const name = unquote(c.src.slice(start, c.i));
      c.i++;
      return { name, suffix: "type" };
    }
    if (ch === ":") {
      const name = unquote(c.src.slice(start, c.i));
      c.i++;
      return { name, suffix: "meta" };
    }
    if (ch === "!") {
      // rust-analyzer: `macro_rules! foo` is `foo!`.
      const name = unquote(c.src.slice(start, c.i));
      c.i++;
      return { name, suffix: "macro" };
    }
    if (ch === ".") {
      const name = unquote(c.src.slice(start, c.i));
      c.i++;
      return { name, suffix: "term" };
    }
    if (ch === "(") {
      const name = unquote(c.src.slice(start, c.i));
      const close = findClose(c.src, c.i, "(", ")");
      const disamb = c.src.slice(c.i + 1, close);
      const after = close + 1;
      if (c.src[after] === ".") {
        c.i = after + 1;
        return { name, suffix: "method", disambiguator: disamb };
      }
      // Malformed; treat as term and skip.
      c.i = after;
      return { name, suffix: "term" };
    }
    c.i++;
  }
  return null;
}

function findClose(s: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length - 1;
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith("`") && s.endsWith("`")) return s.slice(1, -1);
  return s;
}

// Heuristic: which descriptor (if any) names a source file.
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mts|cts|py|pyi)$/;

// scip-typescript encodes a path like `src/store/index.ts` as three
// successive namespace descriptors: `src/`, `store/`, `` `index.ts`/``.
// We accumulate leading namespace segments until one matches a source-file
// extension; that joined run is the file path.
export function filePathOf(sym: ScipSymbol): string | null {
  const segments: string[] = [];
  for (const d of sym.descriptors) {
    if (d.suffix !== "namespace") return null;
    segments.push(d.name);
    if (SOURCE_EXT.test(d.name)) return segments.join("/");
  }
  return null;
}

// Build a qualified_name compatible with Tree-sitter's `<file>::<chain>` shape.
// Files: just the file path.
// Members: file path + "::" + each subsequent descriptor name joined by "::".
export function qualifiedNameOf(sym: ScipSymbol): string {
  const filePath = filePathOf(sym);
  if (filePath === null) {
    // Fallback: dot-join descriptor names.
    return sym.descriptors.map((d) => d.name).join(".");
  }
  // Skip past the descriptors that made up the file path.
  const fileSegCount = filePath.split("/").length;
  const tail = sym.descriptors
    .slice(fileSegCount)
    .filter((d) => d.suffix !== "type_parameter" && d.suffix !== "parameter")
    .map((d) => d.name);
  return tail.length === 0 ? filePath : `${filePath}::${tail.join("::")}`;
}

// ---- PHP reconciliation ----
//
// scip-php names symbols by PHP FQN, not file path: e.g. the descriptors of
// `App/Demo#tweak().` are [App (namespace), Demo (type), tweak (method)] with
// NO source-file segment. So filePathOf() returns null and the generic
// qualifiedNameOf() dot-joins to `App.Demo.tweak`, which does not match the
// Tree-sitter lane's `<file>::Class::method` shape.
//
// The file is instead carried per-document (Document.relative_path). Given
// that path, we rebuild the Tree-sitter-compatible qualified_name by dropping
// the namespace-prefix descriptors (the PHP namespace is not part of our qn —
// the extractor walks bodyless `namespace X;` classes under the file node) and
// joining the remaining type/method/term names under the file path. Fields
// carry a leading `$` in SCIP (`$name`) which the Tree-sitter lane strips, so
// we strip it here too.
function phpMeaningfulNames(sym: ScipSymbol): string[] {
  return sym.descriptors
    .filter(
      (d) =>
        d.suffix !== "namespace" &&
        d.suffix !== "type_parameter" &&
        d.suffix !== "parameter",
    )
    .map((d) => (d.name.startsWith("$") ? d.name.slice(1) : d.name));
}

export function phpQualifiedName(sym: ScipSymbol, filePath: string): string {
  const tail = phpMeaningfulNames(sym);
  return tail.length === 0 ? filePath : `${filePath}::${tail.join("::")}`;
}

export function phpShortName(sym: ScipSymbol): string {
  const names = phpMeaningfulNames(sym);
  return names[names.length - 1] ?? shortNameOf(sym);
}

// scip-php derives Document.relative_path from the PSR-4 namespace, not the
// filesystem — e.g. `modules/core/asset/src/Entity/Asset.php` is reported as
// `modules/core/assetEntity/Asset.php` (the `/src/` PSR-4 root is elided). That
// breaks reconciliation with the Tree-sitter lane, which uses real paths.
//
// Given the PSR-4 map used to prepare the repo (namespace-prefix -> dir, e.g.
// `Drupal\asset\` -> `modules/core/asset/src/`), we recover the true file path
// deterministically from the symbol's FQN: longest matching prefix + the
// remaining namespace segments as directories + `<Type>.php`. Drupal (and PSR-4
// generally) guarantees one class per file named after the class, so this is
// exact. Returns null when no prefix matches (fall back to relative_path).
export function phpRealFile(
  sym: ScipSymbol,
  psr4Map: Record<string, string>,
): string | null {
  const nsSegments = sym.descriptors
    .filter((d) => d.suffix === "namespace")
    .map((d) => d.name);
  const typeName = sym.descriptors.find((d) => d.suffix === "type")?.name;
  if (!typeName || nsSegments.length === 0) return null;

  const fqnNs = nsSegments.join("\\") + "\\"; // e.g. "Drupal\asset\Entity\"
  let best: { prefix: string; dir: string } | null = null;
  for (const [prefix, dir] of Object.entries(psr4Map)) {
    if (fqnNs.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, dir };
    }
  }
  if (!best) return null;

  const remainder = fqnNs.slice(best.prefix.length).replace(/\\/g, "/"); // "Entity/"
  const dir = best.dir.endsWith("/") ? best.dir : best.dir + "/";
  return `${dir}${remainder}${typeName}.php`;
}

export function shortNameOf(sym: ScipSymbol): string {
  const meaningful = sym.descriptors.filter(
    (d) => d.suffix !== "type_parameter" && d.suffix !== "parameter",
  );
  const last = meaningful[meaningful.length - 1];
  if (!last) return sym.raw;
  if (last.suffix === "namespace") return last.name.split("/").pop() ?? last.name;
  return last.name;
}

// Map descriptor chain to one of our SymbolKind values.
// scip-typescript v0.4.0 doesn't populate SymbolInformation.kind reliably,
// so we lean on the descriptor suffix.
export function kindOf(sym: ScipSymbol, scipKindHint?: number): SymbolKind {
  const meaningful = sym.descriptors.filter(
    (d) => d.suffix !== "type_parameter" && d.suffix !== "parameter",
  );
  const last = meaningful[meaningful.length - 1];
  const insideType = meaningful.some((d) => d.suffix === "type");

  if (!last) return "function";

  // Whole symbol is just a file path.
  if (last.suffix === "namespace") {
    return SOURCE_EXT.test(last.name) ? "file" : "namespace";
  }
  if (last.suffix === "method") return "method";
  if (last.suffix === "meta") return "type_alias";
  if (last.suffix === "macro") return "function";
  if (last.suffix === "type") {
    // Default to "class"; SCIP doesn't natively distinguish class vs interface in the symbol.
    // SymbolInformation.kind hint can disambiguate when populated.
    if (scipKindHint === 21 /* Interface */) return "interface";
    if (scipKindHint === 11 /* Enum */) return "enum";
    return "class";
  }
  // term suffix: function vs field depending on enclosing.
  if (last.suffix === "term") {
    return insideType ? "field" : "function";
  }
  return "function";
}

// ---- Rust reconciliation (rust-analyzer `scip`) ----
//
// rust-analyzer names symbols by MODULE path inside the crate, not by file:
//
//   rust-analyzer cargo fixture-crate 0.1.0 shapes/Circle#
//   rust-analyzer cargo fixture-crate 0.1.0 shapes/impl#[`Circle<T>`]unit().
//   rust-analyzer cargo fixture-crate 0.1.0 impl#[Person][Greeter]greet().
//   rust-analyzer cargo fixture-crate 0.1.0 inner/helper().      (inline `mod inner {}`)
//
// The file is carried per-document (Document.relative_path), and each file
// module's own symbol is DEFINED in that document over the whole file (range
// starting at 0:0) — `crate/` for a crate root, `shapes/` for src/shapes.rs.
// That definition gives the document's module prefix. Stripping it leaves
// exactly what the Tree-sitter lane nests under the file: inline modules, the
// type, and the member. Impl members are rewritten from `impl#[Self][Trait]m`
// to `Self::m`, the same self-type reduction the Tree-sitter lane applies
// (src/extractor/rust-names.ts), so both lanes produce one id.

/** Module-path names a file-module symbol contributes as a prefix. The crate
 *  root's `crate/` names no prefix: its items are `Greeter#`, not `crate/Greeter#`. */
export function rustModulePrefix(sym: ScipSymbol): string[] {
  const names = sym.descriptors.map((d) => d.name);
  return names.length === 1 && names[0] === "crate" ? [] : names;
}

/** True when every descriptor is a namespace (a module symbol). */
export function isRustModuleSymbol(sym: ScipSymbol): boolean {
  return sym.descriptors.length > 0 && sym.descriptors.every((d) => d.suffix === "namespace");
}

/** The Tree-sitter-shaped name chain under the file, given the document's
 *  module prefix. Inline modules stay; impl blocks collapse to their self type. */
export function rustNameChain(sym: ScipSymbol, prefix: string[]): string[] {
  const ds = sym.descriptors;
  let i = 0;
  while (i < prefix.length && i < ds.length && ds[i]!.suffix === "namespace" && ds[i]!.name === prefix[i]) i++;
  const out: string[] = [];
  for (; i < ds.length; i++) {
    const d = ds[i]!;
    if (d.suffix === "parameter" || d.suffix === "type_parameter") continue;
    if (d.suffix === "type" && d.name === "impl") {
      // impl#[Self] or impl#[Self][Trait] — the self type is the first bracket.
      const selfTp = ds[i + 1];
      if (selfTp?.suffix === "type_parameter") {
        out.push(rustSelfTypeName(selfTp.name));
        i++;
        while (ds[i + 1]?.suffix === "type_parameter") i++;
      }
      continue;
    }
    out.push(d.name);
  }
  return out;
}

export function rustQualifiedName(sym: ScipSymbol, filePath: string, prefix: string[]): string {
  const chain = rustNameChain(sym, prefix);
  return chain.length === 0 ? filePath : `${filePath}::${chain.join("::")}`;
}

/** For `impl#[Self][Trait]member`, the reduced self and trait names. */
export function rustImplOf(sym: ScipSymbol): { self: string; trait: string | null; member: string } | null {
  const ds = sym.descriptors;
  const at = ds.findIndex((d) => d.suffix === "type" && d.name === "impl");
  if (at < 0 || ds[at + 1]?.suffix !== "type_parameter") return null;
  const self = rustSelfTypeName(ds[at + 1]!.name);
  const traitTp = ds[at + 2]?.suffix === "type_parameter" ? ds[at + 2]!.name : null;
  const member = ds.slice(at + 1).find((d) => d.suffix !== "type_parameter" && d.suffix !== "parameter");
  if (!member) return null;
  return { self, trait: traitTp ? rustSelfTypeName(traitTp) : null, member: member.name };
}

// rust-analyzer fills SymbolInformation.kind reliably, so it leads; the
// descriptor shape is the fallback.
const K = scip.SymbolInformation.Kind;
const RUST_KIND: Partial<Record<number, SymbolKind>> = {
  [K.Module]: "module",
  [K.Struct]: "class",
  [K.Union]: "class",
  [K.Enum]: "enum",
  [K.EnumMember]: "field", // a variant — the Tree-sitter lane's kind for it
  [K.Trait]: "interface",
  [K.Field]: "field",
  [K.Function]: "function",
  [K.Macro]: "function",
  [K.Method]: "method",
  [K.StaticMethod]: "method",
  [K.TraitMethod]: "method",
  [K.TypeAlias]: "type_alias",
  [K.AssociatedType]: "type_alias",
  [K.Constant]: "field",
  [K.StaticVariable]: "field",
  [K.Variable]: "field",
};

export function rustKindOf(sym: ScipSymbol, scipKindHint?: number): SymbolKind {
  const hinted = scipKindHint ? RUST_KIND[scipKindHint] : undefined;
  if (hinted) return hinted;
  const meaningful = sym.descriptors.filter(
    (d) => d.suffix !== "type_parameter" && d.suffix !== "parameter",
  );
  const last = meaningful[meaningful.length - 1];
  if (!last) return "function";
  const owners = meaningful.slice(0, -1);
  const insideType = owners.some((d) => d.suffix === "type");
  switch (last.suffix) {
    case "namespace": return "module";
    case "method": return insideType ? "method" : "function";
    case "macro": return "function";
    case "meta": return "type_alias";
    case "type": return insideType ? "field" : "class"; // nested type = enum variant
    default: return "field"; // fields, consts, statics
  }
}

export function rustShortName(sym: ScipSymbol, prefix: string[]): string {
  const chain = rustNameChain(sym, prefix);
  return chain[chain.length - 1] ?? shortNameOf(sym);
}
