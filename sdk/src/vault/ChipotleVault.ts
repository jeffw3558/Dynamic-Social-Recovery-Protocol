import { keccak256, toHex, type Hex } from "viem";

import type { EncryptedPayload, GuardianSet, RecoveryContext } from "../types.js";
import { assertValidGuardianSet, VaultAccessDeniedError, type GuardianVault } from "./GuardianVault.js";

export interface ChipotleConfig {
  /** Base URL of the Chipotle core API. */
  readonly baseUrl?: string;
  /** API key issued by the Chipotle dashboard. */
  readonly apiKey: string;
  /** PKP that the guardian payload is encrypted under. */
  readonly pkpId: string;
  /** IPFS CID of the authorized decryption gate (`lit-actions/guardian-gate.js`). */
  readonly gateActionCid: string;
  /** RPC the gate action uses to read the recovery contract. */
  readonly rpcUrl: string;
  /**
   * Path of the "execute a Lit Action" endpoint, relative to `baseUrl`.
   *
   * Chipotle reached GA on 2026-04-01 and its REST surface is documented mainly by
   * the OpenAPI schema at `${baseUrl}/swagger-ui` rather than by prose. This is
   * exposed as config so a path change does not require a code change — verify it
   * against that schema before a production deploy.
   */
  readonly executePath?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}

const DEFAULT_BASE_URL = "https://api.chipotle.litprotocol.com/core/v1";
const DEFAULT_EXECUTE_PATH = "/actions/execute";

/**
 * Production vault, backed by Lit Chipotle (v3).
 *
 * Chipotle replaced declarative Access Control Conditions with something strictly
 * more expressive: decryption is gated by *which Lit Action is authorized on-chain
 * to use the PKP*. Instead of asserting a static predicate, our gate reads the
 * whole `RecoveryRequest` — maturity, approvals against threshold, and both
 * terminal flags — and decides atomically against live chain state.
 *
 * Encryption is client-side inside the action; only decryption talks to the nodes.
 */
export class ChipotleVault implements GuardianVault {
  readonly scheme = "chipotle-v3" as const;

  private readonly baseUrl: string;
  private readonly executePath: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly config: ChipotleConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.executePath = config.executePath ?? DEFAULT_EXECUTE_PATH;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("ChipotleVault: no fetch implementation available");
    }
  }

  async encrypt(set: GuardianSet, ctx: RecoveryContext): Promise<EncryptedPayload> {
    assertValidGuardianSet(set);

    const { ciphertext } = await this.execute<{ ciphertext: string }>({
      code: ENCRYPT_ACTION,
      jsParams: { pkpId: this.config.pkpId, secret: JSON.stringify(set) },
    });

    if (typeof ciphertext !== "string" || ciphertext.length === 0) {
      throw new Error("ChipotleVault: action returned no ciphertext");
    }

    const hex = toHex(new TextEncoder().encode(ciphertext));
    return { ciphertext: hex, hash: keccak256(hex), scheme: this.scheme };
  }

  async decrypt(payload: EncryptedPayload, ctx: RecoveryContext): Promise<GuardianSet> {
    if (ctx.requestId === undefined) {
      throw new Error("ChipotleVault: decrypt requires ctx.requestId — the gate checks it");
    }
    if (keccak256(payload.ciphertext) !== payload.hash) {
      throw new Error("ChipotleVault: payload hash does not match ciphertext");
    }

    let result: { plaintext?: string; denied?: string };
    try {
      result = await this.execute<{ plaintext?: string; denied?: string }>({
        cid: this.config.gateActionCid,
        jsParams: {
          pkpId: this.config.pkpId,
          ciphertext: fromHexToUtf8(payload.ciphertext),
          contractAddress: ctx.contractAddress,
          chainId: ctx.chainId,
          requestId: ctx.requestId.toString(10),
          rpcUrl: this.config.rpcUrl,
        },
      });
    } catch (cause) {
      throw new VaultAccessDeniedError("Chipotle gate rejected the decryption request", { cause });
    }

    if (result.denied !== undefined || typeof result.plaintext !== "string") {
      throw new VaultAccessDeniedError(
        result.denied ?? "gate released no plaintext; the recovery does not qualify",
      );
    }

    return JSON.parse(result.plaintext) as GuardianSet;
  }

  private async execute<T>(body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${this.executePath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Chipotle ${this.executePath} failed: ${response.status} ${await safeText(response)}`,
      );
    }

    const json = (await response.json()) as { response?: T } & T;
    // The API wraps action return values; tolerate both shapes.
    return (json.response ?? json) as T;
  }
}

/** Encryption is a one-liner and blueprint-independent, so it ships inline. */
const ENCRYPT_ACTION = `
async function main({ pkpId, secret }) {
  const ciphertext = await Lit.Actions.Encrypt({ pkpId, message: secret });
  return { ciphertext };
}
`;

function fromHexToUtf8(hex: Hex): string {
  return new TextDecoder().decode(Buffer.from(hex.slice(2), "hex"));
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 512);
  } catch {
    return "<unreadable body>";
  }
}
