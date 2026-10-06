// MCP server — wires tool implementations into @modelcontextprotocol/sdk
// over stdio. Designed for Claude Code: one MCP server per stdio session,
// owning one Store, serving one indexed data dir.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { Store } from "../store";
import { LspService } from "../lsp";
import {
  graphNeighbors,
  graphCallers,
  graphImplementers,
  codeSearch,
  graphCypher,
  graphDiff,
  describeApi,
} from "./tools";
import {
  lspHover,
  lspDefinition,
  lspReferences,
  lspDiagnostics,
} from "./lsp-tools";
import { registerCtkrTools } from "./ctkr-tools";
import { gatherIndexState, formatIndexState } from "../index-state";
import type { EdgeKind, TokenKind } from "../store/types";

export interface ServeOpts {
  dataDir: string;
  workspace: string;
}

/**
 * Render a gated GraphAnswer as an MCP tool result. A refusal is marked
 * `isError` so a client cannot read it as data — the whole point of
 * MetaCoding-hy6.16 is that an empty answer from an unfit graph must not be
 * indistinguishable from an empty answer from a fit one.
 */
function answerContent(answer: { ok: boolean }): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(answer, null, 2) }],
    isError: answer.ok === false,
  };
}

export async function serveMcp(opts: ServeOpts): Promise<void> {
  // Read-only: a serving process must coexist with a `metacoding index` running
  // on the same store (ladybugdb's lock excludes only other writers — see
  // scripts/spike-lock.ts). A read-only handle is snapshot-pinned at open time
  // (only a full reopen sees another process's commits — scripts/spike-refresh.ts),
  // so we hold a MUTABLE handle and reopen it when the on-disk graph advances
  // (see currentStore below). That lets serve pick up a completed reindex
  // without a restart.
  let store = await Store.open(opts.dataDir, { readOnly: true });
  let storeGen = Store.generation(opts.dataDir);
  let reopening: Promise<void> | null = null; // dedupe concurrent reopens

  // Return the current read-only Store, reopening first if a writer has
  // checkpointed since we last opened (graph.lbug mtime advanced). Concurrent
  // callers share one reopen; the previous handle is closed only after a grace
  // delay so in-flight calls holding it finish first (avoid use-after-close).
  async function currentStore(): Promise<Store> {
    const gen = Store.generation(opts.dataDir);
    if (gen > storeGen && !reopening) {
      reopening = (async () => {
        const fresh = await Store.open(opts.dataDir, { readOnly: true });
        const old = store;
        store = fresh;
        storeGen = gen;
        setTimeout(() => {
          void old.close().catch(() => {});
        }, 5000);
        console.error(
          `metacoding: store advanced to generation ${gen} — reopened (read-only)`,
        );
      })().finally(() => {
        reopening = null;
      });
    }
    if (reopening) await reopening;
    return store;
  }

  // Index-state observability. stdio transport reserves STDOUT for the JSON-RPC
  // protocol, so every line here MUST go to STDERR — a stray stdout write
  // corrupts the MCP stream.
  const indexState = await gatherIndexState(store, opts.workspace);
  console.error(`metacoding: serving data dir ${opts.dataDir} (read-only)`);
  if (!indexState.indexed) {
    console.error(formatIndexState(indexState));
  }

  const lsp = new LspService({ rootDir: opts.workspace });

  const server = new McpServer(
    { name: "metacoding", version: "0.1.4" },
    { capabilities: { tools: {} } },
  );

  const EDGE_KIND = z.enum([
    "CALLS", "REFERENCES", "EXTENDS", "IMPLEMENTS", "OVERRIDES",
    "INJECTS", "CONTAINS", "IMPORTS", "ANNOTATES", "TYPE_OF",
    "READS_FIELD", "WRITES_FIELD", "RETURNS_TYPE", "CONSTRUCTS", "RAISES",
  ]);
  const TOKEN_KIND = z.enum([
    "literal", "identifier", "comment", "annotation_arg", "config_value",
  ]);

  server.registerTool(
    "graph_callers",
    {
      description:
        "Find symbols that call or reference the given symbol (incoming CALLS/REFERENCES edges). " +
        "Available after a SCIP pass; before that, this returns nothing because Tree-sitter alone can't resolve cross-file references. " +
        "Pass repo_commit_sha to restrict results to one indexed snapshot (omit for no scope filter).",
      inputSchema: {
        symbol: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional(),
        repo_commit_sha: z.string().optional(),
      },
    },
    async (args) => {
      const answer = await graphCallers(await currentStore(), args);
      return answerContent(answer);
    },
  );

  server.registerTool(
    "graph_implementers",
    {
      description:
        "Find symbols that implement or extend the given interface/class (incoming IMPLEMENTS/EXTENDS edges). " +
        "This is the interface-consumer query from the 2026 paper — the thing pure vector search can't do. " +
        "Pass repo_commit_sha to restrict results to one indexed snapshot.",
      inputSchema: {
        symbol: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional(),
        repo_commit_sha: z.string().optional(),
      },
    },
    async (args) => {
      const answer = await graphImplementers(await currentStore(), args);
      return answerContent(answer);
    },
  );

  server.registerTool(
    "graph_neighbors",
    {
      description:
        "Walk one hop from a symbol along typed edges. Use for 'what does this contain', 'what does this extend', 'who calls this'. " +
        "`symbol` accepts either a 16-char Symbol id or a qualified_name. " +
        "Pass repo_commit_sha to restrict results to one indexed snapshot.",
      inputSchema: {
        symbol: z.string().min(1),
        direction: z.enum(["in", "out", "both"]).optional(),
        edge_kinds: z.array(EDGE_KIND).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        repo_commit_sha: z.string().optional(),
      },
    },
    async (args) => {
      const rows = await graphNeighbors(await currentStore(), {
        symbol: args.symbol,
        direction: args.direction,
        edge_kinds: args.edge_kinds as EdgeKind[] | undefined,
        limit: args.limit,
        repo_commit_sha: args.repo_commit_sha,
      });
      return answerContent(rows);
    },
  );

  server.registerTool(
    "code_search",
    {
      description:
        "Full-text search over identifiers, string literals, and comments. Catches AST/SCIP blind spots: string DI, reflection, dynamic dispatch, ORM strings, route paths. " +
        "Query syntax is SQLite FTS5 (supports phrase \"...\", prefix x*, NEAR(a b 5)). " +
        "Pass repo_commit_sha to restrict to one indexed snapshot.",
      inputSchema: {
        query: z.string().min(1),
        kind: TOKEN_KIND.optional(),
        limit: z.number().int().min(1).max(500).optional(),
        repo_commit_sha: z.string().optional(),
      },
    },
    async (args) => {
      const rows = await codeSearch(await currentStore(), {
        query: args.query,
        kind: args.kind as TokenKind | undefined,
        limit: args.limit,
        repo_commit_sha: args.repo_commit_sha,
      });
      return answerContent(rows);
    },
  );

  server.registerTool(
    "graph_cypher",
    {
      description:
        "Escape hatch: run a raw Cypher query against the ladybugdb graph. Prefer typed tools (graph_neighbors, etc.); use this only when no typed tool fits. " +
        "Parameters via $name placeholders; pass values in `params`.",
      inputSchema: {
        cypher: z.string().min(1),
        params: z.record(z.unknown()).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async (args) => {
      const rows = await graphCypher(await currentStore(), {
        cypher: args.cypher,
        params: args.params,
        limit: args.limit,
      });
      return answerContent(rows);
    },
  );

  server.registerTool(
    "graph_diff",
    {
      description:
        "Compare two indexed snapshots of the same repo, returning added / removed / changed Symbol rows. " +
        "`changed` = same qualified_name in both snapshots but different ast_hash. " +
        "Requires both snapshots to coexist in the store — this usually means the repo was indexed with --per-commit-identity. " +
        "Without that, only the most recent snapshot exists and the older one returns empty.",
      inputSchema: {
        repo: z.string().min(1),
        from_sha: z.string().min(1),
        to_sha: z.string().min(1),
        limit: z.number().int().min(1).max(10000).optional(),
        acknowledge_unestablished_fitness: z.boolean().optional(),
      },
    },
    async (args) => {
      const r = await graphDiff(await currentStore(), args);
      return {
        content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
        isError: r.ok === false,
      };
    },
  );

  server.registerTool(
    "describe_api",
    {
      description:
        "Self-describe: returns the live tool list with input schemas, edge kinds, and token kinds. Use first to discover what this server can do.",
      inputSchema: {},
    },
    async () => {
      // Recompute fresh each call so the surface reflects edits since startup.
      const state = await gatherIndexState(await currentStore(), opts.workspace);
      return { content: [{ type: "text", text: JSON.stringify(describeApi(state), null, 2) }] };
    },
  );

  // ---------- LSP tools (live, dirty-buffer-aware) ----------

  server.registerTool(
    "lsp_hover",
    {
      description:
        "Live hover info from the language server: type, signature, docstring. " +
        "Reflects current file content (including unsaved edits made via the LSP didChange path). " +
        "Position is 0-indexed.",
      inputSchema: {
        file: z.string().min(1),
        line: z.number().int().min(0),
        col: z.number().int().min(0),
      },
    },
    async (args) => {
      const r = await lspHover(lsp, opts.workspace, args);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.registerTool(
    "lsp_definition",
    {
      description: "Live go-to-definition from the language server. Position is 0-indexed.",
      inputSchema: {
        file: z.string().min(1),
        line: z.number().int().min(0),
        col: z.number().int().min(0),
      },
    },
    async (args) => {
      const rows = await lspDefinition(lsp, opts.workspace, args);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.registerTool(
    "lsp_references",
    {
      description:
        "Live find-all-references from the language server. Use when graph_callers might be stale (file was edited after indexing). Position is 0-indexed.",
      inputSchema: {
        file: z.string().min(1),
        line: z.number().int().min(0),
        col: z.number().int().min(0),
        include_declaration: z.boolean().optional(),
      },
    },
    async (args) => {
      const rows = await lspReferences(lsp, opts.workspace, args);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.registerTool(
    "lsp_diagnostics",
    {
      description:
        "Current type errors / lints for a file from the language server. Opens the file (didOpen) if not already, then waits up to wait_ms (default 3000) for the first diagnostics push.",
      inputSchema: {
        file: z.string().min(1),
        wait_ms: z.number().int().min(0).max(30000).optional(),
      },
    },
    async (args) => {
      const rows = await lspDiagnostics(lsp, opts.workspace, args);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    },
  );

  // ---------- Structural analysis (ctkr namespace + compatibility aliases) ----------
  registerCtkrTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown — close LSP (kills the typescript-language-server child)
  // and the Store before the process exits.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await lsp.shutdown(); } catch {}
    try { await store.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Exit when the MCP client disconnects (stdin EOF). Well-behaved clients send
  // SIGTERM (handled above), but a client that just closes stdin would otherwise
  // leave serve hanging: once an LSP tool has spawned typescript-language-server,
  // that child keeps the event loop alive forever, and a later hard-kill orphans
  // it. We tear down on stdin end/close, after a short grace so any already-
  // queued responses flush first (the client has stopped sending, so nothing new
  // arrives; an immediate exit here would truncate an in-flight reply the client
  // may still be reading). SIGTERM stays the fast path.
  let disconnecting = false;
  const onDisconnect = () => {
    if (disconnecting) return; // 'end' and 'close' can both fire
    disconnecting = true;
    setTimeout(() => { void shutdown(); }, 1000);
  };
  process.stdin.on("end", onDisconnect);
  process.stdin.on("close", onDisconnect);
}
