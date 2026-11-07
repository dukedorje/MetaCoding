// Structural extractor for the languages naoms ships beside TypeScript:
// JavaScript, Rust, Kotlin, and Swift.
//
// Phase-1 scope, same as the Python lane: file plus the declarations a
// tree-sitter walk can name (class/struct, interface/trait/protocol, enum,
// function, method, field, module, type alias), CONTAINS edges, and identifier
// / literal / comment tokens. Behavior edges stay with the language-specific
// passes. SCIP, where an indexer exists, fills CALLS / REFERENCES later.

import type Parser from "web-tree-sitter";

import type { Edge, Symbol, SymbolKind, TokenRow, Visibility } from "../store/types";
import { symbolId } from "./identity";
import { rustSelfTypeName } from "./rust-names";

type Tree = Parser.Tree;
type Node = Parser.SyntaxNode;

export type StructuralGrammar = "javascript" | "rust" | "kotlin" | "swift";
type Lang = "js" | "rs" | "kt" | "swift";

const LANG: Record<StructuralGrammar, Lang> = {
  javascript: "js",
  rust: "rs",
  kotlin: "kt",
  swift: "swift",
};

export interface ExtractResult {
  symbols: Symbol[];
  edges: Edge[];
  tokens: TokenRow[];
}

export interface ExtractStructuralOpts {
  filePath: string;
  grammar: StructuralGrammar;
  branch: string;
  repo: string;
  repo_commit_sha?: string | null;
  indexed_at?: string | null;
  perCommitIdentity?: boolean;
}

const IDENT_TYPES = new Set([
  "identifier",
  "type_identifier",
  "simple_identifier",
  "property_identifier",
]);

export function extractStructural(tree: Tree, opts: ExtractStructuralOpts): ExtractResult {
  const result: ExtractResult = { symbols: [], edges: [], tokens: [] };
  const fileSym = makeFileSymbol(opts);
  result.symbols.push(fileSym);
  walk(tree.rootNode, fileSym, fileSym.qualified_name, false, result, opts);
  return result;
}

function makeFileSymbol(opts: ExtractStructuralOpts): Symbol {
  const language = LANG[opts.grammar];
  return {
    id: symbolId(language, opts.repo, opts.filePath, idScopeSha(opts)),
    kind: "file",
    language,
    repo: opts.repo,
    qualified_name: opts.filePath,
    short_name: opts.filePath.split("/").pop() ?? opts.filePath,
    file: opts.filePath,
    line: 0,
    col: 0,
    end_line: 0,
    end_col: 0,
    signature: null,
    visibility: null,
    is_abstract: false,
    is_static: false,
    ast_hash: null,
    branch: opts.branch,
    source: "tree_sitter",
    repo_commit_sha: opts.repo_commit_sha ?? null,
    indexed_at: opts.indexed_at ?? null,
  };
}

function walk(
  node: Node,
  parent: Symbol,
  parentQn: string,
  insideType: boolean,
  result: ExtractResult,
  opts: ExtractStructuralOpts,
): void {
  collectTokens(node, parent.id, opts, result.tokens);

  // An impl block is not its own symbol. Methods hang off the type name so
  // `impl Foo { fn new }` lands at `file.rs::Foo::new` next to `struct Foo`.
  // The self type is the `type` field: in `impl Greeter for Person` the first
  // type_identifier is the TRAIT, and in `impl<T> Circle<T>` there is no bare
  // type_identifier child at all (it is a generic_type).
  if (opts.grammar === "rust" && node.type === "impl_item") {
    const selfType = node.childForFieldName("type")?.text;
    const typeName = selfType ? rustSelfTypeName(selfType) || undefined : undefined;
    const qn = typeName ? `${parentQn}::${typeName}` : parentQn;
    const typeSym = result.symbols.find((s) => s.qualified_name === qn) ?? parent;
    for (const child of node.namedChildren) {
      walk(child, typeSym, qn, true, result, opts);
    }
    return;
  }

  const decl = recognize(node, opts.grammar, insideType);
  if (decl) {
    const language = LANG[opts.grammar];
    const qn = `${parentQn}::${decl.short}`;
    const sym: Symbol = {
      id: symbolId(language, opts.repo, qn, idScopeSha(opts)),
      kind: decl.kind,
      language,
      repo: opts.repo,
      qualified_name: qn,
      short_name: decl.short,
      file: opts.filePath,
      line: node.startPosition.row,
      col: node.startPosition.column,
      end_line: node.endPosition.row,
      end_col: node.endPosition.column,
      signature: null,
      visibility: visibilityOf(node, opts.grammar),
      is_abstract: false,
      is_static: false,
      ast_hash: null,
      branch: opts.branch,
      source: "tree_sitter",
      repo_commit_sha: opts.repo_commit_sha ?? null,
      indexed_at: opts.indexed_at ?? null,
    };
    result.symbols.push(sym);
    result.edges.push({ src_id: parent.id, dst_id: sym.id, kind: "CONTAINS" });
    const childInside = decl.kind === "class" || decl.kind === "interface" || decl.kind === "enum" || decl.kind === "module";
    for (const child of node.namedChildren) {
      walk(child, sym, qn, childInside, result, opts);
    }
    return;
  }

  for (const child of node.namedChildren) {
    walk(child, parent, parentQn, insideType, result, opts);
  }
}

