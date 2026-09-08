"use client";

import { DSRP_ABI } from "@dsrp/sdk/chain";
import { useState } from "react";
import type { Address, Hex } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ApprovalProgress } from "@/components/ApprovalProgress";
import { ContractPicker } from "@/components/ContractPicker";
import { CountdownToEta } from "@/components/CountdownToEta";
import {
  GuardianSetEditor,
  resolveSalts,
  validateGuardianDraft,
  type GuardianDraft,
} from "@/components/GuardianSetEditor";
import { RecoveryKitCard, type RecoveryKit } from "@/components/RecoveryKitCard";
import { TxButton } from "@/components/TxButton";
import { useContractAddress } from "@/hooks/useContractAddress";
import { useDsrpState, useRecoveryStatus } from "@/hooks/useDsrp";
import { CHAIN_ID, shorten } from "@/lib/dsrp";
import { readableError } from "@/lib/errors";

export default function OwnerPage() {
  const { contract, setContract, clear, ready } = useContractAddress();
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient({ chainId: CHAIN_ID });

  const state = useDsrpState(contract);
  const active = useRecoveryStatus(contract, state.activeRequestId);

  const [guardians, setGuardians] = useState<GuardianDraft[]>([
    { email: "", accountSalt: "" },
    { email: "", accountSalt: "" },
    { email: "", accountSalt: "" },
  ]);
  const [threshold, setThreshold] = useState(2);
  const [kit, setKit] = useState<RecoveryKit | undefined>();
  const [encryptError, setEncryptError] = useState<string | undefined>();

  const isOwner =
    Boolean(address) && Boolean(state.owner) && address?.toLowerCase() === state.owner?.toLowerCase();

  const draft = validateGuardianDraft(guardians, threshold);

  if (!ready) return null;

  if (!contract) {
    return (
      <>
        <h1 className="page-title">Owner console</h1>
        <p className="page-lede">Enroll guardians, keep watch, and cancel anything you did not ask for.</p>
        <ContractPicker contract={contract} onChange={setContract} onClear={clear} />
      </>
    );
  }

  const publishPayload = async (): Promise<Hex> => {
    if (!walletClient) throw new Error("Connect a wallet first.");
    setEncryptError(undefined);

    const resolved = resolveSalts(guardians);

    // Encryption happens server-side: the Chipotle API key can never reach a browser.
    const res = await fetch("/api/vault/encrypt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractAddress: contract,
        chainId: CHAIN_ID,
        set: { threshold, guardians: resolved },
      }),
    });
    if (!res.ok) {
      // The route answers with { error }; surfacing the raw body would put a JSON
      // blob in front of the user.
      const detail = await res.json().catch(() => ({}) as { error?: string });
      throw new Error(detail.error ?? `Encryption failed (${res.status})`);
    }
    const { ciphertext, hash } = (await res.json()) as { ciphertext: Hex; hash: Hex };

    const txHash = await walletClient.writeContract({
      address: contract,
      abi: DSRP_ABI,
      functionName: "setGuardianPayload",
      args: [ciphertext, resolved.map((g) => g.accountSalt), BigInt(threshold)],
      chain: walletClient.chain,
      account: walletClient.account,
    });

    setKit({
      version: 1,
      contractAddress: contract,
      chainId: CHAIN_ID,
      threshold,
      payloadHash: hash,
      createdAt: new Date().toISOString(),
      guardians: resolved,
    });

    return txHash;
  };

  const cancel = async (): Promise<Hex> => {
    if (!walletClient) throw new Error("Connect a wallet first.");
    return walletClient.writeContract({
      address: contract as Address,
      abi: DSRP_ABI,
      functionName: "cancelRecovery",
      args: [state.activeRequestId],
      chain: walletClient.chain,
      account: walletClient.account,
    });
  };

  return (
    <>
      <h1 className="page-title">Owner console</h1>
      <p className="page-lede">
        Enroll guardians, keep watch, and cancel anything you did not ask for.
      </p>

      <ContractPicker contract={contract} onChange={setContract} onClear={clear} />

      {/* The veto comes first on the page, above enrollment: if there is an
          unexpected recovery in flight, that is the only thing that matters. */}
      {state.activeRequestId > 0n && active.request && (
        <div className="card" style={{ borderColor: "var(--warn)" }}>
          <div className="spread">
            <h2>A recovery is in flight</h2>
            <span className="badge warn">Request #{state.activeRequestId.toString()}</span>
          </div>
          <p className="sub">
            Someone has proposed transferring this wallet to{" "}
            <span className="mono">{shorten(active.request.newOwner, 6)}</span>. If that was not
            you, cancel it now.
          </p>

          <div className="grid two" style={{ marginBottom: 18 }}>
            <div>
              <span style={{ fontSize: 13, color: "var(--muted)" }}>Time left before it can execute</span>
              <CountdownToEta eta={active.eta} mature={active.mature} />
            </div>
            <ApprovalProgress proofCount={active.request.proofCount} threshold={active.threshold} />
          </div>

          {isOwner ? (
            <>
              <TxButton
                label="Cancel this recovery"
                pendingLabel="Cancelling…"
                variant="danger"
                chainId={CHAIN_ID}
                onSend={cancel}
                onConfirmed={() => {
                  state.refetch();
                  active.refetch();
                }}
              />
              <p className="note" style={{ marginTop: 14 }}>
                You can cancel at any point before execution &mdash; including after the timer
                reaches zero and every guardian has approved. Only execution closes the window.
              </p>
            </>
          ) : (
            <p className="note warn">
              Only the current owner (<span className="mono">{shorten(state.owner ?? "", 6)}</span>)
              can cancel. Connect that wallet.
            </p>
          )}
        </div>
      )}

      <div className="card">
        <h2>This wallet</h2>
        <dl className="kv">
          <dt>Owner</dt>
          <dd>{state.owner ?? "—"}</dd>
          <dt>Guardians</dt>
          <dd>{state.guardianCount}</dd>
          <dt>Threshold</dt>
          <dd>{state.threshold || "not configured"}</dd>
          <dt>Timelock</dt>
          <dd>{Number(state.delay) / 3600} hours</dd>
          <dt>Payload hash</dt>
          <dd>{state.payloadHash ?? "—"}</dd>
        </dl>
        {isConnected && !isOwner && state.owner && (
          <p className="note warn" style={{ marginTop: 16 }}>
            The connected wallet is not the owner. You can read everything here, but only the owner
            can publish guardians or cancel a recovery.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Guardians</h2>
        <p className="sub">
          Emails are encrypted before they touch the chain. What gets published on-chain is a
          commitment per guardian &mdash; never an address, never a domain.
        </p>

        <GuardianSetEditor
          guardians={guardians}
          threshold={threshold}
          disabled={!isOwner}
          onChange={(g, t) => {
            setGuardians(g);
            setThreshold(t);
          }}
        />

        {state.activeRequestId > 0n && (
          <p className="note warn" style={{ marginTop: 16 }}>
            A recovery is in flight, so the guardian set is locked. Cancel it first &mdash; changing
            guardians mid-recovery would silently re-scope approvals guardians have already given.
          </p>
        )}

        <div style={{ marginTop: 18 }}>
          <TxButton
            label="Publish guardian set"
            pendingLabel="Encrypting and publishing…"
            chainId={CHAIN_ID}
            disabled={!isOwner || state.activeRequestId > 0n || !draft.ok}
            onSend={publishPayload}
            onConfirmed={state.refetch}
            hint={
              !isConnected
                ? "Connect the owner wallet to publish."
                : !draft.ok
                  ? draft.reason
                  : undefined
            }
          />
          {encryptError && (
            <p className="note danger" style={{ marginTop: 12 }}>
              {readableError(encryptError)}
            </p>
          )}
        </div>
      </div>

      {kit && <RecoveryKitCard kit={kit} />}
    </>
  );
}
