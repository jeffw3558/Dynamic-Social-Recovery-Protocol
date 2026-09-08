export {
  asBytes32,
  generateApprovalProof,
  loadBlueprint,
  readPublicKeyHash,
  toEmailProofStruct,
  type BlueprintConfig,
  type PublicOutputNames,
} from "./proof.js";
export {
  buildApprovalEmail,
  readDkimIdentity,
  validateApprovalEmail,
  type ApprovalEmailSpec,
} from "./headers.js";
