import type { Address, Hex } from "viem";

/** A guardian, as held in plaintext only inside the encrypted payload. */
export interface Guardian {
  /** The guardian's email address. Never leaves the ciphertext. */
  readonly email: string;
  /**
   * Commitment published on-chain in place of the address.
   *
   * In production this MUST equal the `accountSalt` the blueprint's circuit derives
   * (Poseidon over the email address and the guardian's account code). Deriving it any
   * other way produces commitments no real proof will ever match.
   */
  readonly accountSalt: Hex;
}

/** The full guardian configuration. This is the plaintext that gets encrypted. */
export interface GuardianSet {
  readonly guardians: readonly Guardian[];
  /** Approvals required to execute a recovery. Must be within [1, guardians.length]. */
  readonly threshold: number;
}

/** Opaque ciphertext as stored on-chain. */
export interface EncryptedPayload {
  /** Ciphertext bytes, written verbatim to `guardianPayload`. */
  readonly ciphertext: Hex;
  /** keccak256 of the ciphertext; mirrors `guardianPayloadHash`. */
  readonly hash: Hex;
  /** Which vault produced this, so a reader knows how to decrypt it. */
  readonly scheme: "chipotle-v3" | "mock-aes-gcm";
}

/** Identifies the deployment a payload or command is bound to. */
export interface RecoveryContext {
  readonly contractAddress: Address;
  readonly chainId: number;
  /** Present when decrypting against a specific in-flight request. */
  readonly requestId?: bigint;
}

/** Mirror of the Solidity `EmailProof` struct. Field order matters for ABI encoding. */
export interface EmailProofStruct {
  readonly domainName: string;
  readonly publicKeyHash: Hex;
  readonly timestamp: bigint;
  readonly maskedCommand: string;
  readonly emailNullifier: Hex;
  readonly accountSalt: Hex;
  readonly isCodeExist: boolean;
  readonly proof: Hex;
}

/** On-chain view of a recovery request. */
export interface RecoveryRequest {
  readonly newOwner: Address;
  readonly timestamp: bigint;
  readonly proofCount: number;
  readonly executed: boolean;
  readonly cancelled: boolean;
}
