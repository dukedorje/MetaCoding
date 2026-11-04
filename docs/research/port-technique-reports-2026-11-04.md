# Port technique reports — 2026-11-04

Notes for the decomposition loop ([`../design/decomposition-loop.md`](../design/decomposition-loop.md)). Each report says what the work actually contributes and how it plugs into the seven documents and the Ladybug graph. None of these replace the farmOS measurements in [`../design/where-the-techniques-shine.md`](../design/where-the-techniques-shine.md).

## REA — morluto/rea

**What it is.** An MCP and CLI for reverse engineering when you may not have a normal source project: native binaries through Hopper, Ghidra, IDA, or Kuna; JavaScript and Electron application graphs; .NET; websites. Analysis runs locally. The unit of result is an Evidence record with an id, a digest, limitations, and residual unknowns. MIT license. Setup is `npx rea-agents setup`, and current docs say Grok Build is a supported agent. Official sources are the GitHub repo `morluto/rea`, `rea.tools`, and the `rea-agents` npm package.

**What is worth taking.**

- **Authority is a field, not a tone.** Static observation, static inference, runtime observation, and unknown stay distinct. A missing graph is not an empty graph. Comparison refuses equality when coverage is partial. That is the same rule as our extractor-gap rule, written as a schema. Every `Feature`, `Scenario`, `Effect`, and `Warning` row carries `authority` and a coverage declaration.
- **Two graphs, one digest.** `analyze_javascript_application` keeps a structural application graph and a separate semantic relation graph, bound to the same artifact digest. Semantic tracing reports when the semantic graph is absent. This is the right split for effects. Structure decides islands. The semantic graph records reads, writes, spreads, closure capture, unique local calls, argument and return flow, Promise and await, EventEmitter, timers, `child_process`, request and response, parse and validation boundaries, and resource acquire/release. Effects do not pretend to be `CALLS`.
- **Mutation is conservative.** Explicit assignment, update, and delete are tracked. Calls that receive a mutable reference invalidate exact post-state instead of inventing it. `conditional: true` marks uncertain operands. Dynamic edges are off unless the caller opts in, and the trace status becomes `partial` when a relevant unknown exists. Our `EFFECT.confidence` uses the same three values: `resolved`, `candidate`, `unknown`.
- **Feature trace from a typed seed.** `trace_application_feature` seeds on a node id, route, string, API, IPC channel, module, or native export, then returns the reachable subgraph, terminal paths, and native handoffs. Containment does not fan out into every sibling of a shared root. That is the hydrate step for one D1 feature. We implement it as Cypher over Ladybug, seeded by the feature's exports, stopping at `SEAM` edges.
- **Fingerprints ignore local names.** A function fingerprint commits normalized syntax, control-flow shape, relation shape, literal sets, arity, and detected effects. Names and offsets stay out. Duplicate fingerprints stay ambiguous. This is a useful extra dimension on structural profiles when a TypeScript name and a Rust name are not the same string. It is not behavioral equivalence, and REA says so.
- **Version pairing is tiered.** Exact content digest, then module digest, then node identity, then source-map, then structural fingerprint, then a semantic key. A lower tier never overrides a unique higher match. Fuzzy names are not identity. Relocation alone is `unknown` when coverage is incomplete. The port verifier should pair island symbols to crate symbols the same way, and leave the rest unpaired.
- **Unknowns are a ledger.** Residual questions have ids and revisions. An empty registry does not mean the evidence has no open questions. D7 warnings should be records with ids, not a paragraph that the next session drops.

**What we do not take.**

- REA's pitch is: see a feature in an app, explain it, build a version in your project. That collapses the clean room. Evidence may inform the spec desk. It does not enter the Rust room, and REA does not write NAOMS code.
- The native half (disassembly, call graphs from a provider, binary layout) is for the existing `libnaoms_core` dylib only if we ever trace a FFI boundary. It is not the port method.
- We do not make REA the system of record. Ladybug already traverses the indexed tree. REA's session evidence bundle is a different store, sized for one application analysis, with per-file admission budgets. Pointing it at `src/packages` (on the order of thirty thousand TypeScript files) is a spike at most, on one package, after the structural island is chosen.
- We do not install the REA MCP into the NAOMS clean-room sessions.

**Integration, concrete.** A later semantic lane may shell out to `rea analyze-javascript-application` on one island's file set and project its semantic relations into `EFFECT` edges with `authority=semantic`. Until that spike, SCIP `WRITES_FIELD` / `READS_FIELD` / `RAISES` are the only resolved effects, and name-matched calls (`fetch`, `Deno.write`, `spawn`) are candidates. The unknown ledger is a `Warning` node, not a REA dependency.

## ASNER — architecture recovery with evidence-grounded refinement

**Source.** Wenhao Wang et al., arXiv 2610.36894, submitted 2026-10-27. "ASNER: Software Architecture Recovery with Adaptive Semantic Neighborhoods and Evidence-Grounded Refinement."