function recognize(
  node: Node,
  grammar: StructuralGrammar,
  insideType: boolean,
): { kind: SymbolKind; short: string } | null {
  const name = identOf(node);
  switch (grammar) {
    case "javascript":
      switch (node.type) {
        case "class_declaration":
          return name ? { kind: "class", short: name } : null;
        case "function_declaration":
        case "generator_function_declaration":
          return name ? { kind: insideType ? "method" : "function", short: name } : null;
        case "method_definition":
          return name ? { kind: "method", short: name } : null;
        case "field_definition":
        case "public_field_definition":
          return name ? { kind: "field", short: name } : null;
        default:
          return null;
      }
    case "rust":
      switch (node.type) {
        case "struct_item":
        case "union_item":
          return name ? { kind: "class", short: name } : null;
        case "enum_item":
          return name ? { kind: "enum", short: name } : null;
        case "trait_item":
          return name ? { kind: "interface", short: name } : null;
        case "function_item":
        case "function_signature_item":
          return name ? { kind: insideType ? "method" : "function", short: name } : null;
        case "field_declaration":
        case "enum_variant":
          return name ? { kind: "field", short: name } : null;
        case "type_item":
          return name ? { kind: "type_alias", short: name } : null;
        case "mod_item":
          return name ? { kind: "module", short: name } : null;
        default:
          return null;
      }
    case "kotlin":
      switch (node.type) {
        case "class_declaration":
        case "object_declaration": {
          if (!name) return null;
          const kw = keywordOf(node);
          if (kw === "interface") return { kind: "interface", short: name };
          if (kw === "enum") return { kind: "enum", short: name };
          return { kind: "class", short: name };
        }
        case "function_declaration":
          return name ? { kind: insideType ? "method" : "function", short: name } : null;
        case "property_declaration":
        case "class_parameter":
          return name ? { kind: "field", short: name } : null;
        default:
          return null;
      }
    case "swift":
      switch (node.type) {
        case "class_declaration": {
          if (!name) return null;
          return { kind: keywordOf(node) === "enum" ? "enum" : "class", short: name };
        }
        case "protocol_declaration":
          return name ? { kind: "interface", short: name } : null;
        case "function_declaration":
        case "protocol_function_declaration":
          return name ? { kind: insideType ? "method" : "function", short: name } : null;
        case "property_declaration":
        case "enum_entry":
          return name ? { kind: "field", short: name } : null;
        default:
          return null;
      }
  }
}

function identOf(node: Node): string | null {
  const named = node.childForFieldName("name");
  if (named && named.text.length > 0) return named.text;
  for (const child of node.namedChildren) {
    if (IDENT_TYPES.has(child.type) && child.text.length > 0) return child.text;
    if (child.type === "pattern" || child.type === "value_binding_pattern") {
      const inner = identOf(child);
      if (inner) return inner;
    }
  }
  return null;
}

function keywordOf(node: Node): string | null {
  for (const child of node.children) {
    if (!child.isNamed && child.text.length > 0 && child.text !== "{" && child.text !== "(") {
      return child.text;
    }
  }
  return null;
}

function visibilityOf(node: Node, grammar: StructuralGrammar): Visibility | null {
  if (grammar !== "rust") return null;
  const hasPub = node.children.some((c) => c.type === "visibility_modifier" || c.text === "pub");
  return hasPub ? "public" : "private";
}

function idScopeSha(opts: ExtractStructuralOpts): string | undefined {
  return opts.perCommitIdentity ? opts.repo_commit_sha ?? undefined : undefined;
}

function collectTokens(
  node: Node,
  symId: string,
  opts: ExtractStructuralOpts,
  out: TokenRow[],
): void {
  const base = {
    file: opts.filePath,
    repo: opts.repo,
    line: node.startPosition.row,
    col: node.startPosition.column,
    symbol_id: symId,
  };
  if (IDENT_TYPES.has(node.type)) {
    out.push({ ...base, text: node.text, kind: "identifier" });
    return;
  }
  if (node.type === "string_content" || node.type === "line_string_content" || node.type === "string_literal") {
    // string_literal often wraps content; record the leaf content only.
    if (node.type !== "string_literal" || node.namedChildren.length === 0) {
      out.push({ ...base, text: node.text, kind: "literal" });
    }
    return;
  }
  if (node.type === "comment" || node.type === "line_comment" || node.type === "block_comment") {
    out.push({ ...base, text: node.text, kind: "comment" });
  }
}
