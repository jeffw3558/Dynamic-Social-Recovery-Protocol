"use client";

import { useEffect, useState } from "react";
import { useWaitForTransactionReceipt } from "wagmi";

import { txUrl } from "@/lib/dsrp";
import { readableError } from "@/lib/errors";

type Variant = "primary" | "danger" | "ghost";

/**
 * A write button that owns its own transaction lifecycle.
 *
 * Contract reverts arrive as long wrapped viem errors; the custom-error name is
 * pulled out and shown, because "AlreadyApproved" tells a guardian what actually
 * happened and a 40-line stack does not.
 */
export function TxButton({
  label,
  pendingLabel,
  onSend,
  disabled,
  variant = "primary",
  chainId,
  onConfirmed,
  hint,
}: {
  label: string;
  pendingLabel?: string;
  onSend: () => Promise<`0x${string}`>;
  disabled?: boolean;
  variant?: Variant;
  chainId: number;
  onConfirmed?: () => void;
  hint?: string;
}) {
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);

  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({ hash, chainId });

  useEffect(() => {
    if (isSuccess) onConfirmed?.();
  }, [isSuccess, onConfirmed]);

  const click = async () => {
    setError(undefined);
    setSending(true);
    try {
      setHash(await onSend());
    } catch (e) {
      setError(readableError(e));
    } finally {
      setSending(false);
    }
  };

  const busy = sending || mining;
  const url = hash ? txUrl(chainId, hash) : undefined;

  return (
    <div>
      <div className="row">
        <button className={variant} onClick={click} disabled={disabled || busy}>
          {busy ? (pendingLabel ?? "Working…") : label}
        </button>
        {hint && !busy && !error && (
          <span style={{ fontSize: 13, color: "var(--muted)" }}>{hint}</span>
        )}
        {mining && <span className="badge accent">Waiting for confirmation</span>}
        {isSuccess && <span className="badge ok">Confirmed</span>}
      </div>

      {hash && (
        <p className="mono" style={{ marginTop: 10, color: "var(--muted)" }}>
          {url ? <a href={url} target="_blank" rel="noreferrer">{hash}</a> : hash}
        </p>
      )}
      {error && (
        <p className="note danger" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
    </div>
  );
}
