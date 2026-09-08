"use client";

import { useState } from "react";

import { isAddress, shorten } from "@/lib/dsrp";

export function ContractPicker({
  contract,
  onChange,
  onClear,
}: {
  contract?: string;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState("");
  const valid = isAddress(draft);

  if (contract) {
    return (
      <div className="card">
        <div className="spread">
          <div>
            <h2>Wallet contract</h2>
            <p className="sub" style={{ margin: 0 }}>
              <span className="mono">{shorten(contract, 6)}</span>
            </p>
          </div>
          <button className="ghost small" onClick={onClear}>
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Point at a deployment</h2>
      <p className="sub">
        Paste the address of a <span className="mono">DynamicSocialRecovery</span> contract. This
        site keeps no registry of wallets, so nothing here is looked up for you &mdash; the address
        is stored only in this browser.
      </p>
      <div className="row">
        <input
          type="text"
          placeholder="0x…"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value.trim())}
          style={{ flex: 1, minWidth: 260 }}
        />
        <button className="primary" disabled={!valid} onClick={() => onChange(draft)}>
          Continue
        </button>
      </div>
      {draft.length > 0 && !valid && (
        <p className="note danger" style={{ marginTop: 12 }}>
          That is not a 20-byte hex address.
        </p>
      )}
    </div>
  );
}
