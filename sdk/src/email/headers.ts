import { extractEMLDetails, getDKIMSelector, parseEmail } from "@zk-email/sdk";
import type { Address } from "viem";

import { canonicalCommand } from "../command.js";
import type { RecoveryContext } from "../types.js";

/** What a guardian needs to send, and what the relayer needs to check. */
export interface ApprovalEmailSpec {
  readonly subject: string;
  readonly command: string;
}

/**
 * Build the email a guardian must send to approve a recovery.
 *
 * The subject *is* the command: putting it anywhere the blueprint does not read
 * produces a proof whose `maskedCommand` will not match, and the contract rejects it.
 */
export function buildApprovalEmail(
  ctx: Pick<RecoveryContext, "contractAddress" | "chainId">,
  requestId: bigint,
  newOwner: Address,
): ApprovalEmailSpec {
  const command = canonicalCommand(ctx, requestId, newOwner);
  return { subject: command, command };
}

/**
 * Check a raw `.eml` carries the exact expected command before spending proving time.
 *
 * Proving is slow and, on the hosted prover, metered — a mismatch caught here costs
 * nothing, while the same mismatch caught on-chain costs a reverted transaction.
 */
export async function validateApprovalEmail(
  eml: string,
  expectedCommand: string,
): Promise<{ ok: boolean; reason?: string; subject?: string }> {
  const parsed = await parseEmail(eml);
  const subject = readSubject(parsed);

  if (subject === undefined) return { ok: false, reason: "email has no Subject header" };
  if (!subject.includes(expectedCommand)) {
    return { ok: false, reason: "subject does not contain the canonical command", subject };
  }
  return { ok: true, subject };
}

/** Domain and DKIM selector, for checking the key against the on-chain registry. */
export async function readDkimIdentity(
  eml: string,
): Promise<{ domain: string; selector: string }> {
  const details = (await extractEMLDetails(eml)) as Record<string, unknown>;
  const selector = await getDKIMSelector(eml);
  return {
    domain: String(details["senderDomain"] ?? ""),
    selector: String(selector ?? ""),
  };
}

function readSubject(parsed: unknown): string | undefined {
  const headers = (parsed as { headers?: unknown })?.headers;
  if (headers instanceof Map) return headers.get("subject") as string | undefined;
  if (headers && typeof headers === "object") {
    const value = (headers as Record<string, unknown>)["subject"];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}
