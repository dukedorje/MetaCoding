# Contacts island — desk pass

**Date:** 2026-11-07. **Source checkout:** `naoms` `ac4682148fc` (behind `origin/main` by 2003). **Graph:** tree-sitter symbols, read-only, `~/.local/share/metacoding/naoms`. **Room:** not started. `mod-contacts.md` was not edited.

The predicate is frozen: every tree-sitter symbol whose `file` starts with `src/packages/contacts/`.

## 1. Member set

| | |
|---|---|
| Symbols | 6,502 (field 3574, function 1573, file 487, method 429, interface 288, type_alias 125, class 25, enum 1) |
| Files in the graph | 487 |
| Working-tree files | 534, of which 321 are `*.test.ts` |
| Digest | SHA-256 of the sorted graph file list: `f903726af99fa3846ac67e67cce1fcbbf2f2a91942200354844f092ba4b782a1` |

The file list is `members.txt`. A later pass that adds or drops a file under that prefix is a different island.

## 2. Seam map

Calls do not leave the package. Inside it, 4,339 calls stay in one file and 1,183 calls cross files in 317 pairs. Cross-file field writes (108) are excluded. Same-file writes and raises are `effects.json`.

Directory crossings (caller dir → callee dir, call count):

| from | to | calls |
| --- | --- | --- |
| (root) | handshake | 87 |
| (root) | materializers | 68 |
| handshake | materializers | 52 |
| handshake | (root) | 48 |
| enrichers | (root) | 10 |
| materializers | handshake | 4 |
| enrichers | handshake | 4 |
| messaging | reducers | 3 |
| (root) | handlers | 3 |
| handlers | (root) | 2 |
| handlers | materializers | 2 |
| handlers | messaging | 2 |
| reducers | messaging | 2 |

The heavy internal seam is `handshake/` splitting across helper files, and `api-handlers*` calling `api-handlers-shared`, `materializers/state-writes`, and `handshake/`. The full pair list is `seams.json`.

Same-file raises, the only effect names resolved inside one file: `RelationshipIdentityError` (3), `VouchVerificationError` (3), `ActorRateLimitedError`, `RateLimitedError`, `MediaQuotaExceededError`, `ExternalBindingPersistError`, `EraseCrossChainRefusedError`, `RetractErasureApplyError`, `BlobRefsSchemaStaleError`, `ContactsCorpusShapeError`.

Same-file writes are few and local: `messaging/actor-rate-limit.ts`, `messaging/rate-limit.ts`, `messaging/media-quota.ts`, `handshake/operational-staple-build.ts`, `reducers/pending-refs.ts`. They are not a contact-record schema.

## 3. Scenarios

All 321 test files are in exactly one theme. A theme is a filename match, not a reading of the body. Titles are the `Deno.test` name where the extractor found one (1,525 titles). Thirteen files still have no extracted title; their filename is the citation. Per-theme file lists are `scenario-files.json`.

