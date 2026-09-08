"use client";

import { DSRP_ABI, isExecutable } from "@dsrp/sdk/chain";
import { useMemo } from "react";
import type { Address } from "viem";
import { useReadContracts } from "wagmi";

import { CHAIN_ID } from "@/lib/dsrp";

/**
 * How often on-chain recovery state is re-read.
 *
 * `refetchIntervalInBackground` is set on every read below, and it is not optional
 * here. TanStack Query pauses interval refetching while the document is hidden,
 * which is exactly wrong for this app: the entire point is watching a 48-hour
 * window, so the page will spend most of its life in a background tab. Without it,
 * an owner waiting to veto a hostile recovery sees frozen state, and an "Execute"
 * button stays disabled long after the timelock has actually expired.
 */
export const POLL_MS = 5_000;

export interface RecoveryRequestView {
  newOwner: Address;
  timestamp: bigint;
  proofCount: number;
  executed: boolean;
  cancelled: boolean;
}

export interface DsrpState {
  owner?: Address;
  threshold: number;
  guardianCount: number;
  activeRequestId: bigint;
  payloadHash?: `0x${string}`;
  delay: bigint;
  isLoading: boolean;
  error?: Error;
  refetch: () => void;
}

/** Wallet-level configuration: who owns it, how many guardians, what threshold. */
export function useDsrpState(contract?: Address): DsrpState {
  const enabled = Boolean(contract);
  const common = { address: contract as Address, abi: DSRP_ABI, chainId: CHAIN_ID } as const;

  const { data, isLoading, error, refetch } = useReadContracts({
    allowFailure: false,
    contracts: [
      { ...common, functionName: "owner" },
      { ...common, functionName: "threshold" },
      { ...common, functionName: "guardianCount" },
      { ...common, functionName: "activeRequestId" },
      { ...common, functionName: "guardianPayloadHash" },
      { ...common, functionName: "DELAY" },
    ],
    query: { enabled, refetchInterval: POLL_MS, refetchIntervalInBackground: true },
  });

  return useMemo(
    () => ({
      owner: data?.[0] as Address | undefined,
      threshold: data ? Number(data[1]) : 0,
      guardianCount: data ? Number(data[2]) : 0,
      activeRequestId: data ? (data[3] as bigint) : 0n,
      payloadHash: data?.[4] as `0x${string}` | undefined,
      delay: data ? (data[5] as bigint) : 172_800n,
      isLoading,
      error: error ?? undefined,
      refetch: () => void refetch(),
    }),
    [data, isLoading, error, refetch],
  );
}

export interface RecoveryStatus {
  request?: RecoveryRequestView;
  threshold: number;
  eta: bigint;
  mature: boolean;
  pending: boolean;
  /** True only when the contract would actually let `executeRecovery` through. */
  executable: boolean;
  exists: boolean;
  isLoading: boolean;
  refetch: () => void;
}

/**
 * Live status of one recovery request.
 *
 * Polls rather than caching hard: the approval count is being changed by other
 * people and the timelock is a moving target, so stale data here would show a
 * disabled Execute button on a request that is already executable — or worse, hide
 * a recovery the owner needs to veto.
 */
export function useRecoveryStatus(contract?: Address, requestId?: bigint): RecoveryStatus {
  const enabled = Boolean(contract) && requestId !== undefined && requestId > 0n;
  const common = { address: contract as Address, abi: DSRP_ABI, chainId: CHAIN_ID } as const;

  const { data, isLoading, refetch } = useReadContracts({
    allowFailure: true,
    contracts: [
      { ...common, functionName: "getRequest", args: [requestId ?? 0n] },
      { ...common, functionName: "threshold" },
      { ...common, functionName: "etaOf", args: [requestId ?? 0n] },
      { ...common, functionName: "isMature", args: [requestId ?? 0n] },
      { ...common, functionName: "isPending", args: [requestId ?? 0n] },
    ],
    query: { enabled, refetchInterval: POLL_MS, refetchIntervalInBackground: true },
  });

  return useMemo(() => {
    const raw = data?.[0];
    // `getRequest` reverts with NoSuchRequest for an unknown id; allowFailure turns
    // that into a failure entry rather than an exception, which is the signal that
    // the request simply does not exist yet.
    const exists = raw?.status === "success";
    const req = exists
      ? (raw.result as unknown as {
          newOwner: Address;
          timestamp: bigint;
          proofCount: number;
          executed: boolean;
          cancelled: boolean;
        })
      : undefined;

    const threshold = data?.[1]?.status === "success" ? Number(data[1].result) : 0;
    const eta = data?.[2]?.status === "success" ? (data[2].result as bigint) : 0n;
    const mature = data?.[3]?.status === "success" ? Boolean(data[3].result) : false;
    const pending = data?.[4]?.status === "success" ? Boolean(data[4].result) : false;

    const request: RecoveryRequestView | undefined = req
      ? {
          newOwner: req.newOwner,
          timestamp: BigInt(req.timestamp),
          proofCount: Number(req.proofCount),
          executed: req.executed,
          cancelled: req.cancelled,
        }
      : undefined;

    return {
      request,
      threshold,
      eta,
      mature,
      pending,
      // Shared with the SDK so the button and the chain cannot disagree.
      executable: isExecutable({
        pending,
        mature,
        proofCount: request?.proofCount ?? 0,
        threshold,
      }),
      exists,
      isLoading,
      refetch: () => void refetch(),
    };
  }, [data, isLoading, refetch]);
}
