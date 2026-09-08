"use client";

import { DSRP_ABI } from "@dsrp/sdk/chain";
import { canonicalCommand } from "@dsrp/sdk/command";
import { useState } from "react";
import type { Hex } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ApprovalProgress } from "@/components/ApprovalProgress";
import { ContractPicker } from "@/components/ContractPicker";
import { CountdownToEta } from "@/components/CountdownToEta";
import { TxButton } from "@/components/TxButton";
import { useContractAddress } from "@/hooks/useContractAddress";
import { useDsrpState, useRecoveryStatus } from "@/hooks/useDsrp";
import { CHAIN_ID, isAddress, shorten } from "@/lib/dsrp";

export default function RecoverPage() {
  const { contract, setContract, clear, ready } = useContractAddress();
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient({ chainId: CHAIN_ID });

  const state = useDsrpState(contract);
  const [manualId, setManualId] = useState("");
  const watchedId = manualId ? BigInt(manualId) : state.activeRequestId;
  const status = useRecoveryStatus(contract, watchedId);

  const [newOwner, setNewOwner] = useState("");
  const [copied, setCopied] = useState(false);

  if (!ready) return null;

  if (!contract) {
    return (
      <>
        <h1 className="page-title">Recover a wallet</h1>
        <p className="page-lede">Start a recovery, watch guardians approve, then execute.</p>
        <ContractPicker contract={contract} onChange={setContract} onClear={clear} />
      </>
    );
  }

  const initiate = async (): Promise<Hex> => {
    if (!walletClient) throw new Error("Connect a wallet first.");
    return walletClient.writeContract({
      address: contract,
      abi: DSRP_ABI,
      functionName: "initiateRecovery",
      args: [newOwner as `0x${string}`],
      chain: walletClient.chain,
      account: walletClient.account,
    });
  };

  const execute = async (): Promise<Hex> => {
    if (!walletClient) throw new Error("Connect a wallet first.");
    return walletClient.writeContract({
      address: contract,
      abi: DSRP_ABI,
      functionName: "executeRecovery",
      args: [watchedId],
      chain: walletClient.chain,
      account: walletClient.account,
    });
  };

  const hasActive = state.activeRequestId > 0n;
  const command =
    status.request && contract
      ? canonicalCommand({ contractAddress: contract, chainId: CHAIN_ID }, watchedId, status.request.newOwner)
      : undefined;

  const guardianLink =
    typeof window !== "undefined" && status.request
      ? `${window.location.origin}/guardian?contract=${contract}&request=${watchedId}`
      : "";

  return (
    <>
      <h1 className="page-title">Recover a wallet</h1>
      <p className="page-lede">
        Anyone can start a recovery &mdash; you will usually be doing it from a brand-new address,
        which is the whole point. It grants nothing on its own: it needs guardian approvals and a
        full 48 hours, and the current owner can cancel it at any moment until then.
      </p>

      <ContractPicker contract={contract} onChange={setContract} onClear={clear} />

      {!hasActive && (
        <div className="card">
          <h2>Start a recovery</h2>
          <p className="sub">
            Name the address that should own this wallet once recovery completes. Usually a fresh
            wallet you control.
          </p>
          {state.threshold === 0 ? (
            <p className="note warn">
              This wallet has no guardian set published yet, so recovery cannot be started.
            </p>
          ) : (
            <>
              <label htmlFor="newOwner">New owner address</label>
              <input
                id="newOwner"
                type="text"
                placeholder={address ?? "0x…"}
                value={newOwner}
                spellCheck={false}
                onChange={(e) => setNewOwner(e.target.value.trim())}
              />
              <div className="row" style={{ marginTop: 8, marginBottom: 18 }}>
                {address && (
                  <button className="ghost small" onClick={() => setNewOwner(address)}>
                    Use connected wallet
                  </button>
                )}
              </div>
              <TxButton
                label="Start recovery"
                pendingLabel="Starting…"
                chainId={CHAIN_ID}
                disabled={!isAddress(newOwner) || !isConnected}
                onSend={initiate}
                onConfirmed={state.refetch}
                hint={!isConnected ? "Connect any wallet to pay the gas." : undefined}
              />
            </>
          )}
        </div>
      )}

      {!hasActive && (
        <div className="card">
          <h2>Track an existing request</h2>
          <p className="sub">Already started one? Enter its id.</p>
          <input
            type="number"
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
            placeholder="1"
          />
        </div>
      )}

      {status.request && (
        <>
          <div className="card">
            <div className="spread">
              <h2>Request #{watchedId.toString()}</h2>
              {status.request.executed ? (
                <span className="badge ok">Executed</span>
              ) : status.request.cancelled ? (
                <span className="badge danger">Cancelled by owner</span>
              ) : status.executable ? (
                <span className="badge ok">Ready to execute</span>
              ) : (
                <span className="badge accent">In progress</span>
              )}
            </div>
            <p className="sub">
              Proposed owner <span className="mono">{shorten(status.request.newOwner, 6)}</span>
            </p>

            <div className="grid two" style={{ marginBottom: 20 }}>
              <div>
                <span style={{ fontSize: 13, color: "var(--muted)" }}>48-hour timelock</span>
                <CountdownToEta eta={status.eta} mature={status.mature} />
              </div>
              <ApprovalProgress
                proofCount={status.request.proofCount}
                threshold={status.threshold}
              />
            </div>

            {!status.request.executed && !status.request.cancelled && (
              <TxButton
                label="Execute recovery"
                pendingLabel="Executing…"
                chainId={CHAIN_ID}
                disabled={!status.executable || !isConnected}
                onSend={execute}
                onConfirmed={() => {
                  state.refetch();
                  status.refetch();
                }}
                hint={
                  status.executable
                    ? undefined
                    : !status.mature
                      ? "Waiting on the timelock."
                      : `Waiting on ${status.threshold - status.request.proofCount} more approval(s).`
                }
              />
            )}

            {status.request.cancelled && (
              <p className="note danger">
                The owner cancelled this recovery. If that was not you and you still need access,
                the owner key is evidently still in someone&rsquo;s hands.
              </p>
            )}
          </div>

          {!status.request.executed && !status.request.cancelled && (
            <div className="card">
              <h2>Ask your guardians</h2>
              <p className="sub">
                Send each guardian this link. They approve by replying to an email &mdash; no
                wallet, no gas, nothing to install.
              </p>

              <label>Guardian link</label>
              <div className="row">
                <input type="text" readOnly value={guardianLink} className="mono" style={{ flex: 1 }} />
                <button
                  className="small"
                  onClick={() => {
                    void navigator.clipboard.writeText(guardianLink);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>

              <h3>The exact subject line they must send</h3>
              <p className="mono note">{command}</p>
              <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
                This string is bound to this request, this wallet and this chain. That is what stops
                an approval meant for one recovery being replayed into another.
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}
