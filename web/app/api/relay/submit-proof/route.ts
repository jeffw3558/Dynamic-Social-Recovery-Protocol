import { RecoveryRelay, createReader, readRequest } from "@dsrp/sdk/chain";
import { NextResponse } from "next/server";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const runtime = "nodejs";

/**
 * Submit a guardian's approval on their behalf.
 *
 * This is what makes the protocol's central claim true in practice: a guardian
 * needs no wallet, no gas and no seed phrase. It is safe to run openly because the
 * contract's seven checks make every proof self-authenticating and single-use — a
 * relayer can withhold or delay a proof, but cannot forge, alter, redirect or
 * replay one.
 *
 * It stores nothing. The key it holds pays gas and carries no protocol authority,
 * so its compromise costs money, never control of a wallet.
 */

/**
 * Per-instance rate limit.
 *
 * Deliberately modest and deliberately called out: this is in-memory, so it resets
 * on redeploy and does not span instances. It blunts casual abuse of a funded key;
 * it is NOT sufficient for a public deployment, which wants a shared store and a
 * hard spend cap on the relayer account.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > MAX_PER_WINDOW;
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many submissions. Wait a minute and try again." },
      { status: 429 },
    );
  }

  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "Relayer is not configured (RELAYER_PRIVATE_KEY)." },
      { status: 503 },
    );
  }

  try {
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

    const ctx = { contractAddress: body.contractAddress, chainId: body.chainId };
    const requestId = BigInt(body.requestId);
    const rpcUrl = process.env.RELAYER_RPC_URL ?? "http://127.0.0.1:8545";

    // Read the proposed owner from chain rather than trusting the caller: the
    // command binding must be checked against what the request actually says.
    const client = createReader(ctx, rpcUrl);
    const onChain = await readRequest(client, body.contractAddress, requestId);

    const relay = RecoveryRelay.fromAccount(ctx, rpcUrl, privateKeyToAccount(key as `0x${string}`));

    // `timestamp` crossed the wire as a string, because JSON has no bigint. Rebuild
    // it before encoding, or viem will reject the uint256 argument.
    const proof = { ...body.proof, timestamp: BigInt((body.proof.timestamp as string) ?? 0) };

    // Simulate before spending gas. A guardian whose proof is going to be rejected
    // gets the contract's own reason back instead of a burnt transaction.
    await relay.simulateSubmitEmailProof(client, requestId, proof as never);

    const hash = await relay.submitEmailProof(requestId, onChain.newOwner, proof as never);
    return NextResponse.json({ hash, relayer: relay.sender });
  } catch (e) {
    const message = e instanceof Error ? e.message : "submission failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
