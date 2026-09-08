import { NextResponse } from "next/server";

import { serverVault } from "@/lib/server/vault";

export const runtime = "nodejs";

/**
 * Encrypt a guardian set for on-chain storage.
 *
 * Server-side because the Chipotle API key cannot ship to a browser. It stores
 * nothing: the plaintext exists only for the duration of this request, and the
 * ciphertext goes straight back to the caller to be written on-chain by their own
 * wallet.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      contractAddress?: string;
      chainId?: number;
      set?: { threshold: number; guardians: { email: string; accountSalt: string }[] };
    };

    if (!body.contractAddress || !body.chainId || !body.set) {
      return NextResponse.json(
        { error: "contractAddress, chainId and set are required" },
        { status: 400 },
      );
    }

    const { vault, isMock } = serverVault();
    const payload = await vault.encrypt(body.set as never, {
      contractAddress: body.contractAddress as `0x${string}`,
      chainId: body.chainId,
    });

    return NextResponse.json({ ...payload, isMock });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "encryption failed" },
      { status: 500 },
    );
  }
}
