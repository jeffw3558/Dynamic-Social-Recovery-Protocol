"use client";

import { canonicalCommand } from "@dsrp/sdk/command";
import { Suspense, useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";

import { useRecoveryStatus } from "@/hooks/useDsrp";
import { CHAIN_ID, isAddress, shorten } from "@/lib/dsrp";
import { readableError } from "@/lib/errors";

type Stage = "locate" | "compose" | "prove" | "done";

function GuardianFlow() {
  const [contract, setContract] = useState<`0x${string}` | undefined>();
  const [requestId, setRequestId] = useState<bigint | undefined>();
  const [eml, setEml] = useState("");
  const [status_, setStatus] = useState<Stage>("locate");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [txHash, setTxHash] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  // Prefilled from the link the person recovering sends.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const c = params.get("contract");
    const r = params.get("request");
    if (c && isAddress(c)) setContract(c);
    if (r && /^\d+$/.test(r)) setRequestId(BigInt(r));
    if (c && isAddress(c) && r) setStatus("compose");
  }, []);

  const status = useRecoveryStatus(contract, requestId);

  const command = useMemo(() => {
    if (!contract || requestId === undefined || !status.request) return undefined;
    return canonicalCommand(
      { contractAddress: contract, chainId: CHAIN_ID },
      requestId,
      status.request.newOwner,
    );
  }, [contract, requestId, status.request]);

  const submit = async () => {
    if (!contract || requestId === undefined || !command) return;
    setBusy(true);
    setError(undefined);
    try {
      // Proof generation happens here; the relayer only ever sees a finished proof.
      const proofRes = await fetch("/api/guardian/prove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eml, command }),
      });
      if (!proofRes.ok) throw new Error((await proofRes.json()).error ?? "Proof generation failed");
      const { proof } = (await proofRes.json()) as { proof: Record<string, unknown> };

      const relayRes = await fetch("/api/relay/submit-proof", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractAddress: contract,
          chainId: CHAIN_ID,
          requestId: requestId.toString(),
          proof,
        }),
      });
      const relayBody = await relayRes.json();
      if (!relayRes.ok) throw new Error(relayBody.error ?? "Submission failed");

      setTxHash(relayBody.hash as string);
      setStatus("done");
      status.refetch();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="page-title">Approve a recovery</h1>
      <p className="page-lede">
        Someone you agreed to vouch for has lost access to their wallet. You approve by sending one
        email and pasting it back here. You need no wallet, no gas and nothing installed.
      </p>

      <div className="steps">
        <span className={`step ${status_ === "locate" ? "active" : "done"}`}>1 · Find request</span>
        <span
          className={`step ${status_ === "compose" ? "active" : status_ === "locate" ? "" : "done"}`}
        >
          2 · Send email
        </span>
        <span className={`step ${status_ === "prove" ? "active" : status_ === "done" ? "done" : ""}`}>
          3 · Prove &amp; submit
        </span>
      </div>

      <div className="card">
        <h2>Which recovery?</h2>
        <p className="sub">
          Normally you arrive here from a link. If not, paste the wallet contract and request id.
        </p>
        <div className="grid two">
          <div>
            <label htmlFor="c">Wallet contract</label>
            <input
              id="c"
              type="text"
              placeholder="0x…"
              value={contract ?? ""}
              spellCheck={false}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (isAddress(v)) setContract(v);
              }}
            />
          </div>
          <div>
            <label htmlFor="r">Request id</label>
            <input
              id="r"
              type="number"
              value={requestId?.toString() ?? ""}
              onChange={(e) => setRequestId(e.target.value ? BigInt(e.target.value) : undefined)}
            />
          </div>
        </div>
      </div>

      {status.request && !status.pending && (
        <div className="card">
          <p className="note warn" style={{ margin: 0 }}>
            This request is no longer open &mdash;{" "}
            {status.request.executed ? "it already executed." : "the owner cancelled it."} There is
            nothing to approve.
          </p>
        </div>
      )}

      {command && status.pending && (
        <>
          <div className="card">
            <h2>Send this email</h2>
            <p className="sub">
              From the address you were enrolled with, send an email whose <strong>subject is
              exactly</strong> the line below. You can send it to anyone &mdash; only the DKIM
              signature your provider adds matters, and it is proven without revealing your address
              on-chain.
            </p>

            <p className="mono note">{command}</p>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(command);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
              >
                {copied ? "Copied" : "Copy subject"}
              </button>
              <a
                className="badge accent"
                href={`mailto:?subject=${encodeURIComponent(command)}`}
                style={{ textDecoration: "none" }}
              >
                Open in mail app
              </a>
            </div>

            <p className="note" style={{ marginTop: 16 }}>
              Approving transfers this wallet to{" "}
              <span className="mono">{shorten(status.request!.newOwner, 6)}</span> once{" "}
              {status.threshold} guardian(s) agree and 48 hours pass. Only approve if you are
              confident the request is genuine &mdash; ideally after confirming by a channel other
              than email.
            </p>
          </div>

          <div className="card">
            <h2>Paste the sent email back</h2>
            <p className="sub">
              Export the message you just sent as <span className="mono">.eml</span> (in most mail
              clients: Show Original, or drag the message to your desktop) and paste its full
              contents. It is used to build a zero-knowledge proof and is never stored.
            </p>

            <textarea
              value={eml}
              spellCheck={false}
              placeholder="Delivered-To: …&#10;DKIM-Signature: v=1; a=rsa-sha256; …"
              onChange={(e) => {
                setEml(e.target.value);
                if (e.target.value.length > 0) setStatus("prove");
              }}
            />

            <ul className="checklist" style={{ marginTop: 14 }}>
              <Check ok={eml.length > 0} label="Email pasted" />
              <Check ok={/dkim-signature/i.test(eml)} label="Has a DKIM signature" />
              <Check ok={eml.includes(command)} label="Subject matches this request exactly" />
            </ul>

            <div style={{ marginTop: 18 }}>
              <button
                className="primary"
                disabled={busy || !eml.includes(command) || !/dkim-signature/i.test(eml)}
                onClick={submit}
              >
                {busy ? "Proving and submitting…" : "Approve recovery"}
              </button>
              <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
                A relayer pays the gas for you. It cannot alter, redirect or reuse your approval
                &mdash; the contract binds it to this one request.
              </p>
            </div>

            {error && (
              <p className="note danger" style={{ marginTop: 14 }}>
                {error}
              </p>
            )}
          </div>
        </>
      )}

      {status_ === "done" && (
        <div className="card">
          <h2>Approval recorded</h2>
          <p className="note ok">
            Your approval is on-chain. {status.request?.proofCount ?? 0} of {status.threshold}{" "}
            guardians have now approved.
          </p>
          {txHash && <p className="mono" style={{ color: "var(--muted)" }}>{txHash}</p>}
        </div>
      )}
    </>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li>
      <span className={`mark ${ok ? "pass" : "idle"}`}>{ok ? "✓" : "○"}</span>
      <span style={{ color: ok ? "var(--text)" : "var(--muted)" }}>{label}</span>
    </li>
  );
}

export default function GuardianPage() {
  return (
    <Suspense fallback={null}>
      <GuardianFlow />
    </Suspense>
  );
}
