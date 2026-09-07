import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import { canonicalCommand } from "../src/command.js";

interface Fixtures {
  contractAddress: Address;
  chainId: number;
  cases: { requestId: string; newOwner: Address; command: string }[];
}

const FIXTURE_PATH = fileURLToPath(
  new URL("../../contracts/test/fixtures/canonical-commands.json", import.meta.url),
);

const fixtures: Fixtures = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

describe("canonicalCommand — conformance with Solidity", () => {
  // These fixtures are regenerated from the deployed bytecode by
  // `CanonicalCommandFixturesTest`. The contract is the source of truth; if this
  // suite fails, the TypeScript mirror has drifted and every guardian proof it
  // produces would be rejected on-chain.
  it.each(fixtures.cases)(
    "matches the contract for request $requestId",
    ({ requestId, newOwner, command }) => {
      const actual = canonicalCommand(
        { contractAddress: fixtures.contractAddress, chainId: fixtures.chainId },
        BigInt(requestId),
        newOwner,
      );
      expect(actual).toBe(command);
    },
  );

  it("covers uint256 extremes, so the mirror is not just tested on small ids", () => {
    const ids = fixtures.cases.map((c) => BigInt(c.requestId));
    expect(ids).toContain(2n ** 256n - 1n);
    expect(ids.some((id) => id > 2n ** 32n)).toBe(true);
  });
});

describe("canonicalCommand — encoding properties", () => {
  const ctx = {
    contractAddress: "0xF62849F9A0B5Bf2913b396098F7c7019b51A820a" as Address,
    chainId: 8453,
  };
  const owner = "0x7240b687730BE024bcfD084621f794C2e4F8408f" as Address;

  it("lowercases addresses, matching Strings.toHexString", () => {
    const command = canonicalCommand(ctx, 1n, owner);
    expect(command).toContain(ctx.contractAddress.toLowerCase());
    expect(command).toContain(owner.toLowerCase());
    expect(command).not.toContain(ctx.contractAddress);
  });

  it("is insensitive to the caller's address casing", () => {
    expect(canonicalCommand(ctx, 1n, owner)).toBe(
      canonicalCommand(
        { ...ctx, contractAddress: ctx.contractAddress.toLowerCase() as Address },
        1n,
        owner.toUpperCase().replace("0X", "0x") as Address,
      ),
    );
  });

  it("varies with requestId, newOwner, chainId and contract", () => {
    const base = canonicalCommand(ctx, 1n, owner);
    expect(canonicalCommand(ctx, 2n, owner)).not.toBe(base);
    expect(canonicalCommand(ctx, 1n, "0x0000000000000000000000000000000000000001")).not.toBe(base);
    expect(canonicalCommand({ ...ctx, chainId: 84532 }, 1n, owner)).not.toBe(base);
    expect(
      canonicalCommand({ ...ctx, contractAddress: "0x" + "1".repeat(40) as Address }, 1n, owner),
    ).not.toBe(base);
  });

  it("is injective across id/owner pairs", () => {
    const seen = new Set<string>();
    for (const id of [0n, 1n, 10n, 11n, 100n]) {
      for (const addr of ["0x" + "a".repeat(40), "0x" + "b".repeat(40)] as Address[]) {
        seen.add(canonicalCommand(ctx, id, addr));
      }
    }
    expect(seen.size).toBe(10);
  });

  it("rejects anything that is not a 20-byte hex address", () => {
    expect(() => canonicalCommand(ctx, 1n, "0xdeadbeef" as Address)).toThrow(/not a 20-byte hex/);
    expect(() => canonicalCommand({ ...ctx, contractAddress: "nope" as Address }, 1n, owner))
      .toThrow(/not a 20-byte hex/);
  });
});
