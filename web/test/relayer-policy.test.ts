import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import {
  assertAffordable,
  assertChainAllowed,
  assertContractAllowed,
  InMemoryRelayStore,
  loadPolicy,
  parseEmailProof,
  PolicyError,
  withNonceLock,
  worstCaseCostWei,
  type RelayerPolicy,
} from "@/lib/server/relayer-policy";

const GOOD = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as Address;
const ATTACKER = "0x00000000000000000000000000000000deadbeef" as Address;

const gwei = (n: number) => BigInt(n) * 10n ** 9n;
const eth = (n: number) => BigInt(n) * 10n ** 18n;

function policy(over: Partial<RelayerPolicy> = {}): RelayerPolicy {
  return {
    allowedContracts: new Set([GOOD.toLowerCase()]),
    chainId: 8453,
    maxGas: 1_500_000n,
    maxFeePerGasWei: gwei(50),
    minBalanceWei: eth(1) / 100n,
    budgetWei: eth(1) / 10n,
    budgetWindowMs: 86_400_000,
    maxPerWindow: 5,
    rateWindowMs: 60_000,
    ...over,
  };
}

describe("assertContractAllowed — the control that stops key drain", () => {
  // `contractAddress` arrives in the request body and becomes the call target.
  // Without this check an attacker points the relayer at their own contract, which
  // burns the block gas limit on every call, and rate limiting only decides how
  // fast the key empties.
  it("permits an allowlisted deployment", () => {
    expect(() => assertContractAllowed(policy(), GOOD)).not.toThrow();
  });

  it("is case-insensitive about the address", () => {
    expect(() =>
      assertContractAllowed(policy(), GOOD.toLowerCase() as Address),
    ).not.toThrow();
    expect(() =>
      assertContractAllowed(policy(), GOOD.toUpperCase().replace("0X", "0x") as Address),
    ).not.toThrow();
  });

  it("refuses an arbitrary attacker-supplied contract", () => {
    expect(() => assertContractAllowed(policy(), ATTACKER)).toThrow(PolicyError);
    expect(() => assertContractAllowed(policy(), ATTACKER)).toThrow(/does not subsidise/);
  });

  it("fails closed when no allowlist is configured", () => {
    // An unset allowlist must refuse everything. Failing open here costs the whole
    // relayer balance; failing closed costs an outage.
    const empty = policy({ allowedContracts: new Set() });
    expect(() => assertContractAllowed(empty, GOOD)).toThrow(/no allowlisted contracts/);
    try {
      assertContractAllowed(empty, GOOD);
    } catch (e) {
      expect((e as PolicyError).status).toBe(503);
    }
  });
});

describe("assertChainAllowed", () => {
  it("permits the configured chain and refuses others", () => {
    expect(() => assertChainAllowed(policy(), 8453)).not.toThrow();
    expect(() => assertChainAllowed(policy(), 1)).toThrow(/only submits to chain 8453/);
  });
});

describe("assertAffordable", () => {
  const ok = { gas: 300_000n, maxFeePerGas: gwei(2), balance: eth(1), spentInWindow: 0n };

  it("permits a normal submission", () => {
    expect(() => assertAffordable(policy(), ok)).not.toThrow();
  });

  it("refuses a transaction above the gas ceiling", () => {
    expect(() => assertAffordable(policy(), { ...ok, gas: 5_000_000n })).toThrow(
      /above this relayer's 1500000 ceiling/,
    );
  });

  it("refuses to bid into a fee spike", () => {
    expect(() => assertAffordable(policy(), { ...ok, maxFeePerGas: gwei(500) })).toThrow(
      /fees are above/i,
    );
  });

  it("refuses to spend below the balance floor", () => {
    const nearlyEmpty = { ...ok, gas: 1_000_000n, maxFeePerGas: gwei(40), balance: eth(1) / 1000n };
    expect(() => assertAffordable(policy(), nearlyEmpty)).toThrow(/out of funds/);
  });

  it("refuses once the rolling budget is exhausted", () => {
    expect(() =>
      assertAffordable(policy(), { ...ok, spentInWindow: eth(1) / 10n }),
    ).toThrow(/spending budget/);
  });

  it("counts worst-case cost, not expected cost", () => {
    // Budget must be committed at the fee ceiling the transaction could actually
    // pay, or a run of expensive blocks quietly overspends it.
    expect(worstCaseCostWei(300_000n, gwei(2))).toBe(600_000n * 10n ** 9n);
  });
});

