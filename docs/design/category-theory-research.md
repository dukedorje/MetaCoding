# Category theory: inspiration and experimental track

**Status: research, not a requirement for ordinary MetaCoding use.** The shipping
foundation is symbol extraction/resolution, typed graph queries, source evidence
and empirical verification. The structural-analysis algorithms are named for
what they compute; see [names and guarantees](structural-analysis-terminology.md).

This separation preserves the useful questions category theory suggests without
presenting an approximation as a theorem. Begin with repeated, useful end-to-end
workflows. Add deeper machinery only when a concrete question and a controlled
comparison justify it.

## What the ideas contribute

### Role identification: look at relationships, not just names

Yoneda motivates studying an object through its relationships. The actual lemma
concerns hom-functors and natural transformations, including composition; it is
not a theorem that typed degree counts identify objects. The current structural
profiles retain counts and neighbor means, losing substantial information.
Use them to propose analogies, then inspect source and behavioral evidence.

### Mapping systems: make preservation obligations explicit

A functor preserves identities and composition. An exact graph map extends to a
functor between the corresponding free path categories, but that alone says
nothing about program semantics. Categories with additional path equations
require those equations to be respected as well.

The current alignment algorithm proposes partial, approximate graph mappings;
edge fidelity and similarity are diagnostics, not proofs of these obligations.
A useful experiment would specify the source/target categories and equations,
return witnessed mappings, and test which declared laws survive. Compare it with
ordinary typed-graph matching on the same task and evidence.

A near-term practical obligation is simpler: a proposed preserved path must have
one connected witness, not different witnesses for each step. Likewise, fan-in
requires the same target instance. This can be implemented with ordinary graph
algorithms; the compositional viewpoint helps state the requirement precisely.

### Combining schemas: preserve meaning across translations

Pullbacks, pushouts and other universal constructions offer a language for
schema integration once the objects, arrows, equations and schema mappings are
actually defined. Shared names or a clustering partition do not establish a
colimit or resolve conflicting meanings automatically.

A promising later test is a translation between two evidence schemas that
preserves claim identity, exact source references and query meaning. Establish
simple schema-mapping/validation baselines first. Kan extensions can extend
specified mappings in appropriate settings; they do not discover an unknown
mapping merely by being named.

### Composition: model how parts combine

Operads can formalize multi-input operations with substitution, units and the
appropriate laws. The current composition-pattern miner records role paths and
fan-in motifs; it does not implement or prove that algebra. Observing a two-step
path is not an associativity proof, and observing a cycle is not a generic
operad violation.

A later experiment could model an explicitly typed workflow algebra and test
substitution/associativity where those laws are genuinely intended. It should
solve a concrete composition problem better than graph-pattern checks or
ordinary type/contract tests before entering the main workflow.

## Evidence required for promotion

A research feature needs an explicit mathematical object and claimed property,
a computation/check for that property, counterexamples it rejects, and a
real task comparison against simpler methods. Record extraction coverage,
ambiguity, failure cases, cost and behavioral evidence separately. Do not use
mathematical terminology to convert a heuristic score into confidence or proof.

For a knowledge archive, citation/support paths are not automatically proofs,
and evidence support is not generally transitive. A categorical presentation
does not supply missing premises, calibrated probabilities or independent
corroboration. Those require explicit evidence and inference policies.

## Earlier design material

The following documents preserve the original questions and proposed designs.
Their historical names and ambitions are not an implementation-status claim:

- [Original pipeline plan](ct-pipeline.md)
- [Structural alignment research, historically functor discovery](ct-functor-discovery.md)
- [Subsystem extraction design](ct-subsystem-extraction.md)
- [Information-domain proposal](ctkr-information-domain.md)

Where older text conflicts with the implemented capabilities, the current
[names and guarantees](structural-analysis-terminology.md) take precedence.
