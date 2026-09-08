/**
 * Dynamic Social Recovery Protocol — off-chain SDK.
 *
 * Three concerns, deliberately separable:
 *   - `vault/`  threshold encryption of the guardian set (Lit Chipotle, or a mock)
 *   - `email/`  ZK Email proof generation from a guardian's reply
 *   - `chain/`  reads and relayed writes against the recovery contract
 *
 * `command.ts` is the one piece that must stay in lockstep with Solidity.
 *
 * This barrel is browser-safe. `MockVault` is deliberately absent: it imports
 * `node:crypto` and would break any browser bundle that reached it, so the offline
 * dev vault must be imported explicitly from `@dsrp/sdk/vault/mock`. The dangerous
 * dependency should require asking for it by name, not arrive by default.
 */

export * from "./types.js";
export { canonicalCommand } from "./command.js";

export {
  assertValidGuardianSet,
  VaultAccessDeniedError,
  type GuardianVault,
} from "./vault/GuardianVault.js";
export { ChipotleVault, type ChipotleConfig } from "./vault/ChipotleVault.js";
export { devAccountSalt } from "./vault/salt.js";

export {
  asBytes32,
  generateApprovalProof,
  loadBlueprint,
  readPublicKeyHash,
  toEmailProofStruct,
  type BlueprintConfig,
  type PublicOutputNames,
} from "./email/proof.js";
export {
  buildApprovalEmail,
  readDkimIdentity,
  validateApprovalEmail,
  type ApprovalEmailSpec,
} from "./email/headers.js";

export { DSRP_ABI } from "./chain/abi.js";
export {
  chainFor,
  createReader,
  isExecutable,
  readGuardianPayload,
  readRecoveryStatus,
  readRequest,
  type DsrpPublicClient,
  type SupportedChain,
} from "./chain/client.js";
export { RecoveryRelay } from "./chain/relay.js";
