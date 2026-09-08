export function ApprovalProgress({
  proofCount,
  threshold,
}: {
  proofCount: number;
  threshold: number;
}) {
  const met = threshold > 0 && proofCount >= threshold;
  const pct = threshold > 0 ? Math.min(100, (proofCount / threshold) * 100) : 0;

  return (
    <div>
      <div className="spread" style={{ marginBottom: 7 }}>
        <span style={{ fontSize: 13, color: "var(--muted)" }}>Guardian approvals</span>
        <span className={met ? "badge ok" : "badge accent"}>
          {proofCount} of {threshold}
        </span>
      </div>
      <div className={met ? "meter met" : "meter"}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
