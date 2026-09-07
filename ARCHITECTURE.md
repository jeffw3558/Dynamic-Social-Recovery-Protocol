# Dynamic Social Recovery Protocol — Architecture

**Status:** design complete, implementation in progress
**Target chain:** Base (mainnet), Base Sepolia (staging)
**Last verified against upstream:** 2026-09-07

---

## 1. Thesis: zero-database guardian privacy

Every social-recovery system has to answer one question: *where does the guardian list live?*

Most answers are bad. Storing guardian addresses on-chain leaks the owner's social graph
permanently and immutably. Storing them in a relayer's database reintroduces the exact
trusted third party that self-custody exists to remove — and that database becomes the
single most valuable target in the system, because compromising it tells an attacker
precisely whom to phish in order to take a wallet.

This protocol stores the guardian set **on-chain, threshold-encrypted**, and gates
decryption on the wallet's own live recovery state. The consequences:

- **No backend.** No database, no server, no operator. The chain is the only storage.
- **No social-graph leak.** On-chain state contains ciphertext plus per-guardian
  `accountSalt` commitments. It never contains an email address or a guardian address.
- **No unilateral decryption.** Not even the protocol authors can read the guardian set;
  the decryption gate is code authorized on-chain, and it refuses unless a recovery has
  genuinely matured.

Guardian approvals arrive as zero-knowledge proofs of DKIM-signed emails, so a guardian
needs no wallet, no gas, no seed phrase, and no app — only the ability to reply to an
email from the address they already control.

---

## 2. Upstream reality check (read this before writing integration code)

Two load-bearing facts were verified during design and are easy to get wrong, because the
public tutorials for both ecosystems are out of date.

### 2.1 Lit Protocol: Access Control Conditions no longer exist

The classic Lit pattern — build a `unifiedAccessControlConditions` /
`evmContractConditions` array, hand it to `encrypt()`, and let the nodes evaluate it at
`decrypt()` time — is **gone from every live network**:

| Network | SDK | Status |
|---|---|---|
| Datil (v0) | `@lit-protocol/lit-node-client@7` | Sunset **2026-02-25** |
| Naga (v1) | `@lit-protocol/lit-client@8` | Fully sunset **2026-04-01** |
| **Chipotle (v3)** | REST + lightweight JS SDK | **GA since 2026-04-01** — current |

Chipotle is a ground-up rebuild: TEE-backed, REST-first
(`api.chipotle.litprotocol.com/core/v1`), with PKP permissions anchored on **Base**.
Encryption is a client-side operation performed inside a Lit Action:

```js
const ciphertext = await Lit.Actions.Encrypt({ pkpId, message: secret });
```

Decryption is not gated by a condition array. It is gated by **which Lit Action is
authorized on-chain to use that PKP**. Only a permitted action can recover the plaintext.

**This is an upgrade for us, not a downgrade.** A static condition array can only assert
simple predicates about chain state. An authorized action is arbitrary code, so our gate
can read the *entire* recovery struct — maturity, approval count against threshold, and
both terminal flags — and make a decision no declarative ACC could express.

Because the SDK surface is young and its docs are thin, all Lit access is confined behind
one port interface (§6.1). The contracts never learn that Lit exists; they store opaque
`bytes`.

### 2.2 ZK Email: reuse the registry, own the manager

`@zk-email/contracts@6.3.2` ships audited `DKIMRegistry.sol` and
`UserOverrideableDKIMRegistry.sol`. DKIM key registration and rotation is genuinely
difficult, security-critical, and already solved — we depend on it rather than
reimplementing it.

`zkemail/email-recovery` already implements email-guardian recovery for ERC-7579 accounts.
We do not fork it: its manager assumes a modular-account world and treats the recovery
delay as a parameter, whereas our novelty is the encrypted on-chain payload and the
mandatory timelock. We reuse the *proof plumbing* — the canonical `EmailProof` struct and
the DKIM registry — and write our own manager.

The canonical `EmailProof` struct carries the proof as `bytes`, making it agnostic to the
proving system. Circom/Groth16 and Noir/UltraHonk blueprints both drop into the same
`IZKEmailVerifier` interface.

---

## 3. End-to-end data flow

### 3.1 Enrollment (owner, once)

```
 Owner
   │  GuardianSet { emails[], threshold }
   │
   ├─1─► accountSalt_i = H(email_i ‖ salt_i)          [client-side, per guardian]
   │
   ├─2─► ChipotleVault.encrypt(GuardianSet)
   │        └─► Lit.Actions.Encrypt({ pkpId, message })  ──► ciphertext
   │
   └─3─► setGuardianPayload(ciphertext, hash, accountSalts[], threshold)
            └─► on-chain, Base ─── no email, no address, no plaintext
```

