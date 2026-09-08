import "server-only";

import type { Address } from "viem";

/**
 * Spend policy for the relayer.
 *
 * The relayer's key holds no protocol authority — it pays gas and nothing else,
 * so its compromise costs money rather than control of a wallet. That makes
 * *economic* drain the entire threat model, and this module is what bounds it.
 *
 * The load-bearing control is {@link assertContractAllowed}. The route takes a
 * `contractAddress` from the request body and calls it; without an allowlist, an
 * attacker points the relayer at a contract of their own that exposes a matching
 * `submitEmailProof` signature and burns the block gas limit on every call. Rate
 * limiting does not help there — it only decides how fast the key drains.
 *
 * Everything else is defence in depth: a gas ceiling bounds the worst single
 * transaction, a fee ceiling stops the relayer bidding into a gas spike, a balance
 * floor keeps it from emptying itself, and a rolling budget caps the total.
 */
export interface RelayerPolicy {
  /** Deployments this relayer is willing to subsidise. Lowercased. */
  readonly allowedContracts: ReadonlySet<string>;
  /** The only chain it will submit to. */
  readonly chainId: number;
  /** Refuse any transaction estimating above this much gas. */
  readonly maxGas: bigint;
  /** Refuse to submit when the network fee exceeds this, in wei. */
  readonly maxFeePerGasWei: bigint;
  /** Never spend the balance below this reserve, in wei. */
  readonly minBalanceWei: bigint;
  /** Total worst-case spend permitted per {@link budgetWindowMs}, in wei. */
  readonly budgetWei: bigint;
  readonly budgetWindowMs: number;
  /** Submissions permitted per caller per {@link rateWindowMs}. */
  readonly maxPerWindow: number;
  readonly rateWindowMs: number;
}

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

const gwei = (n: number) => BigInt(Math.round(n * 1e9));
const eth = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

function envBigInt(name: string, fallback: bigint, parse: (n: number) => bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return parse(n);
}

export function loadPolicy(): RelayerPolicy {
  const configured = (process.env.RELAYER_ALLOWED_CONTRACTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));

  // In development, fall back to whatever the app itself is pointed at, so the
  // local loop works without extra configuration. In production an unset allowlist
  // means every request is refused: failing closed here costs an outage, whereas
  // failing open costs the whole relayer balance.
  const fallback =
    process.env.NODE_ENV === "production"
      ? []
      : [(process.env.NEXT_PUBLIC_DSRP_ADDRESS ?? "").toLowerCase()].filter((s) =>
          /^0x[0-9a-f]{40}$/.test(s),
        );

  return {
    allowedContracts: new Set(configured.length > 0 ? configured : fallback),
    chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337),
    maxGas: envBigInt("RELAYER_MAX_GAS", 1_500_000n, (n) => BigInt(Math.round(n))),
    maxFeePerGasWei: envBigInt("RELAYER_MAX_FEE_GWEI", gwei(50), gwei),
    minBalanceWei: envBigInt("RELAYER_MIN_BALANCE_ETH", eth(0.01), eth),
    budgetWei: envBigInt("RELAYER_BUDGET_ETH", eth(0.1), eth),
    budgetWindowMs: 24 * 60 * 60 * 1000,
    maxPerWindow: Number(process.env.RELAYER_MAX_PER_MINUTE ?? 5),
    rateWindowMs: 60_000,
  };
}

/**
 * The control that actually matters.
 *
 * @throws PolicyError when the target is not a deployment this relayer subsidises.
 */
export function assertContractAllowed(policy: RelayerPolicy, contract: Address): void {
  if (policy.allowedContracts.size === 0) {
    throw new PolicyError(
      "This relayer has no allowlisted contracts (set RELAYER_ALLOWED_CONTRACTS). " +
        "Refusing to pay gas for an arbitrary contract.",
      503,
    );
  }
  if (!policy.allowedContracts.has(contract.toLowerCase())) {
    throw new PolicyError(
      `This relayer does not subsidise ${contract}. A public relayer cannot pay gas ` +
        "for arbitrary contracts; ask its operator to allowlist this deployment.",
      403,
    );
  }
}

export function assertChainAllowed(policy: RelayerPolicy, chainId: number): void {
  if (chainId !== policy.chainId) {
    throw new PolicyError(
      `This relayer only submits to chain ${policy.chainId}, not ${chainId}.`,
      403,
    );
  }
}

/** Worst-case cost of a transaction, used for both the budget and the balance floor. */
export function worstCaseCostWei(gas: bigint, maxFeePerGas: bigint): bigint {
  return gas * maxFeePerGas;
}

export function assertAffordable(
  policy: RelayerPolicy,
  input: { gas: bigint; maxFeePerGas: bigint; balance: bigint; spentInWindow: bigint },
): void {
  if (input.gas > policy.maxGas) {
    throw new PolicyError(
      `Transaction needs ${input.gas} gas, above this relayer's ${policy.maxGas} ceiling.`,
      403,
    );
  }
  if (input.maxFeePerGas > policy.maxFeePerGasWei) {
    throw new PolicyError(
      "Network fees are above this relayer's ceiling right now. Try again later, or " +
        "submit the proof from your own wallet.",
      503,
    );
  }

  const cost = worstCaseCostWei(input.gas, input.maxFeePerGas);

  if (input.balance - cost < policy.minBalanceWei) {
    throw new PolicyError("This relayer is out of funds. Contact its operator.", 503);
  }
  if (input.spentInWindow + cost > policy.budgetWei) {
    throw new PolicyError(
      "This relayer has reached its spending budget for now. Try again later, or " +
        "submit the proof from your own wallet.",
      429,
    );
  }
}

