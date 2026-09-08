"use client";

import { useEffect, useRef, useState } from "react";
import { useBlock } from "wagmi";

import { CHAIN_ID } from "@/lib/dsrp";

function format(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/**
 * Time remaining on the 48-hour timelock.
 *
 * Counts down from **chain time**, not the browser clock. The contract compares the
 * ETA against `block.timestamp`, so anything derived from `Date.now()` is wrong by
 * however far the two have drifted — which on a test chain that has been warped
 * forward is days, not seconds. The latest block's timestamp is the baseline, and
 * the local clock only interpolates between polls so the digits keep moving.
 *
 * Maturity itself always comes from the chain's own `isMature`. A fast local clock
 * must never render a request as executable before the contract agrees.
 */
export function CountdownToEta({ eta, mature }: { eta: bigint; mature: boolean }) {
  const { data: block } = useBlock({ chainId: CHAIN_ID, watch: true });

  const baseline = useRef<{ chain: number; local: number } | undefined>(undefined);
  const [, tick] = useState(0);

  if (block?.timestamp !== undefined) {
    const chain = Number(block.timestamp);
    if (baseline.current?.chain !== chain) {
      baseline.current = { chain, local: Date.now() };
    }
  }

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (mature) {
    return (
      <div>
        <div className="countdown" style={{ color: "var(--ok)" }}>
          00:00:00
        </div>
        <span className="badge ok">Timelock elapsed</span>
      </div>
    );
  }

  if (!baseline.current) {
    return (
      <div>
        <div className="countdown" style={{ color: "var(--muted)" }}>
          --:--:--
        </div>
        <span className="badge">Reading chain time…</span>
      </div>
    );
  }

  const chainNow = baseline.current.chain + (Date.now() - baseline.current.local) / 1000;

  return (
    <div>
      <div className="countdown">{format(Number(eta) - chainNow)}</div>
      <span className="badge warn">Timelock running</span>
    </div>
  );
}