Only the commitments `accountSalt_i` and the ciphertext reach the chain. The email
addresses exist in the ciphertext alone, retrievable solely through the gate in §6.2.

### 3.2 Recovery

```
 Anyone (typically the owner from a new device)
   │
   ├─4─► initiateRecovery(newOwner)
   │        └─► RecoveryRequest { newOwner, timestamp: t0, proofCount: 0 }
   │        └─► emits the canonical command string to be echoed by guardians
   │
 Guardian (needs no wallet, no gas)
   │
   ├─5─► replies to an email whose subject is the canonical command
   │        └─► @zk-email/sdk: getBlueprint → createProver → generateProof(eml)
   │
   ├─6─► submitEmailProof(requestId, EmailProof)     [relayed; any sender may pay gas]
   │        ├ verifier.verifyEmailProof(p)                        ZK proof valid
   │        ├ dkimRegistry.isDKIMPublicKeyHashValid(domain, pkh)  DKIM key trusted
   │        ├ p.maskedCommand == canonicalCommand(...)            bound to THIS request
   │        ├ !usedNullifiers[p.emailNullifier]                   never replayed
   │        ├ isGuardian[p.accountSalt]                           is a guardian
   │        └ !hasApproved[requestId][p.accountSalt]              one vote per guardian
   │        └─► ++proofCount
   │
   ├─7─► ⏳ 48-hour timelock
   │        └─► owner may cancelRecovery(requestId) at ANY point before execution
   │
   └─8─► executeRecovery(requestId)
            ├ block.timestamp >= t0 + 48 hours
            ├ proofCount >= threshold
            ├ !executed && !cancelled
            └─► owner = newOwner
```

---

## 4. The six bindings in `submitEmailProof`

Proof verification alone is *not* sufficient, and this is where comparable
implementations most often go wrong. A guardian's email proof is a bearer credential the
moment it touches a public mempool. Six checks turn it into a single-use, tightly scoped
authorization:

| # | Check | Attack it stops |
|---|---|---|
| 1 | `verifier.verifyEmailProof(p)` | Forged proof |
| 2 | `dkimRegistry.isDKIMPublicKeyHashValid(p.domainName, p.publicKeyHash)` | Proof against an untrusted or revoked DKIM key |
| 3 | `p.maskedCommand == canonicalCommand(requestId, newOwner, address(this), block.chainid)` | **Cross-request, cross-deployment and cross-chain replay** |
| 4 | `!usedNullifiers[p.emailNullifier]` | Resubmitting the same email |
| 5 | `isGuardian[p.accountSalt]` | Approval from a non-guardian |
| 6 | `!hasApproved[requestId][p.accountSalt]` | One guardian counted repeatedly toward threshold |

Check 3 deserves emphasis. Nullifiers (check 4) stop *the same email* from being counted
twice — they do **not** stop a genuine guardian approval for request #1 from being lifted
out of the mempool and submitted against request #2, against a different deployment of
this contract, or against the same bytecode on another chain. Binding the proof's
`maskedCommand` to `(requestId, newOwner, address(this), block.chainid)` is what makes an
approval mean *"I approve transferring THIS wallet to THIS owner"* rather than the far
weaker *"I approve something."*

The canonical command string is defined once in Solidity and mirrored once in the SDK.
These two definitions must not drift; a mismatch fails closed (proofs stop being
accepted) rather than open.

### Guardian privacy

`accountSalt` is a commitment to `(email, salt)`, not the email. The chain learns that
*some* address controlling *some* mailbox at a DKIM-trusted domain approved a recovery.
It never learns which mailbox. Guardians are unlinkable across wallets, since a fresh
salt yields a fresh commitment.

---

## 5. Timelock semantics

`ITimelock` exposes `delay()` (a constant 48 hours), `etaOf(requestId)` and
`isMature(requestId)`. `DynamicSocialRecovery` implements it directly, so the Lit Action,
front-ends and monitoring tools all read maturity through one stable surface rather than
recomputing the deadline from raw struct fields.

The delay is **not** a rate limiter. It is the owner's notification-and-veto window: the
interval during which a still-solvent owner who sees an unexpected `RecoveryInitiated`
event can kill it. Its length is the security parameter that makes guardian collusion
survivable.

`cancelRecovery` is owner-only and succeeds on **any** non-terminal request — including
one whose timelock has already matured and whose approvals already exceed threshold. Only
`executed` closes the window. This is what makes the veto unconditional.

### Documented tradeoff: owner griefing

An unconditional owner veto means a **compromised** owner key can cancel every recovery
attempt forever, permanently bricking the recovery path. This is the direct and
unavoidable consequence of the invariant *"the wallet owner can always cancel a pending
recovery before execution"*, which this protocol treats as a hard safety requirement.

