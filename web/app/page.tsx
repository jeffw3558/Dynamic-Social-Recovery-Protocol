import Link from "next/link";

export default function Home() {
  return (
    <>
      <h1 className="page-title">Recover a wallet with people, not a seed phrase</h1>
      <p className="page-lede">
        Your guardians live on-chain as a threshold-encrypted blob. They approve by replying to an
        email, and their approval arrives as a zero-knowledge proof of the DKIM signature. No
        database, no backend, and no guardian&rsquo;s address ever written in the clear.
      </p>

      <div className="home-grid">
        <Link href="/owner" className="card home-card">
          <h3>I own a wallet</h3>
          <p>
            Enroll guardians, set a threshold, download a recovery kit &mdash; and cancel any
            recovery you didn&rsquo;t ask for.
          </p>
        </Link>

        <Link href="/guardian" className="card home-card">
          <h3>I&rsquo;m a guardian</h3>
          <p>
            Approve someone&rsquo;s recovery from an email you already sent. No wallet, no gas, no
            seed phrase.
          </p>
        </Link>

        <Link href="/recover" className="card home-card">
          <h3>I lost my key</h3>
          <p>
            Start a recovery to a new address, watch guardian approvals land, then execute once the
            48-hour window closes.
          </p>
        </Link>
      </div>

      <div className="card" style={{ marginTop: 26 }}>
        <h2>How the 48 hours protect you</h2>
        <p className="sub">
          Guardians reaching the threshold is not enough on its own. Every recovery then waits two
          full days, and during that entire window the current owner can cancel it with one
          transaction &mdash; including after the timer has expired and every guardian has
          approved. Only execution closes the window.
        </p>
        <p className="note">
          That is deliberately blunt: it means a stolen guardian majority still cannot take a wallet
          from an owner who is paying attention. The cost is the mirror image &mdash; if your owner
          key is <em>compromised</em>, the attacker can cancel your recoveries too. This protocol
          chooses &ldquo;no unauthorised transfer&rdquo; over &ldquo;recovery always
          succeeds.&rdquo;
        </p>
      </div>
    </>
  );
}
