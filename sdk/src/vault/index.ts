/**
 * Browser- and server-safe vault surface.
 *
 * Deliberately excludes {@link MockVault}, which imports `node:crypto` and would
 * break any browser bundle that reached it. Import that explicitly from
 * `@dsrp/sdk/vault/mock` when you actually want the offline dev vault.
 */
export {
  assertValidGuardianSet,
  VaultAccessDeniedError,
  type GuardianVault,
} from "./GuardianVault.js";
export { ChipotleVault, type ChipotleConfig } from "./ChipotleVault.js";
export { devAccountSalt } from "./salt.js";