describe("InMemoryRelayStore", () => {
  let store: InMemoryRelayStore;
  beforeEach(() => {
    store = new InMemoryRelayStore();
  });

  it("permits up to the limit, then blocks", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await store.hitRateLimit("ip", 5, 60_000)).toBe(false);
    }
    expect(await store.hitRateLimit("ip", 5, 60_000)).toBe(true);
  });

  it("tracks callers independently", async () => {
    for (let i = 0; i < 6; i++) await store.hitRateLimit("a", 5, 60_000);
    expect(await store.hitRateLimit("b", 5, 60_000)).toBe(false);
  });

  it("accumulates spend inside the window", async () => {
    await store.recordSpend(100n);
    await store.recordSpend(50n);
    expect(await store.spentInWindow(60_000)).toBe(150n);
  });

  it("drops spend that has aged out of the window", async () => {
    vi.useFakeTimers();
    try {
      await store.recordSpend(100n);
      expect(await store.spentInWindow(60_000)).toBe(100n);

      vi.advanceTimersByTime(61_000);
      expect(await store.spentInWindow(60_000)).toBe(0n);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a rate-limited caller back in once the window passes", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) await store.hitRateLimit("ip", 5, 60_000);
      expect(await store.hitRateLimit("ip", 5, 60_000)).toBe(true);

      vi.advanceTimersByTime(61_000);
      expect(await store.hitRateLimit("ip", 5, 60_000)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("withNonceLock", () => {
  it("serialises submissions so two callers cannot share a nonce", async () => {
    const order: string[] = [];
    const task = (id: string, ms: number) => async () => {
      order.push(`${id}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${id}:end`);
      return id;
    };

    const [a, b] = await Promise.all([
      withNonceLock(task("a", 30)),
      withNonceLock(task("b", 1)),
    ]);

    expect([a, b]).toEqual(["a", "b"]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("keeps running after a failure rather than deadlocking the queue", async () => {
    await expect(withNonceLock(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withNonceLock(async () => "still works")).resolves.toBe("still works");
  });
});

describe("loadPolicy", () => {
  it("reads the allowlist from the environment", () => {
    process.env.RELAYER_ALLOWED_CONTRACTS = `${GOOD}, ${ATTACKER}`;
    process.env.NEXT_PUBLIC_CHAIN_ID = "8453";
    const p = loadPolicy();
    expect(p.allowedContracts.has(GOOD.toLowerCase())).toBe(true);
    expect(p.chainId).toBe(8453);
    delete process.env.RELAYER_ALLOWED_CONTRACTS;
  });

  it("ignores malformed entries instead of trusting them", () => {
    process.env.RELAYER_ALLOWED_CONTRACTS = "not-an-address, 0x123, ";
    expect(loadPolicy().allowedContracts.size).toBe(0);
    delete process.env.RELAYER_ALLOWED_CONTRACTS;
  });
});

describe("parseEmailProof", () => {
  const valid = {
    domainName: "gmail.com",
    publicKeyHash: `0x${"ab".repeat(32)}`,
    timestamp: "1788835041",
    maskedCommand: "Approve recovery of wallet 0x… request 1 to new owner 0x…",
    emailNullifier: `0x${"cd".repeat(32)}`,
    accountSalt: `0x${"ef".repeat(32)}`,
    isCodeExist: true,
    proof: "0x01",
  };

  it("accepts a well-formed proof and rebuilds the bigint", () => {
    const parsed = parseEmailProof(valid);
    expect(parsed.timestamp).toBe(1788835041n);
    expect(parsed.domainName).toBe("gmail.com");
  });

  it("accepts a missing timestamp as 0, which blueprints without one report", () => {
    const { timestamp, ...rest } = valid;
    expect(parseEmailProof(rest).timestamp).toBe(0n);
  });

  // Before this validator, an empty object reached viem's encoder and surfaced as
  // "Cannot read properties of undefined (reading 'length')" — useless to the
  // caller and a leak of internal shape.
  it("rejects an empty object with a field-specific message", () => {
    expect(() => parseEmailProof({})).toThrow(/proof.domainName must be a non-empty string/);
  });

  it("rejects a non-object", () => {
    expect(() => parseEmailProof(null)).toThrow(/must be an object/);
    expect(() => parseEmailProof("0xdeadbeef")).toThrow(/must be an object/);
  });

  it.each(["publicKeyHash", "emailNullifier", "accountSalt"])(
    "rejects a malformed %s",
    (field) => {
      expect(() => parseEmailProof({ ...valid, [field]: "0x1234" })).toThrow(
        new RegExp(`proof.${field} must be 32-byte hex`),
      );
    },
  );

  it("rejects a non-hex proof blob", () => {
    expect(() => parseEmailProof({ ...valid, proof: "not-hex" })).toThrow(/must be a hex string/);
  });

  it("rejects a negative timestamp", () => {
    expect(() => parseEmailProof({ ...valid, timestamp: "-1" })).toThrow(/must not be negative/);
  });

  it("treats a non-boolean isCodeExist as false rather than passing it through", () => {
    expect(parseEmailProof({ ...valid, isCodeExist: "yes" }).isCodeExist).toBe(false);
  });

  it("carries a 400 status, so malformed input is not reported as a server fault", () => {
    try {
      parseEmailProof({});
    } catch (e) {
      expect((e as PolicyError).status).toBe(400);
    }
  });
});
