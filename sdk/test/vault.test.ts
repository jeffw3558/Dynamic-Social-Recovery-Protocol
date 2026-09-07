import { describe, expect, it } from "vitest";
import { keccak256, type Address, type Hex } from "viem";

import { MockVault, mockAccountSalt } from "../src/vault/MockVault.js";
import { assertValidGuardianSet } from "../src/vault/GuardianVault.js";
import type { GuardianSet, RecoveryContext } from "../src/types.js";

const ctx: RecoveryContext = {
  contractAddress: "0xF62849F9A0B5Bf2913b396098F7c7019b51A820a" as Address,
  chainId: 8453,
};

const set: GuardianSet = {
  threshold: 2,
  guardians: [
    { email: "alice@example.com", accountSalt: mockAccountSalt("alice@example.com") },
    { email: "bob@example.com", accountSalt: mockAccountSalt("bob@example.com") },
    { email: "carol@example.com", accountSalt: mockAccountSalt("carol@example.com") },
  ],
};

describe("MockVault", () => {
  it("round-trips a guardian set", async () => {
    const vault = new MockVault();
    const payload = await vault.encrypt(set, ctx);
    await expect(vault.decrypt(payload, ctx)).resolves.toEqual(set);
  });

  it("reports a hash matching the on-chain guardianPayloadHash", async () => {
    const payload = await new MockVault().encrypt(set, ctx);
    expect(payload.hash).toBe(keccak256(payload.ciphertext));
    expect(payload.scheme).toBe("mock-aes-gcm");
  });

  it("produces different ciphertext each time (fresh IV)", async () => {
    const vault = new MockVault();
    const a = await vault.encrypt(set, ctx);
    const b = await vault.encrypt(set, ctx);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("binds the payload to the deployment", async () => {
    const vault = new MockVault();
    const payload = await vault.encrypt(set, ctx);

    // Same ciphertext, different contract — must not decrypt.
    await expect(
      vault.decrypt(payload, { ...ctx, contractAddress: ("0x" + "1".repeat(40)) as Address }),
    ).rejects.toThrow();

    await expect(vault.decrypt(payload, { ...ctx, chainId: 84532 })).rejects.toThrow();
  });

  it("rejects a tampered payload via the auth tag", async () => {
    const vault = new MockVault();
    const payload = await vault.encrypt(set, ctx);

    const bytes = Buffer.from(payload.ciphertext.slice(2), "hex");
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = `0x${bytes.toString("hex")}` as Hex;

    await expect(
      vault.decrypt({ ...payload, ciphertext: tampered, hash: keccak256(tampered) }, ctx),
    ).rejects.toThrow();
  });

  it("rejects a payload whose declared hash does not match", async () => {
    const vault = new MockVault();
    const payload = await vault.encrypt(set, ctx);
    await expect(
      vault.decrypt({ ...payload, hash: keccak256("0xdeadbeef") }, ctx),
    ).rejects.toThrow(/hash does not match/);
  });

  it("does not decrypt under a different secret", async () => {
    const payload = await new MockVault("secret-a").encrypt(set, ctx);
    await expect(new MockVault("secret-b").decrypt(payload, ctx)).rejects.toThrow();
  });
});

describe("assertValidGuardianSet — mirrors the contract's preconditions", () => {
  it("accepts a well-formed set", () => {
    expect(() => assertValidGuardianSet(set)).not.toThrow();
  });

  it("rejects an empty set", () => {
    expect(() => assertValidGuardianSet({ guardians: [], threshold: 1 })).toThrow(/empty/);
  });

  it("rejects a threshold outside [1, guardians.length]", () => {
    expect(() => assertValidGuardianSet({ ...set, threshold: 0 })).toThrow(/outside/);
    expect(() => assertValidGuardianSet({ ...set, threshold: 4 })).toThrow(/outside/);
    expect(() => assertValidGuardianSet({ ...set, threshold: 1.5 })).toThrow(/outside/);
  });

  it("rejects more than MAX_GUARDIANS", () => {
    const many = Array.from({ length: 65 }, (_, i) => ({
      email: `g${i}@example.com`,
      accountSalt: mockAccountSalt(`g${i}@example.com`),
    }));
    expect(() => assertValidGuardianSet({ guardians: many, threshold: 1 })).toThrow(/too many/);
  });

  it("rejects duplicate salts, which would inflate the threshold denominator", () => {
    const dup = [set.guardians[0]!, set.guardians[0]!];
    expect(() => assertValidGuardianSet({ guardians: dup, threshold: 1 })).toThrow(/duplicate/);
  });

  it("rejects the zero salt", () => {
    expect(() =>
      assertValidGuardianSet({
        guardians: [{ email: "x@y.z", accountSalt: `0x${"0".repeat(64)}` }],
        threshold: 1,
      }),
    ).toThrow(/zero accountSalt/);
  });
});