The tradeoff is deliberate, and it is the right one for the threat model: it prioritises
*no unauthorised ownership transfer* over *recovery always eventually succeeds*. Systems
wanting the opposite bias add a guardian supermajority that overrides the veto after a
longer second delay. That is **out of scope** here and is noted so the omission reads as
a decision rather than an oversight.

---

## 6. Off-chain SDK

### 6.1 The `GuardianVault` port

```ts
export interface GuardianVault {
  encrypt(set: GuardianSet, ctx: RecoveryContext): Promise<EncryptedPayload>;
  decrypt(blob: EncryptedPayload, ctx: RecoveryContext): Promise<GuardianSet>;
}
```

Two implementations:

- **`ChipotleVault`** — the production adapter, speaking REST to Chipotle.
- **`MockVault`** — deterministic local AES-GCM. Lets the entire test suite and CI run
  offline, with no Lit account, no network and no key material.

The port exists because Lit has replaced its encryption surface three times in roughly
eighteen months. Confining that churn to one file behind a two-method interface means the
next migration touches one adapter instead of the protocol.

### 6.2 The decryption gate (`lit-actions/guardian-gate.js`)

This authorized Lit Action is the direct replacement for the old ACC array. It reads
`DynamicSocialRecovery` on Base and releases plaintext only when:

```
isMature(requestId) && proofCount >= threshold && !cancelled && !executed
```

Because it is code rather than a condition array, it evaluates the full struct atomically
against live chain state.

### 6.3 Email and relay

`email/` wraps `@zk-email/sdk` v2 — `initZkEmailSdk()` → `getBlueprint(slug)` →
`createProver()` → `generateProof(eml)` — with `@zk-email/helpers` for header
canonicalization, plus `toEmailProofStruct()` mapping SDK output onto the Solidity struct.

`chain/` holds viem clients targeting Base and submits `submitEmailProof` /
`executeRecovery`. Relaying is **trustless**: the six bindings make every proof
self-authenticating and single-use, so an arbitrary third party can pay the gas without
being trusted. A hostile relayer can withhold or delay a proof, but cannot forge, alter,
redirect or replay one.

---

## 7. Trust model

**Trusted**

- The DKIM signing keys of guardian email domains, as recorded in the ZK Email registry.
  Compromise of a domain's key compromises guardians at that domain.
- The ZK circuit and its verifier contract (soundness of the proving system).
- The Lit Chipotle TEE network for *confidentiality of the guardian list only*.

**Not trusted**

- Relayers and transaction submitters. Anyone may submit; nobody is privileged.
- Any database or backend — there is none.
- Individual guardians, up to `threshold - 1`.
- The chain's observers: on-chain state reveals no guardian identity.

**Explicitly out of scope**

- Guardian supermajority override of a compromised owner's veto (§5).
- Guardian-set rotation without re-encrypting the payload.
- Cross-chain recovery propagation.

---

## 8. Repository layout

```
contracts/            Foundry
  src/
    DynamicSocialRecovery.sol      manager: payload, thresholds, requests, timelock
    interfaces/ITimelock.sol       48h delay surface
    interfaces/IZKEmailVerifier.sol  mirrors the canonical zk-email EmailProof struct
  test/
    *.t.sol                        unit
    *.fuzz.t.sol                   bounded + unbounded property tests
    *.invariant.t.sol              stateful invariants (§9)
    handlers/                      invariant handler with ghost state
    mocks/                         programmable verifier + DKIM registry
  script/Deploy.s.sol

sdk/                  TypeScript
  src/vault/          GuardianVault port, Chipotle adapter, mock adapter
  src/email/          blueprint, proof generation, header formatting
  src/chain/          viem client + relay
  src/lit-actions/    guardian-gate.js (authorized decryption gate)
```

---

## 9. Safety invariants

The stateful invariant suite drives a handler with ghost state and asserts:

1. **Timelock is absolute.** No request is ever `executed` with
   `executedAt < timestamp + 48 hours`.
2. **The veto always works.** For every non-terminal request,
   `prank(owner).cancelRecovery(id)` succeeds.
3. **Proofs are single-use.** Nullifier-set cardinality equals the sum of all
   `proofCount`s; no nullifier is ever consumed twice.
4. **Terminal states are exclusive.** Never `executed && cancelled`.
5. **Ownership moves only through recovery.** `owner` changes exactly as many times as
   requests reach `executed`.
6. **Approvals are bounded.** `proofCount <= guardianCount` for every request.

A real Groth16/Honk verifier cannot be driven inside a fuzz or invariant loop, so the
stateful suite runs against a programmable `MockZKEmailVerifier` that can accept or
reject on demand — this is what makes every branch, including the failure branches,
reachable. The real generated verifier is exercised separately by a fixture-based test
over a committed `.eml` and its proof.
