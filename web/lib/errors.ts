/**
 * Turn a contract revert into something a person can act on.
 *
 * The contract's custom errors are listed in `DSRP_ABI`, so viem decodes a revert
 * into e.g. `Error: NullifierAlreadyUsed(bytes32 emailNullifier)` inside a long
 * multi-line dump that also contains the full calldata. This pulls the name out and
 * says what it means — the difference between a guardian learning "you already
 * approved this" and being shown 40 lines of ABI.
 */
const EXPLAIN: Record<string, string> = {
  // Ordered so more specific names are matched before any that are substrings.
  NullifierAlreadyUsed: "That email has already been used for an approval. Send a new one.",
  AlreadyApproved: "This guardian has already approved this request.",
  NotAGuardian: "That email address is not a guardian on this wallet.",
  CommandMismatch: "The email's subject does not match this request.",
  UntrustedDKIMKey: "The email's DKIM key is not trusted by the registry.",
  InvalidProof: "The zero-knowledge proof did not verify.",
  StaleEmail: "The email was sent before the recovery request existed.",
  TimelockNotElapsed: "The 48-hour timelock has not finished yet.",
  ThresholdNotMet: "Not enough guardians have approved yet.",
  RequestNotPending: "This request was already executed or cancelled.",
  NoSuchRequest: "No recovery request exists with that id.",
  RecoveryInFlight: "A recovery is already in flight. Cancel it first.",
  GuardiansNotConfigured: "No guardian set has been published for this wallet yet.",
  InvalidThreshold: "The threshold must be between 1 and the number of guardians.",
  DuplicateGuardian: "That guardian appears twice in the list.",
  TooManyGuardians: "At most 64 guardians are allowed.",
  NotOwner: "Only the wallet owner can do this.",
  SameOwner: "The proposed owner is already the owner.",
  EmptyPayload: "The encrypted guardian payload is empty.",
  ZeroSalt: "A guardian commitment cannot be zero.",
  ZeroAddress: "That address cannot be zero.",
};

export function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);

  for (const [name, explanation] of Object.entries(EXPLAIN)) {
    if (raw.includes(name)) return `${explanation} (${name})`;
  }
  if (/User rejected|denied transaction/i.test(raw)) return "You rejected the transaction.";
  if (/rate limit|Too many/i.test(raw)) return raw;

  return raw.split("\n")[0] ?? raw;
}
