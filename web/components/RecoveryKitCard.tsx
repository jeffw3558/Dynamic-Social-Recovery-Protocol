"use client";

import type { Address, Hex } from "viem";

export interface RecoveryKit {
  version: 1;
  contractAddress: Address;
  chainId: number;
  threshold: number;
  payloadHash: Hex;
  createdAt: string;
  guardians: { email: string; accountSalt: Hex }[];
}

/**
 * Download the guardian list the owner will need in order to *start* a recovery.
 *
 * This exists because of a real gap: the on-chain Lit gate only releases the
 * guardian list once approvals have already reached the threshold — but you need
 * those addresses to ask for approvals in the first place. The encrypted payload is
 * therefore a post-recovery backup, not something that can drive a recovery, so the
 * owner needs their own copy from the moment they enroll.
 *
 * It stays zero-database: this is the user's file, on the user's disk. Nothing is
 * uploaded anywhere.
 */
export function RecoveryKitCard({ kit }: { kit: RecoveryKit }) {
  const download = () => {
    const blob = new Blob([JSON.stringify(kit, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dsrp-recovery-kit-${kit.contractAddress.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card">
      <h2>Recovery kit</h2>
      <p className="sub">
        The list of who can recover this wallet, and the contract they do it on. Keep it somewhere
        you&rsquo;ll still have access to when your wallet key is gone &mdash; a password manager,
        printed in a drawer, with a lawyer.
      </p>

      <table>
        <thead>
          <tr>
            <th>Guardian</th>
            <th>Commitment</th>
          </tr>
        </thead>
        <tbody>
          {kit.guardians.map((g) => (
            <tr key={g.accountSalt}>
              <td>{g.email}</td>
              <td className="mono">{g.accountSalt.slice(0, 18)}…</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="primary" onClick={download}>
          Download kit
        </button>
        <button className="ghost" onClick={() => window.print()}>
          Print
        </button>
      </div>

      <p className="note danger" style={{ marginTop: 16 }}>
        <strong>Losing both this kit and your wallet key makes recovery impossible.</strong> The
        encrypted copy on-chain only unlocks <em>after</em> a recovery succeeds, so it cannot tell
        you whom to contact when you are locked out. This file is the copy that can.
      </p>
    </div>
  );
}
