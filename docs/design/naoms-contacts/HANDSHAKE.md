# Contacts — handshake reading

**Date:** 2026-11-07. Continues [`PASS.md`](./PASS.md). Source is the 73 files in the `handshake` theme of `scenario-files.json`, at `naoms` `ac4682148fc`. Bodies were not executed. Quotations are from the test source. No invariant is marked keep. `mod-contacts.md` was not edited. The room packet is still not issued.

## What the tests pin

Every file is in one bucket. A file can carry more than one claim; the bucket is the filename.

| Bucket | Files | What a title or assertion says |
|---|---:|---|
| Staple and trust rows | 15 | A cold initiate writes no `trusted_keys` row. A valid invite installs the staple. The signer's key matches the advertised key. |
| Response lookup | 8 | A response from the wrong DID is counted and does not touch state. The pending row is found by a total order. Re-pair does not rewrite immutable contact fields. |
| Chain carrier | 6 | `handshake.connected` or `handshake.revoked` on chain A naming chain B writes nothing, and B stays as it was. |
| VP proof | 6 | An unsigned VP is refused. A VP whose holder is A and whose signature is B is refused `signature-invalid`. A pseudonymous VP bound to this handshake is accepted. |
| Card default | 5 | The relationship default is the Personal card even when a hive R-card sorts first. |
| Two peers | 4 | A real two-daemon handshake materialises the contact on both sides, with the same chain id. |
| Nonce gate | 3 | Expired, consumed, revoked, and never-minted invites are refused by those names and seat no handshake. |
| Loud failure | 3 | A failed `friendship.connected` append returns an error and does not pretend the keys were delivered. |
| Tools and CLI | 3 | CLI and tool-surface shape. Not a domain rule. |
| Vouch | 2 | A vouch VRC is dual-signed. A governance credential is refused that dual-sign. |
| Revocation | 2 | A revoke still matches a key id wrapped in a typed literal. |
| Residual | 16 | Rotation keeps `identity_id`. `handshake_state` has no `CREATE TABLE`. A decline does not reach the peer. Pseudonym invite target. Relationship signer. Materializer. Sybil scorer. Cross-server coverage. |

## Quotations

Invite nonce, `handshake/tests/uc-invite-nonce-validity-gates.test.ts`:

```
assertEquals(n, 0, "expired invite must be refused");
assertEquals(n, 0, "single-use: a consumed invite must be refused");
assertEquals(n, 0, "a nonce this identity never minted must be refused");
```

Web link, `handshake/tests/uc-weblink-redeem-gate-failure-mode.test.ts`:

```
assertEquals((r as { reason: string }).reason, "INVITE_REVOKED");
assertEquals(statuses(db, INVITEE.did).length, 0, "a revoked web link seats NO handshake (and is not downgraded to a cold initiate)");
```

The same file also expects `INVITE_ALREADY_USED`, `INVITE_EXPIRED`, and `INVITE_UNKNOWN`.

Cold staple, `handshake/tests/uc-cold-staple-initiate-writes-no-trust-rows-failure-mode.test.ts`:

```
assertEquals(tk.length, 0, "no trusted_keys row for the un-approved peer");
assertEquals(ext.length, 0, "no external_trusted_keys binding before approval");
```

Default card, `handshake/tests/uc-default-relationship-card-success.test.ts`:

```
assertEquals(selectDefaultRelationshipCard(nodes)?.id, "rcard-5f84729a-personal");
```

The nodes include a hive R-card with `default: 1` that sorts first. The failure-mode twin says a hive-scoped card is never the default even when it is the only card flagged default.

Wrong chain, `tests/uc-handshake-connected-friendship-id-failure-mode.test.ts`:

```
assertEquals(writes, [], "no graph write may come from the mismatch");
assertEquals(propsOf(db, CHAIN_B).status, "active", "B must be untouched");
```

VP proof, `tests/uc-signed-handshake-vp-proof-failure-mode.test.ts`:

```
assertEquals(!out.ok && out.reason, "signature-invalid");
```

The header says the VP names holder A and is signed by key B.

## Against the spec

Three relations, and none of them is a keep.

**The spec already set this aside.** Section 7 item 16: "The operational-key staple of a handshake is not carried by this module (key binding belongs to identity and the ceremony)." The staple, `trusted_keys`, operational-key, signer-subprocess, and rotation-of-`identity_id` tests are the largest bucket. They witness the TypeScript implementation. They do not witness a contacts invariant, because the spec says that behavior is not this module's. Disposition for the room: do not reimplement it in `mod-contacts`. Disposition for the desk: those tests are evidence for identity and ceremony, when those islands are read.

**The spec states a nearby rule the tests do not state.** `INV-mod-contacts-013` is the mint order: usable layer, backup gate, time to live, name, then one door call. `INV-mod-contacts-015` refuses redeem with `WrongInviteKind`, `SelfConnect`, `ContactBlocked`, `AlreadyConnected`, and `InviteRefused`. The handshake tests refuse `INVITE_REVOKED`, `INVITE_ALREADY_USED`, `INVITE_EXPIRED`, and `INVITE_UNKNOWN`, and they count seated rows. Same story, different names, different boundary. Those two invariants stay unmatched. The nonce scenario is witnessed and has no invariant sentence yet.

**The tests state a rule the spec does not.** `selectDefaultRelationshipCard` returns the Personal card, and a hive card is never that default. `mod-contacts.md` has no `Personal` and no hive-scoped default. `INV-mod-contacts-019` and `-068` are about `CardDoor`, size, and one chosen card. They are not this choice. This is a rewrite candidate only if card selection stays in this module: one sentence, the Personal card is the relationship default, a hive-scoped card is not. It is not a keep of `-019` or `-068`.

The wrong-chain refusal (a commit on chain A naming chain B writes nothing) is the same shape as hazard D1, which is about `contact.elevated` on a shared chain. D1 is not this test. The witnessed sentence is narrower and is also missing: a handshake event applies only on the handshake's own chain.

`signature-invalid` for a VP signed by the wrong key is the holder-proof idea in section 7 item 8, again at a different boundary (`vp-verify-gate`, not `CardDoor::check`). Not a keep of `-019`.

Vouch dual-sign and the refusal of a governance credential are ceremony and credential behavior. `INV-mod-contacts-121` is already `WITHDRAWN` and points at mod-identity. These two tests do not revive it.

## What this does not do

The 73 files were not run. A title and an assertion were read for the quotations above. The other files in a bucket are accounted by filename and by the header extract, not by a second quotation. Acceptance tests `AT-mod-contacts-*` were not matched one by one. Nothing here is a room packet.
