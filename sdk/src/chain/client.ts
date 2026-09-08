import {
  createPublicClient,
  http,
  type Address,
  type Hex,
  type HttpTransport,
  type PublicClient,
} from "viem";
import { base, baseSepolia, foundry } from "viem/chains";

import { DSRP_ABI } from "./abi.js";
import type { EncryptedPayload, RecoveryContext, RecoveryRequest } from "../types.js";

export type SupportedChain = typeof base | typeof baseSepolia | typeof foundry;

/**
 * Chipotle anchors its PKP permissions on Base, so that is the protocol's home.
 *
 * `foundry` (31337) is included for local development: the 48-hour timelock is
 * untestable end-to-end without `evm_increaseTime`, so anvil is the only place the
 * full lifecycle can actually be exercised.
 */
export function chainFor(chainId: number): SupportedChain {
  if (chainId === base.id) return base;
  if (chainId === baseSepolia.id) return baseSepolia;
  if (chainId === foundry.id) return foundry;
  throw new Error(
    `unsupported chainId ${chainId}; expected ${base.id}, ${baseSepolia.id} or ${foundry.id}`,
  );
}

/**
 * The concrete client type this SDK uses.
 *
 * Explicitly parameterized rather than inferred, for two reasons: viem's bare
 * `PublicClient` default is structurally incompatible with Base (an OP-stack chain
 * whose block and transaction types are wider), and the fully inferred type is too
 * large for TypeScript to serialize into a `.d.ts`.
 */
export type DsrpPublicClient = PublicClient<HttpTransport, SupportedChain>;

export function createReader(ctx: RecoveryContext, rpcUrl: string): DsrpPublicClient {
  return createPublicClient({ chain: chainFor(ctx.chainId), transport: http(rpcUrl) });
}

/** The inputs that decide whether a request can be executed right now. */
export interface ExecutabilityInputs {
  readonly pending: boolean;
  readonly mature: boolean;
  readonly proofCount: number;
  readonly threshold: number;
}

/**
 * Whether a request can execute right now.
 *
 * Pure and exported deliberately: this same predicate is needed by the reactive
 * React hooks (which read through wagmi, not through a viem client) and by
 * {@link readRecoveryStatus}. One definition, so an "Execute" button can never
 * disagree with the contract about what executable means.
 *
 * Mirrors `executeRecovery`'s guards, minus the terminal-state checks already
 * folded into `pending`.
 */
export function isExecutable(input: ExecutabilityInputs): boolean {
  return input.pending && input.mature && input.proofCount >= input.threshold;
}

/** Reads a recovery request as a plain object. */
export async function readRequest(
  client: DsrpPublicClient,
  contractAddress: Address,
  requestId: bigint,
): Promise<RecoveryRequest> {
  const raw = await client.readContract({
    address: contractAddress,
    abi: DSRP_ABI,
    functionName: "getRequest",
    args: [requestId],
  });
  return {
    newOwner: raw.newOwner,
    timestamp: BigInt(raw.timestamp),
    proofCount: Number(raw.proofCount),
    executed: raw.executed,
    cancelled: raw.cancelled,
  };
}

/** Everything the Lit gate checks, mirrored client-side for UI and pre-flight. */
export async function readRecoveryStatus(
  client: DsrpPublicClient,
  contractAddress: Address,
  requestId: bigint,
): Promise<{
  request: RecoveryRequest;
  threshold: number;
  eta: bigint;
  mature: boolean;
  pending: boolean;
  executable: boolean;
}> {
  const [request, threshold, eta, mature, pending] = await Promise.all([
    readRequest(client, contractAddress, requestId),
    client.readContract({ address: contractAddress, abi: DSRP_ABI, functionName: "threshold" }),
    client.readContract({
      address: contractAddress,
      abi: DSRP_ABI,
      functionName: "etaOf",
      args: [requestId],
    }),
    client.readContract({
      address: contractAddress,
      abi: DSRP_ABI,
      functionName: "isMature",
      args: [requestId],
    }),
    client.readContract({
      address: contractAddress,
      abi: DSRP_ABI,
      functionName: "isPending",
      args: [requestId],
    }),
  ]);

  return {
    request,
    threshold: Number(threshold),
    eta,
    mature,
    pending,
    executable: isExecutable({
      pending,
      mature,
      proofCount: request.proofCount,
      threshold: Number(threshold),
    }),
  };
}

/** Fetches the stored ciphertext, verifying it against the on-chain hash. */
export async function readGuardianPayload(
  client: DsrpPublicClient,
  contractAddress: Address,
  scheme: EncryptedPayload["scheme"],
): Promise<EncryptedPayload> {
  const [ciphertext, hash] = await Promise.all([
    client.readContract({
      address: contractAddress,
      abi: DSRP_ABI,
      functionName: "guardianPayload",
    }),
    client.readContract({
      address: contractAddress,
      abi: DSRP_ABI,
      functionName: "guardianPayloadHash",
    }),
  ]);
  return { ciphertext: ciphertext as Hex, hash: hash as Hex, scheme };
}
