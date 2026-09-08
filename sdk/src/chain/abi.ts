/**
 * Minimal ABI for {@link DynamicSocialRecovery}, hand-maintained rather than imported
 * from Foundry artifacts so the SDK builds without a prior `forge build`.
 *
 * `test_GateActionSelectorsAreStable` in the Foundry suite pins the four signatures
 * the Lit gate depends on; the rest are covered by the SDK's own typecheck against
 * viem's inference.
 */
export const DSRP_ABI = [
  {
    type: "function",
    name: "setGuardianPayload",
    stateMutability: "nonpayable",
    inputs: [
      { name: "payload", type: "bytes" },
      { name: "accountSalts", type: "bytes32[]" },
      { name: "newThreshold", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "initiateRecovery",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [{ name: "requestId", type: "uint256" }],
  },
  {
    type: "function",
    name: "submitEmailProof",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "uint256" },
      {
        name: "proof",
        type: "tuple",
        components: [
          { name: "domainName", type: "string" },
          { name: "publicKeyHash", type: "bytes32" },
          { name: "timestamp", type: "uint256" },
          { name: "maskedCommand", type: "string" },
          { name: "emailNullifier", type: "bytes32" },
          { name: "accountSalt", type: "bytes32" },
          { name: "isCodeExist", type: "bool" },
          { name: "proof", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeRecovery",
    stateMutability: "nonpayable",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelRecovery",
    stateMutability: "nonpayable",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getRequest",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "newOwner", type: "address" },
          { name: "timestamp", type: "uint64" },
          { name: "proofCount", type: "uint32" },
          { name: "executed", type: "bool" },
          { name: "cancelled", type: "bool" },
        ],
      },
    ],
  },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "threshold", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "guardianCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "guardianPayload", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes" }] },
  { type: "function", name: "guardianPayloadHash", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "activeRequestId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "DELAY", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "etaOf",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isMature",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isPending",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "canonicalCommand",
    stateMutability: "view",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "newOwner", type: "address" },
    ],
    outputs: [{ name: "", type: "string" }],
  },

  // --- Custom errors ---------------------------------------------------
  // Generated from contracts/out/DynamicSocialRecovery.sol/DynamicSocialRecovery.json.
  // Without these, viem cannot decode a revert and the UI shows a bare selector
  // like `0xa483dd04` instead of "this guardian already approved" — which defeats
  // the point of the contract having named errors at all.
  { type: "error", name: "AlreadyApproved", inputs: [{ name: "requestId", type: "uint256" }, { name: "accountSalt", type: "bytes32" }] },
  { type: "error", name: "CommandMismatch", inputs: [{ name: "expected", type: "string" }, { name: "actual", type: "string" }] },
  { type: "error", name: "DuplicateGuardian", inputs: [{ name: "accountSalt", type: "bytes32" }] },
  { type: "error", name: "EmptyPayload", inputs: [] },
  { type: "error", name: "GuardiansNotConfigured", inputs: [] },
  { type: "error", name: "InvalidProof", inputs: [] },
  { type: "error", name: "InvalidThreshold", inputs: [{ name: "given", type: "uint256" }, { name: "guardianCount", type: "uint256" }] },
  { type: "error", name: "NoSuchRequest", inputs: [{ name: "requestId", type: "uint256" }] },
  { type: "error", name: "NotAGuardian", inputs: [{ name: "accountSalt", type: "bytes32" }] },
  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "NullifierAlreadyUsed", inputs: [{ name: "emailNullifier", type: "bytes32" }] },
  { type: "error", name: "RecoveryInFlight", inputs: [{ name: "requestId", type: "uint256" }] },
  { type: "error", name: "RequestNotPending", inputs: [{ name: "requestId", type: "uint256" }] },
  { type: "error", name: "SameOwner", inputs: [] },
  { type: "error", name: "StaleEmail", inputs: [{ name: "emailTimestamp", type: "uint256" }, { name: "requestTimestamp", type: "uint64" }] },
  { type: "error", name: "StringsInsufficientHexLength", inputs: [{ name: "value", type: "uint256" }, { name: "length", type: "uint256" }] },
  { type: "error", name: "ThresholdNotMet", inputs: [{ name: "have", type: "uint32" }, { name: "want", type: "uint256" }] },
  { type: "error", name: "TimelockNotElapsed", inputs: [{ name: "nowTs", type: "uint256" }, { name: "eta", type: "uint256" }] },
  { type: "error", name: "TooManyGuardians", inputs: [{ name: "given", type: "uint256" }, { name: "max", type: "uint256" }] },
  { type: "error", name: "UntrustedDKIMKey", inputs: [{ name: "domainName", type: "string" }, { name: "publicKeyHash", type: "bytes32" }] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "ZeroSalt", inputs: [] },
] as const;
