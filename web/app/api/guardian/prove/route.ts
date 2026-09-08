import { generateApprovalProof, loadBlueprint, readPublicKeyHash, toEmailProofStruct, validateApprovalEmail } from "@dsrp/sdk/email";
import { devAccountSalt } from "@dsrp/sdk/vault";
import { NextResponse } from "next/server";
import { keccak256, toHex } from "viem";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Turn a guardian's raw email into an on-chain-ready proof.
 *
 * Runs server-side because proving is heavy and, on the hosted prover, keyed. The
 * email is held only for the life of this request and never written anywhere.
 *
 * When no blueprint is configured this falls back to a *development* proof shaped
 * for MockZKEmailVerifier, which accepts anything. That is what makes the whole
 * lifecycle exercisable locally; it is refused in production, because a fake proof
 * against a real verifier is worthless and a fake proof against a mock verifier
 * deployed to a real network would be catastrophic.
 */
export async function POST(request: Request) {
  try {
    const { eml, command } = (await request.json()) as { eml?: string; command?: string };
    if (!eml || !command) {
      return NextResponse.json({ error: "eml and command are required" }, { status: 400 });
    }

    // Cheap local check first: proving is slow and metered, and a subject mismatch
    // would be rejected on-chain anyway.
    if (!eml.includes(command)) {
      return NextResponse.json(
        { error: "The email's subject does not contain this request's command." },
        { status: 400 },
      );
    }

    const slug = process.env.ZKEMAIL_BLUEPRINT_SLUG;

    if (!slug) {
      if (process.env.NODE_ENV === "production") {
        return NextResponse.json(
          { error: "ZKEMAIL_BLUEPRINT_SLUG is not configured; refusing to emit a development proof." },
          { status: 503 },
        );
      }
      return NextResponse.json({ proof: developmentProof(eml, command) });
    }

    const validation = await validateApprovalEmail(eml, command);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.reason }, { status: 400 });
    }

    const blueprint = await loadBlueprint({ slug });
    const proof = await generateApprovalProof(blueprint, eml);
    const publicKeyHash = await readPublicKeyHash(proof);

    return NextResponse.json({ proof: serialize(toEmailProofStruct(proof, publicKeyHash)) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "proof generation failed" },
      { status: 500 },
    );
  }
}

/** Shaped for MockZKEmailVerifier so local end-to-end runs need no real circuit. */
function developmentProof(eml: string, command: string) {
  const from = /^from:\s*(.+)$/im.exec(eml)?.[1] ?? "guardian@example.com";
  const email = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  const domain = email.split("@")[1] ?? "example.com";

  return {
    domainName: domain,
    publicKeyHash: keccak256(toHex(`dev-dkim-key:${domain}`)),
    timestamp: "0",
    maskedCommand: command,
    // Nullifier must be unique per email, or the contract rejects the replay.
    emailNullifier: keccak256(toHex(`dev-nullifier:${email}:${command}`)),
    accountSalt: devAccountSalt(email),
    isCodeExist: true,
    proof: "0x01",
  };
}

/** bigint does not survive JSON; the relay route rehydrates it. */
function serialize<T extends object>(struct: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(struct).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
  );
}
