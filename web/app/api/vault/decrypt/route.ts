import { NextResponse } from "next/server";

import { serverVault } from "@/lib/server/vault";

export const runtime = "nodejs";

/**
 * Ask the Lit gate to release a guardian list.
 *
 * This succeeds only when the gate agrees the recovery genuinely qualifies —
 * matured, past threshold, neither cancelled nor executed. A refusal here is
 * usually correct behaviour rather than an error, so the denial reason is passed
 * through verbatim instead of being flattened into a 500.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      contractAddress?: string;
      chainId?: number;
      requestId?: string;
      payload?: { ciphertext: string; hash: string; scheme: string };
    };

    if (!body.contractAddress || !body.chainId || !body.payload || body.requestId === undefined) {
      return NextResponse.json(
        { error: "contractAddress, chainId, requestId and payload are required" },
        { status: 400 },
      );
    }

    const { vault } = serverVault();
    const set = await vault.decrypt(body.payload as never, {
      contractAddress: body.contractAddress as `0x${string}`,
      chainId: body.chainId,
      requestId: BigInt(body.requestId),
    });

    return NextResponse.json({ set });
  } catch (e) {
    const message = e instanceof Error ? e.message : "decryption failed";
    // The gate refusing is a policy outcome, not a server fault.
    const denied = /denied|does not qualify|gate/i.test(message);
    return NextResponse.json({ error: message, denied }, { status: denied ? 403 : 500 });
  }
}
