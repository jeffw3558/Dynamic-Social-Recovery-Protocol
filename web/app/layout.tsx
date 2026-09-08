import type { Metadata } from "next";
import Link from "next/link";

import { Providers } from "./providers";
import { ConnectBar } from "@/components/ConnectBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dynamic Social Recovery",
  description:
    "Social recovery with no database: threshold-encrypted guardians on-chain, email approvals proven with ZK, and a 48-hour owner veto.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="site-header">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true" />
              <span>Dynamic Social Recovery</span>
            </Link>
            <nav className="site-nav">
              <Link href="/owner">Owner</Link>
              <Link href="/guardian">Guardian</Link>
              <Link href="/recover">Recover</Link>
            </nav>
            <ConnectBar />
          </header>
          <main className="site-main">{children}</main>
          <footer className="site-footer">
            <span>
              Guardian identities never touch this site&rsquo;s server &mdash; there isn&rsquo;t one.
            </span>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
