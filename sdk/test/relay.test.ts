import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

import { RecoveryRelay } from "../src/chain/relay.js";
import { chainFor } from "../src/chain/client.js";
import { canonicalCommand } from "../src/command.js";
import type { EmailProofStruct, RecoveryContext } from "../src/types.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

const ctx: RecoveryContext = {
  contractAddress: "0xF62849F9A0B5Bf2913b396098F7c7019b51A820a" as Address,
  chainId: 8453,
};

const newOwner = "0x7240b687730BE024bcfD084621f794C2e4F8408f" as Address;

function proofWithCommand(command: string): EmailProofStruct {
  return {
    domainName: "gmail.com",
    publicKeyHash: `0x${"ab".repeat(32)}`,
    timestamp: 1_800_000_000n,
    maskedCommand: command,
    emailNullifier: `0x${"cd".repeat(32)}`,
    accountSalt: `0x${"ef".repeat(32)}`,
    isCodeExist: true,
    proof: "0x01",
  };
}

describe("RecoveryRelay — command pre-flight", () => {
  const relay = new RecoveryRelay(ctx, "http://127.0.0.1:8545", account);

  // The contract rejects a mismatched command anyway, but only after the gas is
  // spent — and a mismatch nearly always means the SDK's mirror has drifted, which
  // deserves a loud local failure rather than an opaque on-chain revert.
  it("refuses a proof bound to a different request before sending", async () => {
    const wrong = proofWithCommand(canonicalCommand(ctx, 999n, newOwner));
    await expect(relay.submitEmailProof(1n, newOwner, wrong)).rejects.toThrow(
      /does not match this request/,
    );
  });

  it("refuses a proof bound to a different proposed owner", async () => {
    const other = "0x0000000000000000000000000000000000000009" as Address;
    const wrong = proofWithCommand(canonicalCommand(ctx, 1n, other));
    await expect(relay.submitEmailProof(1n, newOwner, wrong)).rejects.toThrow(
      /does not match this request/,
    );
  });

  it("refuses a proof bound to another chain", async () => {
    const wrong = proofWithCommand(canonicalCommand({ ...ctx, chainId: 84532 }, 1n, newOwner));
    await expect(relay.submitEmailProof(1n, newOwner, wrong)).rejects.toThrow(
      /does not match this request/,
    );
  });

  it("surfaces both strings so drift is diagnosable", async () => {
    const wrong = proofWithCommand("Approve recovery of wallet 0xdead");
    await expect(relay.submitEmailProof(1n, newOwner, wrong)).rejects.toThrow(
      /expected:[\s\S]*actual:/,
    );
  });
});

describe("chainFor", () => {
  it("resolves the Base chains Chipotle anchors to", () => {
    expect(chainFor(8453).id).toBe(8453);
    expect(chainFor(84532).id).toBe(84532);
  });

  it("rejects an unsupported chain rather than guessing", () => {
    expect(() => chainFor(1)).toThrow(/unsupported chainId 1/);
  });
});
