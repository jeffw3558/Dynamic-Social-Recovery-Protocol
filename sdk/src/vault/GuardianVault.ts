import type { EncryptedPayload, GuardianSet, RecoveryContext } from "../types.js";

/**
 * The boundary between this protocol and whatever threshold-encryption network is
 * current.
 *
 * Lit has replaced its encryption surface three times in about eighteen months —
 * Datil (sunset 2026-02-25), Naga (sunset 2026-04-01), now Chipotle. Declarative
 * Access Control Conditions did not survive that last migration. Confining all of
 * it behind two methods means the next migration touches one adapter file instead
 * of the protocol.
 *
 * The contract never learns any of this: `guardianPayload` is `bytes`, and the
 * contract never interprets it.
 */
export interface GuardianVault {
  /** Human-readable adapter name, recorded in {@link EncryptedPayload.scheme}. */
  readonly scheme: EncryptedPayload["scheme"];

  /** Encrypt a guardian set for storage on-chain. */
  encrypt(set: GuardianSet, ctx: RecoveryContext): Promise<EncryptedPayload>;

  /**
   * Decrypt a stored payload.
   *
   * Implementations that gate on chain state (Chipotle) will reject unless the
   * recovery genuinely qualifies, so this can fail for reasons that are correct
   * rather than exceptional.
   */
  decrypt(payload: EncryptedPayload, ctx: RecoveryContext): Promise<GuardianSet>;
}

/** Thrown when a vault refuses to release plaintext. */
export class VaultAccessDeniedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultAccessDeniedError";
  }
}

/** Guards the invariant the contract also enforces, before wasting a transaction. */
export function assertValidGuardianSet(set: GuardianSet): void {
  const { guardians, threshold } = set;
  if (guardians.length === 0) throw new Error("guardian set is empty");
  if (guardians.length > 64) throw new Error(`too many guardians: ${guardians.length} > 64`);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > guardians.length) {
    throw new Error(`threshold ${threshold} outside [1, ${guardians.length}]`);
  }
  const salts = new Set(guardians.map((g) => g.accountSalt.toLowerCase()));
  if (salts.size !== guardians.length) throw new Error("duplicate accountSalt in guardian set");
  if (salts.has(`0x${"0".repeat(64)}`)) throw new Error("zero accountSalt is not permitted");
}
