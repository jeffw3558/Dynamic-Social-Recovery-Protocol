import "server-only";

import { ChipotleVault, type GuardianVault } from "@dsrp/sdk/vault";
import { MockVault } from "@dsrp/sdk/vault/mock";

/**
 * The vault runs server-side only, because {@link ChipotleVault} holds an API key.
 * The `server-only` import above turns any accidental client import into a build
 * error rather than a leaked key.
 *
 * Falls back to {@link MockVault} when Lit is unconfigured so the full local loop —
 * enroll, approve, wait, execute — works with no Chipotle account. The fallback is
 * refused in production rather than silently accepted: shipping it would put the
 * guardian list behind a key derivable from this source.
 */
export function serverVault(): { vault: GuardianVault; isMock: boolean } {
  const apiKey = process.env.LIT_API_KEY;
  const pkpId = process.env.LIT_PKP_ID;
  const gateActionCid = process.env.LIT_GATE_ACTION_CID;

  if (apiKey && pkpId && gateActionCid) {
    return {
      vault: new ChipotleVault({
        apiKey,
        pkpId,
        gateActionCid,
        rpcUrl: process.env.RELAYER_RPC_URL ?? "http://127.0.0.1:8545",
        ...(process.env.LIT_API_BASE_URL ? { baseUrl: process.env.LIT_API_BASE_URL } : {}),
      }),
      isMock: false,
    };
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Lit Chipotle is not configured (LIT_API_KEY / LIT_PKP_ID / LIT_GATE_ACTION_CID). " +
        "Refusing to fall back to MockVault in production — its key is derivable from source.",
    );
  }

  return { vault: new MockVault(process.env.MOCK_VAULT_SECRET), isMock: true };
}
