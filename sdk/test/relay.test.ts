import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, type Address } from "viem";

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
  const relay = RecoveryRelay.fromAccount(ctx, "http://127.0.0.1:8545", account);

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

describe("RecoveryRelay — construction paths", () => {
  it("exposes the sender for an account-backed relayer", () => {
    const relay = RecoveryRelay.fromAccount(ctx, "http://127.0.0.1:8545", account);
    expect(relay.sender).toBe(account.address);
  });

  it("accepts an injected wallet client, as a browser supplies", () => {
    const wallet = createWalletClient({
      account,
      chain: chainFor(ctx.chainId),
      transport: http("http://127.0.0.1:8545"),
    });
    const relay = RecoveryRelay.fromWalletClient(ctx, wallet);
    expect(relay.sender).toBe(account.address);
  });

  it("refuses a wallet client with no account rather than failing at send time", () => {
    const walletless = createWalletClient({
      chain: chainFor(ctx.chainId),
      transport: http("http://127.0.0.1:8545"),
    });
    expect(() => RecoveryRelay.fromWalletClient(ctx, walletless)).toThrow(
      /no account connected/,
    );
  });

  it("validates a command without needing a wallet, for UI pre-flight", () => {
    const relay = RecoveryRelay.fromAccount(ctx, "http://127.0.0.1:8545", account);
    expect(() =>
      relay.assertCommandMatches(1n, newOwner, {
        maskedCommand: canonicalCommand(ctx, 1n, newOwner),
      }),
    ).not.toThrow();
    expect(() =>
      relay.assertCommandMatches(1n, newOwner, { maskedCommand: "wrong" }),
    ).toThrow(/does not match this request/);
  });
});

describe("chainFor", () => {
  it("resolves the Base chains Chipotle anchors to", () => {
    expect(chainFor(8453).id).toBe(8453);
    expect(chainFor(84532).id).toBe(84532);
  });

  it("resolves anvil, the only place the 48h lifecycle is testable", () => {
    expect(chainFor(31337).id).toBe(31337);
  });

  it("rejects an unsupported chain rather than guessing", () => {
    expect(() => chainFor(1)).toThrow(/unsupported chainId 1/);
  });
});
