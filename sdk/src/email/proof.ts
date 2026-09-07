import { initZkEmailSdk, type Blueprint, type Proof } from "@zk-email/sdk";
import { toHex, type Hex } from "viem";

import type { EmailProofStruct } from "../types.js";

export interface BlueprintConfig {
  /** Registry slug, e.g. "myorg/DsrpGuardianApproval@v1". */
  readonly slug: string;
  /** Prove in-process rather than via the hosted prover. */
  readonly local?: boolean;
}

/**
 * Names of the blueprint's public outputs that map onto the Solidity struct.
 *
 * The ZK Email SDK returns public outputs keyed by the blueprint's own decomposed
 * regex names, so there is no universal mapping — a blueprint that does not expose
 * these outputs cannot drive this contract. Defaults follow the conventional
 * `email-tx-builder` naming; override per blueprint.
 */
export interface PublicOutputNames {
  readonly domainName?: string;
  readonly maskedCommand?: string;
  readonly emailNullifier?: string;
  readonly accountSalt?: string;
  readonly timestamp?: string;
  readonly isCodeExist?: string;
}

const DEFAULTS: Required<PublicOutputNames> = {
  domainName: "domainName",
  maskedCommand: "maskedCommand",
  emailNullifier: "emailNullifier",
  accountSalt: "accountSalt",
  timestamp: "timestamp",
  isCodeExist: "isCodeExist",
};

/** Loads the blueprint a guardian's approval will be proven against. */
export async function loadBlueprint(config: BlueprintConfig): Promise<Blueprint> {
  const sdk = initZkEmailSdk();
  return sdk.getBlueprint(config.slug);
}

/**
 * Generate a guardian approval proof from a raw `.eml`.
 *
 * The email must contain the canonical command verbatim — see `command.ts`. The
 * contract rejects anything else, so validate before spending proving time.
 */
export async function generateApprovalProof(
  blueprint: Blueprint,
  eml: string,
  options: { local?: boolean } = {},
): Promise<Proof> {
  const prover = blueprint.createProver({ isLocal: options.local ?? false });
  return prover.generateProof(eml);
}

/**
 * Map a generated {@link Proof} onto the Solidity `EmailProof` struct.
 *
 * @throws if the blueprint does not expose an output the contract requires. Failing
 *         here is deliberate: a struct silently built with a missing field would be
 *         rejected on-chain after the gas was already spent.
 */
export function toEmailProofStruct(
  proof: Proof,
  publicKeyHash: Hex,
  names: PublicOutputNames = {},
): EmailProofStruct {
  const keys = { ...DEFAULTS, ...names };
  const { proofData, publicData } = proof.getProofData();

  const read = (key: string, required = true): string | undefined => {
    const value = publicData[key];
    const first = Array.isArray(value) ? value[0] : value;
    if (first === undefined && required) {
      throw new Error(
        `blueprint output "${key}" is missing; available: ${Object.keys(publicData).join(", ")}`,
      );
    }
    return first;
  };

  return {
    domainName: read(keys.domainName)!,
    publicKeyHash,
    timestamp: BigInt(read(keys.timestamp, false) ?? 0),
    maskedCommand: read(keys.maskedCommand)!,
    emailNullifier: asBytes32(read(keys.emailNullifier)!, "emailNullifier"),
    accountSalt: asBytes32(read(keys.accountSalt)!, "accountSalt"),
    isCodeExist: read(keys.isCodeExist, false) === "true",
    proof: asHex(proofData),
  };
}

/** Reads the DKIM public key hash the proof was generated against. */
export async function readPublicKeyHash(proof: Proof): Promise<Hex> {
  return asBytes32(await proof.getPubKeyHash(), "publicKeyHash");
}

/** Accepts decimal field elements or hex, normalising to 32-byte hex. */
export function asBytes32(value: string, label: string): Hex {
  const big = BigInt(value);
  if (big < 0n || big >= 1n << 256n) throw new Error(`${label} does not fit in bytes32`);
  return `0x${big.toString(16).padStart(64, "0")}`;
}

function asHex(value: string): Hex {
  return value.startsWith("0x") ? (value as Hex) : toHex(value);
}
