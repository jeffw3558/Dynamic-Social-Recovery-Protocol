import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { keccak256, toHex, type Hex } from "viem";

import type { EncryptedPayload, GuardianSet, RecoveryContext } from "../types.js";
import { assertValidGuardianSet, type GuardianVault } from "./GuardianVault.js";

/**
 * Local AES-256-GCM vault for tests, CI and local development.
 *
 * ⚠️  NOT SECURE, AND NOT MEANT TO BE. The key is derived from a caller-supplied
 * secret (or a fixed default), so anyone holding this code can decrypt anything it
 * produced. It exists so the entire test suite runs offline with no Lit account,
 * no network and no key material — never point it at a real guardian set.
 *
 * It is a faithful stand-in for the one thing the protocol depends on: producing
 * opaque bytes that round-trip. The contract cannot tell the difference, which is
 * precisely why the port is worth having.
 */
export class MockVault implements GuardianVault {
  readonly scheme = "mock-aes-gcm" as const;

  constructor(private readonly secret: string = "dsrp-development-only") {}

  async encrypt(set: GuardianSet, ctx: RecoveryContext): Promise<EncryptedPayload> {
    assertValidGuardianSet(set);

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.deriveKey(ctx), iv);
    const body = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(set), "utf8")),
      cipher.final(),
    ]);
    const ciphertext = toHex(Buffer.concat([iv, cipher.getAuthTag(), body]));

    return { ciphertext, hash: keccak256(ciphertext), scheme: this.scheme };
  }

  async decrypt(payload: EncryptedPayload, ctx: RecoveryContext): Promise<GuardianSet> {
    if (keccak256(payload.ciphertext) !== payload.hash) {
      throw new Error("MockVault: payload hash does not match ciphertext");
    }

    const raw = Buffer.from(payload.ciphertext.slice(2), "hex");
    const decipher = createDecipheriv("aes-256-gcm", this.deriveKey(ctx), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));

    const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as GuardianSet;
  }

  /** Binds the key to the deployment, so a payload cannot be moved between contracts. */
  private deriveKey(ctx: RecoveryContext): Buffer {
    const info = `${ctx.chainId}:${ctx.contractAddress.toLowerCase()}`;
    return Buffer.from(
      hkdfSync("sha256", Buffer.from(this.secret, "utf8"), Buffer.alloc(0), info, 32),
    );
  }
}

/** Convenience for tests that need a salt without running the real circuit. */
export function mockAccountSalt(email: string): Hex {
  return keccak256(toHex(`mock-account-salt:${email.trim().toLowerCase()}`));
}
