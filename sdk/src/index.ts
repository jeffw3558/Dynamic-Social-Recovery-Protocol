/**
 * Dynamic Social Recovery Protocol — off-chain SDK.
 *
 * Three concerns, deliberately separable:
 *   - `vault/`  threshold encryption of the guardian set (Lit Chipotle, or a mock)
 *   - `email/`  ZK Email proof generation from a guardian's reply
 *   - `chain/`  reads and relayed writes against the recovery contract
 *
 * `command.ts` is the one piece that must stay in lockstep with Solidity.
 */

export * from "./types.js";
export { canonicalCommand } from "./command.js";

export {
  assertValidGuardianSet,
  VaultAccessDeniedError,
  type GuardianVault,
} from "./vault/GuardianVault.js";
export { MockVault, mockAccountSalt } from "./vault/MockVault.js";
export { ChipotleVault, type ChipotleConfig } from "./vault/ChipotleVault.js";

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
  readGuardianPayload,
  readRecoveryStatus,
  readRequest,
  type DsrpPublicClient,
  type SupportedChain,
} from "./chain/client.js";
export { RecoveryRelay } from "./chain/relay.js";
