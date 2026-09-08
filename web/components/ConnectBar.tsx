"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { usePathname } from "next/navigation";

export function ConnectBar() {
  const pathname = usePathname();

  // The guardian flow's entire promise is "no wallet, no gas, nothing installed",
  // and it holds — approvals go through the relayer. Showing a prominent Connect
  // Wallet button on that page contradicts the copy directly and invites guardians
  // to go looking for a wallet they do not need.
  if (pathname?.startsWith("/guardian")) {
    return <span style={{ fontSize: 13, color: "var(--muted)" }}>No wallet needed</span>;
  }

  return <ConnectButton showBalance={false} accountStatus="address" chainStatus="icon" />;
}
