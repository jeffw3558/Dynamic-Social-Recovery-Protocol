import {
  createPublicClient,
  http,
  type Address,
  type Hex,
  type HttpTransport,
  type PublicClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";

import { DSRP_ABI } from "./abi.js";
import type { EncryptedPayload, RecoveryContext, RecoveryRequest } from "../types.js";

export type SupportedChain = typeof base | typeof baseSepolia;

/** Chipotle anchors its PKP permissions on Base, so that is the default home. */
export function chainFor(chainId: number): SupportedChain {
  if (chainId === base.id) return base;
  if (chainId === baseSepolia.id) return baseSepolia;
  throw new Error(`unsupported chainId ${chainId}; expected ${base.id} or ${baseSepolia.id}`);
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
    executable: pending && mature && request.proofCount >= Number(threshold),
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
