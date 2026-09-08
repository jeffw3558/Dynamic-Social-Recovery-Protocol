import { DSRP_ABI, createReader, readRequest, RecoveryRelay } from "@dsrp/sdk/chain";
import { NextResponse } from "next/server";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  assertAffordable,
  assertChainAllowed,
  assertContractAllowed,
  loadPolicy,
  parseEmailProof,
  PolicyError,
  relayStore,
  withNonceLock,
  worstCaseCostWei,
} from "@/lib/server/relayer-policy";

export const runtime = "nodejs";

/**
 * Submit a guardian's approval on their behalf.
 *
 * This is what makes the protocol's central claim true in practice: a guardian
 * needs no wallet, no gas and no seed phrase. It is safe to expose because the
 * contract's seven checks make every proof self-authenticating and single-use — a
 * relayer can withhold or delay a proof, but cannot forge, alter, redirect or
 * replay one. It stores nothing, and its key carries no protocol authority.
 *
 * What it *can* lose is money, so the whole of `relayer-policy.ts` exists to bound
 * that. Note especially that `contractAddress` arrives in the request body and
 * becomes the call target: without the allowlist check below, an attacker points
 * this at a contract of their own that burns the block gas limit and drains the key.
 */
export async function POST(request: Request) {
  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "Relayer is not configured (RELAYER_PRIVATE_KEY)." },
      { status: 503 },
    );
  }

  try {
    const policy = loadPolicy();
    const store = relayStore();

    const caller = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    if (await store.hitRateLimit(caller, policy.maxPerWindow, policy.rateWindowMs)) {
      throw new PolicyError("Too many submissions. Wait a minute and try again.", 429);
    }

    const body = (await request.json()) as {
      contractAddress?: Address;
      chainId?: number;
      requestId?: string;
      proof?: Record<string, unknown>;
    };

    if (!body.contractAddress || !body.chainId || body.requestId === undefined || !body.proof) {
      return NextResponse.json(
        { error: "contractAddress, chainId, requestId and proof are required" },
        { status: 400 },
      );
    }

    // Refuse before touching the network. This is the control that stops the
    // relayer being pointed at an attacker's gas-burning contract.
    assertContractAllowed(policy, body.contractAddress);
    assertChainAllowed(policy, body.chainId);

    const ctx = { contractAddress: body.contractAddress, chainId: body.chainId };
    const requestId = BigInt(body.requestId);
    const rpcUrl = process.env.RELAYER_RPC_URL ?? "http://127.0.0.1:8545";

    const client = createReader(ctx, rpcUrl);
    const account = privateKeyToAccount(key as `0x${string}`);

    // Read the proposed owner from chain rather than trusting the caller: the
    // command binding must be checked against what the request actually says.
    const onChain = await readRequest(client, body.contractAddress, requestId);

    // Checked field by field before it can reach an ABI encoder. `timestamp` also
    // crossed the wire as a string, because JSON has no bigint.
    const proof = parseEmailProof(body.proof);

    return await withNonceLock(async () => {
      const relay = RecoveryRelay.fromAccount(ctx, rpcUrl, account);

      // Simulate before spending anything. A guardian whose proof would be rejected
      // gets the contract's own reason back instead of a burnt transaction — which
      // also means invalid spam costs the relayer no gas at all, only an RPC call.
      await relay.simulateSubmitEmailProof(client, requestId, proof as never);

      const [gas, fees, balance, spent] = await Promise.all([
        client.estimateContractGas({
          address: body.contractAddress as Address,
          abi: DSRP_ABI,
          functionName: "submitEmailProof",
          args: [requestId, proof as never],
          account,
        }),
        client.estimateFeesPerGas(),
        client.getBalance({ address: account.address }),
        store.spentInWindow(policy.budgetWindowMs),
      ]);

      const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
      assertAffordable(policy, { gas, maxFeePerGas, balance, spentInWindow: spent });

      // Committed before sending, not after: a crash between send and record must
      // never leave spend uncounted, and over-counting only costs availability.
      await store.recordSpend(worstCaseCostWei(gas, maxFeePerGas));

      const hash = await relay.submitEmailProof(requestId, onChain.newOwner, proof as never);
      return NextResponse.json({ hash, relayer: relay.sender });
    });
  } catch (e) {
    if (e instanceof PolicyError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "submission failed" },
      { status: 400 },
    );
  }
}
