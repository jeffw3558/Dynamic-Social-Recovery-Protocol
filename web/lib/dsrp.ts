import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { http, createConfig } from "wagmi";
import type { Address } from "viem";
import { base, baseSepolia, foundry } from "viem/chains";

/** Chain the app talks to. Base in production; anvil for the local dev loop. */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? foundry.id);

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

/**
 * Deployed DynamicSocialRecovery address.
 *
 * Optional: the landing page lets a user paste one, so a single deployment of this
 * site can serve any instance of the protocol. There is no registry and no backend
 * list of wallets — that would be exactly the database this protocol exists without.
 */
export const DEFAULT_CONTRACT = (process.env.NEXT_PUBLIC_DSRP_ADDRESS ?? "") as Address | "";

export const chains = [foundry, baseSepolia, base] as const;

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "dsrp-local-dev";

/**
 * Curated connector list rather than RainbowKit's `getDefaultConfig`.
 *
 * `getDefaultConfig` bundles every connector RainbowKit ships, including the Base
 * Account connector, which pulls in @coinbase/cdp-sdk and its optional `@x402/*`
 * payment modules. Those are not installed and are not remotely needed by a
 * recovery app, and their absence breaks the build outright. Naming the wallets we
 * actually support fixes that and cuts a large subtree out of the bundle.
 */
const connectors = connectorsForWallets(
  [
    {
      groupName: "Recommended",
      wallets: [injectedWallet, metaMaskWallet, rainbowWallet, walletConnectWallet],
    },
    { groupName: "More", wallets: [safeWallet] },
  ],
  { appName: "Dynamic Social Recovery", projectId },
);

export const wagmiConfig = createConfig({
  chains,
  connectors,
  ssr: true,
  transports: {
    [foundry.id]: http(RPC_URL),
    [baseSepolia.id]: http(),
    [base.id]: http(),
  },
});

export function explorerFor(chainId: number): string | undefined {
  if (chainId === base.id) return "https://basescan.org";
  if (chainId === baseSepolia.id) return "https://sepolia.basescan.org";
  return undefined;
}

export function txUrl(chainId: number, hash: string): string | undefined {
  const base_ = explorerFor(chainId);
  return base_ ? `${base_}/tx/${hash}` : undefined;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: string): value is Address {
  return ADDRESS_RE.test(value);
}

export function shorten(value: string, size = 4): string {
  return value.length > 2 * size + 2
    ? `${value.slice(0, size + 2)}…${value.slice(-size)}`
    : value;
}
