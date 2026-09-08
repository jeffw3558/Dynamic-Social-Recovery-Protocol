import {
  createWalletClient,
  http,
  type Account,
  type Address,
  type Hash,
  type WalletClient,
} from "viem";

import { DSRP_ABI } from "./abi.js";
import { chainFor, type DsrpPublicClient, type SupportedChain } from "./client.js";
import { canonicalCommand } from "../command.js";
import type { EmailProofStruct, EncryptedPayload, GuardianSet, RecoveryContext } from "../types.js";

/**
 * Submits transactions to {@link DynamicSocialRecovery}.
 *
 * Relaying is trustless: the contract's seven checks make every proof
 * self-authenticating and single-use, so an arbitrary third party can pay the gas
 * without being trusted with anything. A hostile relayer can withhold or delay a
 * proof; it cannot forge, alter, redirect or replay one.
 *
 * There are two very different callers, so each gets a named constructor rather
 * than a single overloaded one:
 *
 *   - {@link RecoveryRelay.fromAccount} — a server-side relayer holding a funded
 *     key, submitting on behalf of guardians who have no wallet at all.
 *   - {@link RecoveryRelay.fromWalletClient} — a browser, passing the user's own
 *     connected wallet (from wagmi/viem).
 *
 * Both share the pre-flight command check in {@link submitEmailProof}, which is the
 * point of routing browser writes through this class instead of calling
 * `writeContract` directly: that check is the guard against the Solidity/TypeScript
 * command mirrors drifting, and a second copy of it would defeat the purpose.
 */
export class RecoveryRelay {
  private constructor(
    private readonly ctx: RecoveryContext,
    private readonly wallet: WalletClient,
    private readonly account: Account | Address,
  ) {}

  /**
   * Server-side relayer: owns a funded key and its own HTTP transport.
   *
   * The key pays gas and nothing else — it holds no protocol authority, so its
   * compromise costs money, never control of a wallet.
   */
  static fromAccount(ctx: RecoveryContext, rpcUrl: string, account: Account): RecoveryRelay {
    const wallet = createWalletClient({
      account,
      chain: chainFor(ctx.chainId),
      transport: http(rpcUrl),
    });
    return new RecoveryRelay(ctx, wallet, account);
  }

  /**
   * Browser: drive writes through a wallet the user already connected.
   *
   * @throws if the client carries no account — a wallet client without one cannot
   *         sign, and failing here beats an opaque error at transaction time.
   */
  static fromWalletClient(ctx: RecoveryContext, wallet: WalletClient): RecoveryRelay {
    if (!wallet.account) {
      throw new Error("RecoveryRelay: wallet client has no account connected");
    }
    return new RecoveryRelay(ctx, wallet, wallet.account);
  }

  /** The address that will sign and pay for writes. */
  get sender(): Address {
    return typeof this.account === "string" ? this.account : this.account.address;
  }

  private get chain(): SupportedChain {
    return chainFor(this.ctx.chainId);
  }

  /** Owner-only: publish the encrypted guardian set. */
  async setGuardianPayload(payload: EncryptedPayload, set: GuardianSet): Promise<Hash> {
    return this.wallet.writeContract({
      address: this.ctx.contractAddress,
      abi: DSRP_ABI,
      functionName: "setGuardianPayload",
      args: [payload.ciphertext, set.guardians.map((g) => g.accountSalt), BigInt(set.threshold)],
      chain: this.chain,
      account: this.account,
    });
  }

  async initiateRecovery(newOwner: Address): Promise<Hash> {
    return this.wallet.writeContract({
      address: this.ctx.contractAddress,
      abi: DSRP_ABI,
      functionName: "initiateRecovery",
      args: [newOwner],
      chain: this.chain,
      account: this.account,
    });
  }

  /**
   * Relay a guardian's approval.
   *
   * The command is re-derived locally and compared before sending. The contract
   * would reject a mismatch anyway, but it would do so after the gas was spent —
   * and a mismatch almost always means the SDK's command mirror has drifted from
   * the contract's, which is worth surfacing loudly rather than as a revert.
   */
  async submitEmailProof(
    requestId: bigint,
    newOwner: Address,
    proof: EmailProofStruct,
  ): Promise<Hash> {
    this.assertCommandMatches(requestId, newOwner, proof);

    return this.wallet.writeContract({
      address: this.ctx.contractAddress,
      abi: DSRP_ABI,
      functionName: "submitEmailProof",
      args: [requestId, proof],
      chain: this.chain,
      account: this.account,
    });
  }

  async executeRecovery(requestId: bigint): Promise<Hash> {
    return this.wallet.writeContract({
      address: this.ctx.contractAddress,
      abi: DSRP_ABI,
      functionName: "executeRecovery",
      args: [requestId],
      chain: this.chain,
      account: this.account,
    });
  }

  /** Owner-only: the veto. */
  async cancelRecovery(requestId: bigint): Promise<Hash> {
    return this.wallet.writeContract({
      address: this.ctx.contractAddress,
      abi: DSRP_ABI,
      functionName: "cancelRecovery",
      args: [requestId],
      chain: this.chain,
      account: this.account,
    });
  }

  /** Simulates first, so a doomed proof never reaches the mempool. */
  async simulateSubmitEmailProof(
    client: DsrpPublicClient,
    requestId: bigint,
    proof: EmailProofStruct,
  ): Promise<void> {
    await client.simulateContract({
      address: this.ctx.contractAddress,
      abi: DSRP_ABI,
      functionName: "submitEmailProof",
      args: [requestId, proof],
      account: this.account,
    });
  }

  /**
   * Checked before every proof submission, and exposed so a UI can validate an
   * uploaded email without building a relay or connecting a wallet.
   */
  assertCommandMatches(
    requestId: bigint,
    newOwner: Address,
    proof: Pick<EmailProofStruct, "maskedCommand">,
  ): void {
    const expected = canonicalCommand(this.ctx, requestId, newOwner);
    if (proof.maskedCommand !== expected) {
      throw new Error(
        `proof command does not match this request.\n  expected: ${expected}\n  actual:   ${proof.maskedCommand}`,
      );
    }
  }
}
