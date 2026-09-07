// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IZKEmailVerifier, EmailProof} from "../../src/interfaces/IZKEmailVerifier.sol";

/// @notice Programmable stand-in for a generated ZK Email verifier.
/// @dev A real Groth16/Honk verifier cannot be driven inside a fuzz or invariant loop —
///      it needs a genuine proof per call, which no fuzzer can synthesise. This mock
///      makes the *rejection* branch reachable, which is the whole point: without it the
///      "invalid proof reverts" invariant could never be exercised.
///
///      The real generated verifier is covered separately by a fixture-based test over a
///      committed `.eml` and its proof.
contract MockZKEmailVerifier is IZKEmailVerifier {
    /// @notice Global switch: when false, every proof is rejected.
    bool public shouldVerify = true;

    /// @notice Per-nullifier rejection, for testing a single bad proof among good ones.
    mapping(bytes32 emailNullifier => bool) public rejected;

    uint256 private _commandBytes = 605;

    function setShouldVerify(bool value) external {
        shouldVerify = value;
    }

    function setRejected(bytes32 emailNullifier, bool value) external {
        rejected[emailNullifier] = value;
    }

    function setCommandBytes(uint256 value) external {
        _commandBytes = value;
    }

    /// @inheritdoc IZKEmailVerifier
    function commandBytes() external view returns (uint256) {
        return _commandBytes;
    }

    /// @inheritdoc IZKEmailVerifier
    /// @dev Returns false rather than reverting, matching the interface contract.
    function verifyEmailProof(EmailProof calldata proof) external view returns (bool) {
        if (!shouldVerify) return false;
        if (rejected[proof.emailNullifier]) return false;
        return true;
    }
}
