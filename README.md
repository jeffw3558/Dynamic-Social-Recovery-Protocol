# Dynamic Social Recovery Protocol

Social recovery with **zero off-chain storage**. The guardian set lives on-chain as a
threshold-encrypted blob; guardians approve by replying to an email, and their approvals
arrive as zero-knowledge proofs of the DKIM signature. No database, no backend, no
plaintext guardian identity anywhere — and a mandatory 48-hour window in which the owner
can veto.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design, threat model and data flow.

```
contracts/   Foundry — DynamicSocialRecovery.sol, ITimelock, IZKEmailVerifier, tests
sdk/         TypeScript — guardian vault, ZK-Email proof generation, relay
```

## Quick start

```bash
pnpm install && (cd contracts && forge build)
```

```bash
cd contracts && forge test
```

```bash
pnpm -F @dsrp/sdk test && pnpm -F @dsrp/sdk typecheck
```

## What the contract enforces

`submitEmailProof` runs seven checks. Proof verification alone is *not* authorization — a
guardian's proof is a bearer credential the moment it reaches the mempool, and these are
what narrow it to a single use against a single request:

| # | Check | Attack it stops |
|---|---|---|
| 1 | ZK proof verifies | Forged proof |
| 2 | DKIM key is trusted for the domain | Revoked or untrusted signing key |
| 3 | `maskedCommand` matches `(requestId, newOwner, address(this), chainid)` | **Cross-request, cross-deployment, cross-chain replay** |
| 4 | Nullifier unspent | Resubmitting the same email |
| 5 | `accountSalt` is a known guardian | Approval from a non-guardian |
| 6 | Guardian has not already approved | One guardian counted repeatedly |
| 7 | Email is not older than the request | Approvals pre-signed before a request existed |

Check 3 is the one comparable implementations most often miss. Nullifiers stop *the same
email* being counted twice; they do nothing about a genuine approval for request #1 being
lifted from the mempool and submitted against request #2.

## Safety properties

The Foundry suite is built around these, with stateful invariants over randomized action
sequences:

1. No recovery executes before `initiatedAt + 48h`.
2. The owner can cancel any pending recovery — including one already mature and past
   threshold. Only execution closes the window.
3. Proofs are single-use; invalid and replayed proofs always revert.
4. `executed` and `cancelled` are mutually exclusive.
5. Ownership changes exactly once per executed recovery, and by no other route.
6. Approvals never exceed the guardian set size.

## Two things worth knowing before you build on this

**The owner's veto is unconditional, so a compromised owner key can grief recovery
forever.** That is the direct consequence of treating property 2 as a hard requirement,
and it is the intended bias: no unauthorised ownership transfer, even at the cost of
liveness. A guardian supermajority override is out of scope — see ARCHITECTURE.md §5.

**Lit's Access Control Conditions no longer exist.** Datil sunset 2026-02-25 and Naga
2026-04-01; the live network is Chipotle (v3), where decryption is gated by a Lit Action
authorized on-chain rather than by a condition array. The SDK targets Chipotle behind a
`GuardianVault` port, with a `MockVault` so the whole suite runs offline. ARCHITECTURE.md
§2.1 has the detail.

## The command string is defined twice

Once in `DynamicSocialRecovery.canonicalCommand`, once in `sdk/src/command.ts`, because
the relayer and the Lit gate both need it off-chain. Two hand-maintained copies of a
security-critical string is exactly what silently drifts, so the contract is the source of
truth: `CanonicalCommandFixturesTest` regenerates
`contracts/test/fixtures/canonical-commands.json` from the deployed bytecode, and
`sdk/test/command.test.ts` asserts the TypeScript mirror reproduces every case. Change the
Solidity format and the SDK suite fails until the mirror is updated.

Drift fails closed — proofs stop being accepted rather than being wrongly accepted — but
it is still an outage, hence the guard.

## Deploying

The verifier is generated per-blueprint by the ZK Email Registry and the DKIM registry is
a shared deployment, so both are passed in by address. `Deploy.s.sol` refuses an address
with no code rather than standing up a fake verifier on a live network.

```bash
cd contracts && forge script script/Deploy.s.sol:Deploy --rpc-url base_sepolia --broadcast
```

Required: `DSRP_OWNER`, `DSRP_VERIFIER`, `DSRP_DKIM_REGISTRY`, `PRIVATE_KEY`.
See [sdk/.env.example](./sdk/.env.example) for the SDK's configuration.

## License

MIT
