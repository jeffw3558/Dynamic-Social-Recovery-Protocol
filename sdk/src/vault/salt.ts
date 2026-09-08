import { keccak256, toHex, type Hex } from "viem";

/**
 * Development-only guardian commitment.
 *
 * ⚠️  NOT PRODUCTION-CORRECT. A real `accountSalt` is what the blueprint's circuit
 * derives — Poseidon over the guardian's email address and their account code — and
 * only that value will ever match a genuine proof. A commitment derived here will
 * be rejected on-chain by check 5 (`NotAGuardian`) for every real approval.
 *
 * It exists so the whole enrollment → approval → execute lifecycle can be exercised
 * locally against `MockZKEmailVerifier`, which accepts any proof. Anything reaching
 * a real network must take its salts from the blueprint tooling instead.
 *
 * Kept in its own module, free of `node:crypto`, so the browser can import it
 * without dragging in {@link MockVault}.
 */
export function devAccountSalt(email: string): Hex {
  return keccak256(toHex(`mock-account-salt:${email.trim().toLowerCase()}`));
}