/* ------------------------------------------------------------------------- *
 *                             REQUEST VALIDATION                             *
 * ------------------------------------------------------------------------- */

/**
 * Parse a request id.
 *
 * `BigInt("abc")` throws a raw SyntaxError that would reach the caller as an
 * opaque 400 — the same leaked-internal-error shape {@link parseEmailProof}
 * exists to prevent.
 */
export function parseRequestId(input: unknown): bigint {
  if (typeof input !== "string" && typeof input !== "number") {
    throw new PolicyError("requestId must be a string or number", 400);
  }
  let id: bigint;
  try {
    id = BigInt(input);
  } catch {
    throw new PolicyError(`requestId must be an integer, got ${JSON.stringify(input)}`, 400);
  }
  if (id <= 0n) throw new PolicyError("requestId must be positive; ids start at 1", 400);
  return id;
}

/** The proof struct, after crossing JSON and being checked field by field. */
export interface ParsedEmailProof {
  domainName: string;
  publicKeyHash: `0x${string}`;
  timestamp: bigint;
  maskedCommand: string;
  emailNullifier: `0x${string}`;
  accountSalt: `0x${string}`;
  isCodeExist: boolean;
  proof: `0x${string}`;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]*$/;

/**
 * Validate the proof struct before it reaches an ABI encoder.
 *
 * Without this, a malformed body gets as far as viem and surfaces as
 * `Cannot read properties of undefined (reading 'length')` — a 400 that tells the
 * caller nothing and leaks an internal stack shape. Everything here is
 * caller-supplied, so it is checked rather than trusted.
 *
 * @throws PolicyError(400) naming the offending field.
 */
export function parseEmailProof(input: unknown): ParsedEmailProof {
  if (typeof input !== "object" || input === null) {
    throw new PolicyError("proof must be an object", 400);
  }
  const p = input as Record<string, unknown>;

  const str = (field: string): string => {
    const v = p[field];
    if (typeof v !== "string" || v.length === 0) {
      throw new PolicyError(`proof.${field} must be a non-empty string`, 400);
    }
    return v;
  };
  const bytes32 = (field: string): `0x${string}` => {
    const v = p[field];
    if (typeof v !== "string" || !BYTES32.test(v)) {
      throw new PolicyError(`proof.${field} must be 32-byte hex`, 400);
    }
    return v as `0x${string}`;
  };

  // Checked in struct order, so the reported field is the first one a caller would
  // have written wrong rather than whichever happens to be validated first.
  const domainName = str("domainName");
  const publicKeyHash = bytes32("publicKeyHash");

  let timestamp: bigint;
  try {
    timestamp = BigInt((p["timestamp"] ?? 0) as string | number);
  } catch {
    throw new PolicyError("proof.timestamp must be an integer", 400);
  }
  if (timestamp < 0n) throw new PolicyError("proof.timestamp must not be negative", 400);

  const maskedCommand = str("maskedCommand");
  const emailNullifier = bytes32("emailNullifier");
  const accountSalt = bytes32("accountSalt");

  const rawProof = p["proof"];
  if (typeof rawProof !== "string" || !HEX.test(rawProof)) {
    throw new PolicyError("proof.proof must be a hex string", 400);
  }

  return {
    domainName,
    publicKeyHash,
    timestamp,
    maskedCommand,
    emailNullifier,
    accountSalt,
    // Anything other than a literal true is false: never pass a caller-supplied
    // truthy value straight into an ABI bool.
    isCodeExist: p["isCodeExist"] === true,
    proof: rawProof as `0x${string}`,
  };
}

/* ------------------------------------------------------------------------- *
 *                                  STORE                                     *
 * ------------------------------------------------------------------------- */

/**
 * Backing store for rate limits and the spend ledger.
 *
 * Deliberately an interface. The in-memory implementation below is correct for a
 * single instance and worthless across several: each replica would enforce the full
 * budget independently, so N replicas permit N times the spend. A multi-instance
 * deployment MUST supply a shared implementation (Redis, Upstash, Durable Object)
 * via {@link setRelayStore} before the budget means anything.
 */
export interface RelayStore {
  /** Returns true when the caller is over its limit. */
  hitRateLimit(key: string, limit: number, windowMs: number): Promise<boolean>;
  /** Total worst-case wei committed inside the window. */
  spentInWindow(windowMs: number): Promise<bigint>;
  /** Commit a worst-case cost against the budget. */
  recordSpend(wei: bigint): Promise<void>;
}

export class InMemoryRelayStore implements RelayStore {
  private readonly hits = new Map<string, number[]>();
  private spends: { at: number; wei: bigint }[] = [];

  async hitRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    return recent.length > limit;
  }

  async spentInWindow(windowMs: number): Promise<bigint> {
    const cutoff = Date.now() - windowMs;
    this.spends = this.spends.filter((s) => s.at >= cutoff);
    return this.spends.reduce((sum, s) => sum + s.wei, 0n);
  }

  async recordSpend(wei: bigint): Promise<void> {
    this.spends.push({ at: Date.now(), wei });
  }
}

let store: RelayStore = new InMemoryRelayStore();

export function setRelayStore(next: RelayStore): void {
  store = next;
}

export function relayStore(): RelayStore {
  return store;
}

/* ------------------------------------------------------------------------- *
 *                             NONCE SERIALISATION                            *
 * ------------------------------------------------------------------------- */

let tail: Promise<unknown> = Promise.resolve();

/**
 * Serialises submissions within this instance.
 *
 * Two concurrent requests would otherwise read the same nonce and one would be
 * dropped or replace the other. Single-instance only, for the same reason the
 * in-memory store is — a shared deployment needs nonce coordination alongside a
 * shared store.
 */
export function withNonceLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
