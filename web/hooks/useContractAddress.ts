"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import { DEFAULT_CONTRACT, isAddress } from "@/lib/dsrp";

const KEY = "dsrp:contract";

/**
 * Which DynamicSocialRecovery deployment this session is pointed at.
 *
 * Held in localStorage, not on a server. There is no registry mapping users to
 * wallets anywhere in this app — that would be precisely the database the protocol
 * is built to avoid.
 */
export function useContractAddress(): {
  contract?: Address;
  setContract: (value: string) => void;
  clear: () => void;
  ready: boolean;
} {
  const [contract, setValue] = useState<Address | undefined>(undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(KEY);
    } catch {
      // Private browsing or blocked storage; fall back to the env default.
    }
    const initial = stored ?? DEFAULT_CONTRACT;
    if (isAddress(initial)) setValue(initial);
    setReady(true);
  }, []);

  const setContract = useCallback((value: string) => {
    // Positive narrowing: `isAddress` is a type predicate, and negating it cannot
    // narrow `string` to `0x${string}` because Address is a subtype of string.
    if (isAddress(value)) {
      setValue(value);
      try {
        window.localStorage.setItem(KEY, value);
      } catch {
        /* non-fatal */
      }
    }
  }, []);

  const clear = useCallback(() => {
    setValue(undefined);
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* non-fatal */
    }
  }, []);

  return { contract, setContract, clear, ready };
}