**What it claims.** Unconstrained LLM refinement moves files that were already in the right component. ASNER derives file responsibilities with a model, builds semantic neighborhoods that adapt to repo size and to the local similarity distribution, adds those relations plus a weak directory cue to a static dependency graph, runs community detection, then lets a Responsibility-Ownership-Aware agent revisit only uncertain boundary files. A move needs project-level responsibilities and traceable code. On 12 projects (C, C++, Java, Python) they report gains over GAER-GAT on ARI and a cluster-to-cluster metric.

**How we use it.** This is Stage A of subsystem extraction, with a guard we already believe. Louvain on typed edges remains the cut. Semantic neighborhood edges may be added at low weight, the same way the directory prior is low weight, and they are stored as their own relation so a later pass can drop them. The refinement agent may propose a membership change only for symbols with `boundary_confidence < 1`, and the proposal is a `Warning` or a candidate `MEMBER_OF` with `authority=llm` until a person accepts it. It does not write the frozen partition. Their negative result is the rule: a model that can relabel freely makes the carve worse.

**Gap.** Their benchmark is not a dependency-injected TypeScript monolith, and it scores recovery against a known architecture. We do not have that ground truth for NAOMS. Persistence across the resolution sweep is our substitute for their labeled ARI until the Rust crate exists as a second instance.

## SemArc — semantics plus implicit dependencies

**Source.** IEEE Transactions on Software Engineering, 2026. "Software Architecture Recovery Augmented With Semantics." Evaluated on 15 systems in C, C++, Java, and Python against seven baselines; the write-up claims about 32 points of average improvement and an ablation over code semantics, architectural semantics, and implicit dependencies.

**What it claims.** Clustering that uses only explicit dependencies misses architecture because names, comments, and implicit coupling carry component boundaries. SemArc uses a model for implementation-level and architecture-level semantics, a catalog of canonical architectural patterns, both implicit and explicit dependencies, and clustering guided by component anchors.

**How we use it.** Anchors are our declarative features: a Rust crate, a spec module, a tool name in `feature-registry`, a route. Pass 1 clusters around those anchors instead of trusting a single global Louvain cut of the whole NAOMS graph. Implicit dependencies are candidate edges (shared string keys, registry names, effect targets), `authority` marked, weight below SCIP `CALLS` and `IMPORTS`. The pattern catalog may suggest a glossary line ("this shape looks like a registry"). It does not name the island. Architectural semantics are the D2 glossary and the one-line feature intent, written after the cut.

**Gap.** A pattern catalog pulls names back into the partition if we are careless. The two-stage rule holds: semantics annotate, they do not recut, except as a low-weight edge stream we can ablate.

## SemRef — refine a recovery, do not start from the model

**Source.** IEEE/ACM ICSE 2026. "Semantic-Enhanced Automatic Refinement of Architecture Recovery Results Using LLMs." arXiv 2607.23774. SemRef takes modules already produced by an existing recovery tool and refines them with dependency facts plus a model. It also emits a module hierarchy and hierarchical summaries.

**What it claims.** Practitioners already run recovery tools and then spend their time fixing the result. The model is more useful as a refiner with dependencies in the loop than as the recovery itself. Summaries make the recovered modules readable.

**How we use it.** SemRef is the intention pass, scoped to a frozen subsystem. Input is `subsystems.parquet` (or the Ladybug `Subsystem` nodes) plus crossing edges. Output is a purpose line, a glossary fragment, and a hierarchy `Feature → Subsystem → role`. Summaries cite symbol ids. A summary with no citation is dropped. Hierarchy is a rendering for the spec desk, not a new clustering.

**Gap.** ICSE's evaluation is about agreement with an architect's decomposition. Our bar is different: does the summary tell a re-implementer what value is delivered, and do the scenarios still pass against the source. A fluent summary that fails that test is the farmOS brief result again.

## ArchAgent — segmented reading of a large legacy tree

**Source.** Rusheng Pan, Bingcheng Mao, Tianyi Ma, Zhenhua Ling. arXiv 2601.13007, 2026-01-19. "ArchAgent: Scalable Legacy Software Architecture Recovery with LLMs."

**What it claims.** Whole-repo prompts fail because of architectural drift, missing relations, and context limits. ArchAgent combines static analysis, adaptive code segmentation, and model synthesis to produce multi-view architectures, including a business-aligned view that uses cross-repository and DevOps-style signals to mark modules that matter.

**How we use it.** Segmentation is how NAOMS is allowed to meet a model at all. SCIP and semantic lanes run per island or per package slice, off to the side of the repo, never as one `infer-tsconfig` of the whole tree. The business-aligned view is not a second architecture: rank D1 features by seam degree, test-file count, and whether a spec module already exists. Cross-repository, for us, means the TypeScript tree and `naoms-rust` in one MetaCoding store so alignment can run after a crate is real. We do not adopt their diagram output as the artifact. The artifact is the seven node types.

**Gap.** DevOps heuristics (change frequency, owners, deploy units) need a git lane. That lane stays optional, as in the port-loop plan, and commit subjects are intention evidence, not partition input.

## Microsoft — feature-sized migration, held-out differentials, specs that travel

