/**
 * Authorized decryption gate for the Dynamic Social Recovery Protocol.
 *
 * This action is the direct replacement for the Access Control Conditions that Lit
 * removed. Where an ACC could only assert a static predicate over chain state, this
 * reads the entire `RecoveryRequest` and decides atomically:
 *
 *     released  ⟺  request exists
 *                  ∧ block.timestamp ≥ initiatedAt + 48h   (isMature)
 *                  ∧ proofCount ≥ threshold
 *                  ∧ ¬cancelled ∧ ¬executed
 *
 * Deploy this to IPFS and authorize its CID against the PKP that holds the guardian
 * payload. Decryption is then impossible except through exactly these conditions —
 * including for whoever deployed it.
 *
 * jsParams: { pkpId, ciphertext, contractAddress, chainId, requestId, rpcUrl }
 */

// keccak256("isPending(uint256)")[0:4], etc. — kept as literals so the action has no
// dependency on an ABI encoder inside the Lit runtime.
// Verified against the compiled ABI by `test_GateActionSelectorsAreStable` in
// contracts/test/DynamicSocialRecovery.t.sol — that test fails if any signature
// changes, which is the only thing standing between these literals and a silently
// broken gate.
const SELECTOR = {
  isPending: "0xca8836d2", // isPending(uint256)
  isMature: "0x3e55e63d", // isMature(uint256)
  threshold: "0x42cde4e8", // threshold()
  getRequest: "0xc58343ef", // getRequest(uint256)
};

async function ethCall(rpcUrl, to, data) {
  const response = await Lit.Actions.fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`eth_call failed: ${JSON.stringify(json.error)}`);
  return json.result;
}

const word = (hex, index) => hex.slice(2 + index * 64, 2 + (index + 1) * 64);
const toBool = (hex, index) => BigInt("0x" + word(hex, index)) === 1n;
const toBigInt = (hex, index) => BigInt("0x" + word(hex, index));

/** uint256 argument, left-padded to 32 bytes. */
const encodeUint = (value) => BigInt(value).toString(16).padStart(64, "0");

async function main({ pkpId, ciphertext, contractAddress, requestId, rpcUrl }) {
  const arg = encodeUint(requestId);

  const [pendingRaw, matureRaw, thresholdRaw, requestRaw] = await Promise.all([
    ethCall(rpcUrl, contractAddress, SELECTOR.isPending + arg),
    ethCall(rpcUrl, contractAddress, SELECTOR.isMature + arg),
    ethCall(rpcUrl, contractAddress, SELECTOR.threshold),
    ethCall(rpcUrl, contractAddress, SELECTOR.getRequest + arg),
  ]);

  // getRequest returns (address newOwner, uint64 timestamp, uint32 proofCount,
  //                     bool executed, bool cancelled) as five padded words.
  const proofCount = toBigInt(requestRaw, 2);
  const executed = toBool(requestRaw, 3);
  const cancelled = toBool(requestRaw, 4);
  const threshold = BigInt(thresholdRaw);

  const deny = (reason) => ({ denied: reason });

  if (!toBool(pendingRaw, 0)) return deny("request is not pending");
  if (executed) return deny("request already executed");
  if (cancelled) return deny("request was cancelled by the owner");
  if (!toBool(matureRaw, 0)) return deny("48-hour timelock has not elapsed");
  if (proofCount < threshold) {
    return deny(`approvals ${proofCount} below threshold ${threshold}`);
  }

  const plaintext = await Lit.Actions.Decrypt({ pkpId, ciphertext });
  return { plaintext };
}
