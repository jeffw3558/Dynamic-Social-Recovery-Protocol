import {
  createWalletClient,
  http,
  type Account,
  type Address,
  type Hash,
  type WalletClient,
} from "viem";

import { DSRP_ABI } from "./abi.js";
import { chainFor, type DsrpPublicClient } from "./client.js";
import { canonicalCommand } from "../command.js";
import type { EmailProofStruct, EncryptedPayload, GuardianSet, RecoveryContext } from "../types.js";

/**
 * Submits transactions to {@link DynamicSocialRecovery}.
 *
 * Relaying is trustless: the contract's seven checks make every proof
 * self-authenticating and single-use, so an arbitrary third party can pay the gas
 * without being trusted with anything. A hostile relayer can withhold or delay a
 * proof; it cannot forge, alter, redirect or replay one.
 */
export class RecoveryRelay {
  private readonly wallet: WalletClient;

  constructor(
    private readonly ctx: RecoveryContext,
    rpcUrl: string,
    account: Account,
  ) {
    this.wallet = createWalletClient({
      account,
      chain: chainFor(ctx.chainId),
      transport: http(rpcUrl),
    });
  }

  /** Owner-only: publish the encrypted guardian set. */
  async setGuardianPayload(
    payload: EncryptedPayload,
    set: GuardianSet,
  ): Promise<Hash> {
    return this.wallet.writeContract({
      address: this.ctx.contractAddress,
      abi: DSRP_ABI,
      functionName: "setGuardianPayload",
      args: [payload.ciphertext, set.guardians.map((g) => g.accountSalt), BigInt(set.threshold)],
      chain: chainFor(this.ctx.chainId),
      account: this.wallet.account!,
    });
  }

  async initiateRecovery(newOwner: Address): Promise<Hash> {
    return this.wallet.writeContract({
      address: this.ctx.contractAddress,
      abi: DSRP_ABI,
      functionName: "initiateRecovery",
      args: [newOwner],
      chain: chainFor(this.ctx.chainId),
      account: this.wallet.account!,
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
    const expected = canonicalCommand(this.ctx, requestId, newOwner);
    if (proof.maskedCommand !== expected) {
      throw new Error(
        `proof command does not match this request.\n  expected: ${expected}\n  actual:   ${proof.maskedCommand}`,
      );
    }

    return this.wallet.writeContract({
      address: this.ctx.contractAddress,
      abi: DSRP_ABI,
      functionName: "submitEmailProof",
      args: [requestId, proof],
      chain: chainFor(this.ctx.chainId),
      account: this.wallet.account!,
    });
  }

  async executeRecovery(requestId: bigint): Promise<Hash> {
    return this.wallet.writeContract({
      address: this.ctx.contractAddress,
      abi: DSRP_ABI,
      functionName: "executeRecovery",
      args: [requestId],
      chain: chainFor(this.ctx.chainId),
      account: this.wallet.account!,
    });
  }

  /** Owner-only: the veto. */
  async cancelRecovery(requestId: bigint): Promise<Hash> {
    return this.wallet.writeContract({
      address: this.ctx.contractAddress,
      abi: DSRP_ABI,
      functionName: "cancelRecovery",
      args: [requestId],
      chain: chainFor(this.ctx.chainId),
      account: this.wallet.account!,
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
      account: this.wallet.account!,
    });
  }
}
