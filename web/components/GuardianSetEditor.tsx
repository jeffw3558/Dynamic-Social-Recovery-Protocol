"use client";

import { assertValidGuardianSet, devAccountSalt } from "@dsrp/sdk/vault";
import { useMemo, useState } from "react";
import type { Hex } from "viem";

import { CHAIN_ID } from "@/lib/dsrp";

export interface GuardianDraft {
  email: string;
  accountSalt: Hex | "";
}

const DEV_CHAIN = 31337;

export function GuardianSetEditor({
  guardians,
  threshold,
  onChange,
  disabled,
}: {
  guardians: GuardianDraft[];
  threshold: number;
  onChange: (guardians: GuardianDraft[], threshold: number) => void;
  disabled?: boolean;
}) {
  const [showSalts, setShowSalts] = useState(false);

  const validation = useMemo(() => {
    const filled = guardians.filter((g) => g.email.trim() !== "");
    if (filled.length === 0) return { ok: false, reason: "Add at least one guardian." };
    try {
      // Same preconditions the contract enforces, so the form fails for the same
      // reasons the chain would rather than reverting after gas is spent.
      assertValidGuardianSet({
        threshold,
        guardians: filled.map((g) => ({
          email: g.email,
          accountSalt: (g.accountSalt || devAccountSalt(g.email)) as Hex,
        })),
      });
      return { ok: true as const };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }, [guardians, threshold]);

  const update = (index: number, patch: Partial<GuardianDraft>) => {
    onChange(
      guardians.map((g, i) => (i === index ? { ...g, ...patch } : g)),
      threshold,
    );
  };

  return (
    <div>
      <div className="grid" style={{ gap: 10 }}>
        {guardians.map((g, i) => (
          <div key={i}>
            <div className="guardian-row">
              <input
                type="email"
                placeholder="guardian@example.com"
                value={g.email}
                disabled={disabled}
                spellCheck={false}
                onChange={(e) => update(i, { email: e.target.value })}
              />
              <button
                className="ghost small"
                disabled={disabled || guardians.length === 1}
                onClick={() =>
                  onChange(
                    guardians.filter((_, j) => j !== i),
                    Math.min(threshold, Math.max(1, guardians.length - 1)),
                  )
                }
              >
                Remove
              </button>
            </div>
            {showSalts && (
              <input
                type="text"
                className="mono"
                style={{ marginTop: 6 }}
                placeholder={g.email ? devAccountSalt(g.email) : "0x… accountSalt"}
                value={g.accountSalt}
                disabled={disabled}
                spellCheck={false}
                onChange={(e) => update(i, { accountSalt: e.target.value as Hex })}
              />
            )}
          </div>
        ))}
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <button
          className="small"
          disabled={disabled || guardians.length >= 64}
          onClick={() => onChange([...guardians, { email: "", accountSalt: "" }], threshold)}
        >
          Add guardian
        </button>
        <button className="ghost small" onClick={() => setShowSalts((v) => !v)}>
          {showSalts ? "Hide" : "Show"} account salts
        </button>
      </div>

      <h3>Approvals required</h3>
      <div className="row">
        <input
          type="number"
          min={1}
          max={Math.max(1, guardians.filter((g) => g.email.trim()).length)}
          value={threshold}
          disabled={disabled}
          onChange={(e) => onChange(guardians, Number(e.target.value))}
        />
        <span style={{ fontSize: 13.5, color: "var(--muted)" }}>
          of {guardians.filter((g) => g.email.trim()).length} guardians
        </span>
      </div>

      {!validation.ok && (
        <p className="note warn" style={{ marginTop: 14 }}>
          {validation.reason}
        </p>
      )}

      {CHAIN_ID !== DEV_CHAIN && (
        <p className="note danger" style={{ marginTop: 14 }}>
          <strong>Account salts must come from your blueprint.</strong> Left blank, this form
          derives a placeholder commitment that no real ZK proof will ever match &mdash; every
          approval would be rejected as <span className="mono">NotAGuardian</span>. On a live
          network, paste the salt your blueprint&rsquo;s circuit derives for each guardian.
        </p>
      )}
    </div>
  );
}

export function resolveSalts(guardians: GuardianDraft[]) {
  return guardians
    .filter((g) => g.email.trim() !== "")
    .map((g) => ({
      email: g.email.trim(),
      accountSalt: (g.accountSalt || devAccountSalt(g.email)) as Hex,
    }));
}