| theme | files | one title |
| --- | --- | --- |
| unclassified | 103 | 1155 [e2e] flow I — long-content / unicode-stress / cap honesty |
| handshake | 73 | BUG-10 GREEN: alice's initiate-leg staple → bob.trusted_keys gets alice's #prima |
| not-contacts | 44 | fail-pane-hidden-before-tap |
| friendship | 36 | 1163 BMOC non-friendship chainType: silent return, no writes |
| keys | 19 | peer-op-key-installer: db absent → returns immediately (no throw) |
| connection | 11 | 1394 M-FOLLOWON-NON-FOUNDER-PAIR-PEERS-AUTO-RESPOND — bob-runner ↔ alice-tui pai |
| address-book | 7 | integ-contacts: graph.query for contact type returns array |
| erasure | 7 | intent-06-fail-pre-edit-original-bubble |
| card | 6 | 1433 DE-38 INTEG (failure-mode): R-Card exchange refused before peer-pair comple |
| rate-limit | 3 | checkActorRateLimit: returns 0 when no agent rows exist |
| introduction | 3 | 1328: contact.linked writes TYPED edges from the contact node |
| permission | 2 | 1682 direct call of handleSetRelationshipPermission with NO capability refuses b |
| trust | 2 | 952 M4-S6: register.ts trust-level read uses graphQuery (no SELECT FROM handshak |
| archive | 2 | 1805 ARCHIVE-NO-CHAIN: chain_id ${label} -> CONTACT_CHAIN_UNKNOWN, no append |
| invite | 2 | 01-fail-pre-pane-no-panel |
| vouch | 1 | rcard-default |

`not-contacts` (messaging, blobs, sharing panes, hive chat, read receipts, and similar) is in this directory and is not a contacts behavior. `unclassified` still needs a body read before it becomes a scenario. Neither enters the room packet.

## 4. Keep / drop of `mod-contacts.md`

The spec has 142 `INV-mod-contacts-*` lines and 160 `AT-mod-contacts-*` lines. The TypeScript tests do not use those Rust operation names. Matching a backtick identifier from the invariant to a test path or title:

An identifier counts only when it contains an underscore and is at least 10 characters, so words like `connected` and `delivery` do not match. Result:

| disposition | invariants | meaning |
| --- | --- | --- |
| name-hit | 8 | a spec identifier appears in a test path or title |
| unmatched-name | 80 | the invariant names an operation the tests never say |
| no-identifier | 54 | the sentence has no underscored backtick name |

`name-hit` is not a keep. It is a citation to go read. `unmatched-name` is not a drop. It is the vocabulary gap between this spec and these tests. Nothing is marked keep, rewrite, or drop until a test body is quoted against the sentence. Rows are `dispositions.json`.

Name-hits, with the identifier that actually matched:

| id | matched | test |
| --- | --- | --- |
| INV-mod-contacts-005 | `contact_create` | `tests/uc-contact-create-ws-surface-failure-mode.test.ts` |
| INV-mod-contacts-007 | `normalise_address` | `tests/uc-normalise-address-failure-mode.test.ts` |
| INV-mod-contacts-028 | `contact_link` | `tests/uc-contact-linked-typed-edges.test.ts` |
| INV-mod-contacts-059 | `contact_create` | `tests/uc-contact-create-ws-surface-failure-mode.test.ts` |
| INV-mod-contacts-071 | `is_contact` | `tests/uc-typed-person-relations.test.ts` |
| INV-mod-contacts-085 | `normalise_address` | `tests/uc-normalise-address-failure-mode.test.ts` |
| INV-mod-contacts-101 | `trust_level` | `tests/uc-contact-materializers-uplift.test.ts` |
| INV-mod-contacts-104 | `normalise_address` | `tests/uc-normalise-address-failure-mode.test.ts` |

The computed-trust and source-reputation block (INV-mod-contacts-037 through -050, and the later trust-path invariants whose tokens are `compute_trust`, `source_reputation`, `trust_horizon`) is unmatched-name. The coverage map already calls that block a gap of the behaviour list. It stays out of the room packet.

## 5. Glossary and shapes

Terms the tests actually say, and that the room packet may use: person, friendship, handshake, invite, vouch, staple, card, key, erasure, archive, standing, introduction. Terms the spec says and the tests do not say, withheld: `compute_trust`, `source_reputation`, `trust_horizon`, `connection_invite`, `contact_set_trust`, `ContactBook`.

Boundary shapes are not filled. Same-file writes are rate-limit counters and staple fields, not the person record. Cross-file `READS_FIELD` was refused in the graph pass as short-name collision. No data-shape table is honest yet.

## 6. Warnings

- The checkout is 2003 commits behind `origin/main`. This dossier describes `ac4682148fc`.
- `IMPORTS` is 0, so a module seam is invisible. Closure under `CALLS` is not closure under the registry.
- Full-text search has 0 rows. String and tool-name coupling was not harvested.
- Cross-file field edges are unusable. 108 cross-file writes were excluded on purpose.
- 103 test files matched no theme, and 44 more are other features living in this package (messaging, blobs, sharing panes, hive chat). The directory is not one job.
- `index_health` is still the abandoned `RUNNING` row. This pass used the CLI read path.
- Spec identifiers and test names are different languages. A keep/drop that joins them by string will either keep everything or drop the handshake.

## 7. Room packet

Not issued. The handshake theme has been read far enough to separate three piles. The reading is [`HANDSHAKE.md`](./HANDSHAKE.md).

- Staple and `trusted_keys` tests witness TypeScript behavior the spec already placed outside this module (section 7 item 16).
- Invite-nonce refusals (`INVITE_REVOKED`, `INVITE_ALREADY_USED`, `INVITE_EXPIRED`, `INVITE_UNKNOWN`) are witnessed and are not `INV-mod-contacts-013` or `-015`.
- The Personal card as relationship default is witnessed and is not in the spec.

No invariant is marked keep. Friendship (36 files) is the next theme. The trust-computation invariants stay unmatched until a test body names them.

`mod-contacts.md` stays as it is.
