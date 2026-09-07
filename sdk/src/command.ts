import type { Address } from "viem";
import type { RecoveryContext } from "./types.js";

/**
 * The exact string a guardian's email must contain to approve a recovery.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS IS A MIRROR OF `DynamicSocialRecovery.canonicalCommand`.
 *  The two definitions must stay byte-identical. If you change one, change both,
 *  and `test_CanonicalCommand_MatchesIndependentlyBuiltString` plus
 *  `command.test.ts` should both be updated deliberately, never "fixed" to agree.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Drift fails closed: a mismatch makes the contract reject every proof, rather
 * than accepting a wrong one. That is the safe direction, but it is still an
 * outage, so the mirror is isolated in this one file to keep it reviewable.
 *
 * Solidity renders addresses via OpenZeppelin `Strings.toHexString(address)`,
 * which is lowercase and zero-padded to 20 bytes — hence `toLowerCase()` here
 * rather than viem's checksummed `getAddress`.
 */
export function canonicalCommand(
  ctx: Pick<RecoveryContext, "contractAddress" | "chainId">,
  requestId: bigint,
  newOwner: Address,
): string {
  return [
    "Approve recovery of wallet ",
    normalizeAddress(ctx.contractAddress),
    " on chain ",
    ctx.chainId.toString(10),
    " request ",
    requestId.toString(10),
    " to new owner ",
    normalizeAddress(newOwner),
  ].join("");
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Lowercase 0x-prefixed 20-byte hex, matching Solidity's rendering exactly. */
function normalizeAddress(value: string): string {
  if (!ADDRESS_RE.test(value)) {
    throw new Error(`canonicalCommand: not a 20-byte hex address: ${value}`);
  }
  return value.toLowerCase();
}