**Source.** "Cheap code, precious trust: Code modernization at scale," Microsoft command line, 2026-10-26. Case studies include the Windows toolchain move to Clang/LLVM, analyzer remediation, and x86 to ARM. The language-modernization narrative runs from generated Rust that did not compile (January 2025), to code that compiled and misbehaved (June 2025), to about 30,000 lines translated with manual guidance (September 2025), to broader automation (February 2026).

**What it claims.** Line-by-line translation loses. A feature is a unit of user-visible behavior with a scenario test and its own gate. Differential tests compare source and target. Tests held out from the agent measure whether the translation overfit. They extract specifications from the source, carry them into the target, and have started using Verus to prove the modernized code meets them. The surrounding point is that agents outrun review, so the spec and the held-out test are the constraint.

**How we use it.** This is the acceptance spine we already chose, stated by someone running a larger rewrite. D4 scenarios are the feature gate. A `holdout` flag on `Scenario` keeps those cases out of the build packet. Differential runs are two observations attached to the same scenario, source and target. The staged history matches the cheap tier: one island, guided, before any fan-out. Verus, if it ever happens, is for a handful of kernel invariants (crypto, chain, keys), not for the 7711 `INV-*` ids already written. Most of those sentences are not proof obligations.

**Gap.** Their migrations are often behavior-preserving ports inside one operational lineage. NAOMS is allowed to diverge (store, transport, ownership). Divergences are port decisions with waivers, not differential failures. The differential oracle covers the value that was kept.

## Concepts and synchronizations — Jackson, MIT CSAIL

**Source.** Daniel Jackson and coauthors, MIT CSAIL, reported November 2025. Software is decomposed into concepts, each with one job, and synchronizations, explicit rules for how concepts interact. A small DSL for synchronizations is aimed at generation by models. A case study pulls together behavior that had been scattered across services.

**What it claims.** A module boundary that mixes jobs stays hard for people and for models. A concept is independently understandable. A synchronization is the contract that was previously implicit in the glue. Written that way, the interaction is something a model can generate without inventing the coupling.

**How we use it.** D1 features should be concepts: one job. A spec module that is a grab bag (the size of `mod-quality` at 2120 lines, or `mod-packages` at 1577) is not yet a feature; the carve splits it until the job is singular. D6 seam rows are synchronizations. The useful rendering is a rule in glossary words ("when a contact is introduced, the hive membership projection updates"), backed by the crossing symbols and the effects, not only by an edge count. Composition patterns (`path`, `fan_in`) are the structural evidence under that rule. The DSL is a desk rendering. The clean room still receives invariants and acceptance tests, not a new language.

**Gap.** Concept design is a forward method. We are recovering concepts from a vibe-coded tree. The recovery can propose a concept and a synchronization. It cannot pretend the source was written that way. The disagreement between the concept and the island is a D7 warning.

## Spec Kit, Kiro, and OpenSpec

**Sources.** GitHub Spec Kit (spec-driven flow, documented as Specify → Plan → Tasks → Implement → Converge, with a constitution step). AWS Kiro specs: `requirements.md` in EARS ("when … the system shall …"), `design.md`, `tasks.md` under `.kiro/specs/<name>/`. OpenSpec (Fission): a change is a delta (`propose` → `apply` → `archive`) folded into a living `specs/` tree, meant for brownfield, one change at a time. Surveys in 2026 group these with Tessl as the "spec is the source of truth" tools.

**What they contribute.** A shared sequence: name the behavior, then plan, then tasks, then implement, and keep the spec after the code lands. EARS is a constrained given/when/then. OpenSpec's archive is the same idea as intention's fold into living specs. All of them assume a person already knows which feature they mean.

**How we use it.** We do not install Spec Kit, Kiro, or a second OpenSpec tree on NAOMS. The living spec is `naoms-rust/spec/`. Acceptance tests are already EARS-shaped (`given / when / then`, plus a boundary). The intention plugin is the delta log for changes to that spec after an island is chosen: one change directory, then `intend`. `/prd` is for a product question the code cannot answer (who it is for, what to drop), and its output is a proposal on that change, not a new inventory. `/sprint-plan` stops at architecture for that one change. The constitution is the epistemology charter and the clean-room rule, already written.

**Gap.** These tools are silent on how to find features in a 40,000-file tree, and they are silent on extractor uncertainty. Starting Specify on "NAOMS" would produce another 10,000 requirements. The decomposition loop is the front end they lack. Their sequence starts at step 4 of our loop, for one feature, after the fixture pack exists.

## What we measured ourselves, and still obey

FarmOS, July 2026, written up in `where-the-techniques-shine.md`. Islands matched real module seams (117 of 147 declared modules in a single island; framework edges were 88% of boundary composition and did not move the cut). The core was modular on paper and one blob in the graph. The oracle carried acceptance. Briefs during the build scored about zero. Behavior authored in another island through DI was invisible to island membership. The Elenchus fired once and then did not fire for eighteen days, because only memory triggered it.

Those results outrank the papers above whenever they conflict. The papers are welcome where they tighten a filter (evidence-grounded boundary edits, anchors, held-out tests, concept-sized features, authority on every edge). They are not welcome where they hand the model the partition or the build.
