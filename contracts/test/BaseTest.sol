// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {DynamicSocialRecovery} from "../src/DynamicSocialRecovery.sol";
import {EmailProof} from "../src/interfaces/IZKEmailVerifier.sol";
import {MockZKEmailVerifier} from "./mocks/MockZKEmailVerifier.sol";
import {MockDKIMRegistry} from "./mocks/MockDKIMRegistry.sol";

/// @notice Shared fixture and proof-construction helpers.
/// @dev Holds no test functions, so it contributes no cases of its own.
abstract contract BaseTest is Test {
    DynamicSocialRecovery internal dsr;
    MockZKEmailVerifier internal verifier;
    MockDKIMRegistry internal dkim;

    address internal owner = makeAddr("owner");
    address internal newOwner = makeAddr("newOwner");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    string internal constant DOMAIN = "gmail.com";
    bytes32 internal constant PUBKEY_HASH = keccak256("dkim-public-key");
    bytes internal constant PAYLOAD = hex"deadbeefcafe";

    uint256 internal constant DELAY = 48 hours;

    function setUp() public virtual {
        verifier = new MockZKEmailVerifier();
        dkim = new MockDKIMRegistry();
        dsr = new DynamicSocialRecovery(owner, verifier, dkim);

        // Start well past the epoch so `timestamp != 0` existence checks are meaningful
        // and so warping backwards in tests is possible.
        vm.warp(1_800_000_000);
    }

    /* ------------------------------------------------------------------ *
     *                              HELPERS                                *
     * ------------------------------------------------------------------ */

    /// @dev Deterministic guardian commitment. Stands in for H(email ‖ salt).
    function _salt(uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("guardian", index));
    }

    function _salts(uint256 count) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = _salt(i);
        }
    }

    /// @dev Configure `count` guardians with the given approval threshold.
    function _configure(uint256 count, uint256 threshold) internal {
        vm.prank(owner);
        dsr.setGuardianPayload(PAYLOAD, _salts(count), threshold);
    }

    /// @dev A well-formed proof that passes all seven checks, for `guardianIndex`.
    ///      `nullifier` is explicit so replay tests can deliberately reuse one.
    function _proof(uint256 requestId, address proposedOwner, uint256 guardianIndex, bytes32 nullifier)
        internal
        view
        returns (EmailProof memory)
    {
        return EmailProof({
            domainName: DOMAIN,
            publicKeyHash: PUBKEY_HASH,
            timestamp: block.timestamp,
            maskedCommand: dsr.canonicalCommand(requestId, proposedOwner),
            emailNullifier: nullifier,
            accountSalt: _salt(guardianIndex),
            isCodeExist: true,
            proof: hex"01"
        });
    }

    /// @dev Fresh nullifier derived from (request, guardian), so distinct guardians and
    ///      distinct requests never collide by accident.
    function _nullifier(uint256 requestId, uint256 guardianIndex) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("nullifier", requestId, guardianIndex));
    }

    /// @dev Submit one guardian's approval, relayed by a third party (the normal path).
    function _approve(uint256 requestId, address proposedOwner, uint256 guardianIndex) internal {
        vm.prank(relayer);
        dsr.submitEmailProof(
            requestId, _proof(requestId, proposedOwner, guardianIndex, _nullifier(requestId, guardianIndex))
        );
    }

    /// @dev Drive a request from `initiate` to exactly `count` approvals.
    function _initiateAndApprove(address proposedOwner, uint256 count)
        internal
        returns (uint256 requestId)
    {
        requestId = dsr.initiateRecovery(proposedOwner);
        for (uint256 i; i < count; ++i) {
            _approve(requestId, proposedOwner, i);
        }
    }
}
