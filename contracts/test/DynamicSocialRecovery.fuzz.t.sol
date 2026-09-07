// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./BaseTest.sol";
import {DynamicSocialRecovery} from "../src/DynamicSocialRecovery.sol";
import {EmailProof} from "../src/interfaces/IZKEmailVerifier.sol";

/// @notice Property-based tests. Bounded fuzzing for the time/threshold arithmetic,
///         unbounded for the rejection paths, where the interesting inputs are the ones
///         no one thought to enumerate.
contract DynamicSocialRecoveryFuzzTest is BaseTest {
    /* ------------------------------------------------------------------ *
     *                      BOUNDED — timelock arithmetic                  *
     * ------------------------------------------------------------------ */

    /// @dev Property 1: execution is impossible anywhere strictly inside the delay window.
    function testFuzz_ExecuteAlwaysRevertsStrictlyBeforeEta(uint256 elapsed) public {
        elapsed = bound(elapsed, 0, DELAY - 1);

        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 3);
        uint256 eta = dsr.etaOf(id);

        vm.warp(block.timestamp + elapsed);
        assertFalse(dsr.isMature(id));

        vm.expectRevert(
            abi.encodeWithSelector(
                DynamicSocialRecovery.TimelockNotElapsed.selector, block.timestamp, eta
            )
        );
        dsr.executeRecovery(id);
        assertEq(dsr.owner(), owner, "ownership moved inside the delay window");
    }

    /// @dev The mirror: at or beyond the ETA, a fully-approved request always executes.
    function testFuzz_ExecuteAlwaysSucceedsAtOrAfterEta(uint256 extra) public {
        extra = bound(extra, 0, 3650 days);

        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 2);

        vm.warp(dsr.etaOf(id) + extra);
        assertTrue(dsr.isMature(id));

        dsr.executeRecovery(id);
        assertEq(dsr.owner(), newOwner);
    }

    /// @dev The ETA is exactly `initiatedAt + 48h`, whenever the request was opened.
    function testFuzz_EtaIsAlwaysInitiationPlusDelay(uint256 startTime) public {
        startTime = bound(startTime, 1, type(uint64).max - DELAY - 1);
        vm.warp(startTime);

        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        assertEq(dsr.etaOf(id), startTime + DELAY);
    }

    /* ------------------------------------------------------------------ *
     *                        BOUNDED — threshold logic                    *
     * ------------------------------------------------------------------ */

    /// @dev Execution succeeds if and only if approvals reached the threshold.
    function testFuzz_ExecutionRequiresExactlyThreshold(
        uint8 rawGuardians,
        uint8 rawThreshold,
        uint8 rawApprovals
    ) public {
        uint256 guardians = bound(rawGuardians, 1, 12);
        uint256 threshold = bound(rawThreshold, 1, guardians);
        uint256 approvals = bound(rawApprovals, 0, guardians);

        _configure(guardians, threshold);
        uint256 id = _initiateAndApprove(newOwner, approvals);
        vm.warp(dsr.etaOf(id));

        if (approvals >= threshold) {
            dsr.executeRecovery(id);
            assertEq(dsr.owner(), newOwner);
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(
                    DynamicSocialRecovery.ThresholdNotMet.selector, uint32(approvals), threshold
                )
            );
            dsr.executeRecovery(id);
            assertEq(dsr.owner(), owner);
        }
    }

    /// @dev `proofCount` can never exceed the guardian set size, however many are sent.
    function testFuzz_ProofCountNeverExceedsGuardianCount(uint8 rawGuardians, uint8 rawApprovals)
        public
    {
        uint256 guardians = bound(rawGuardians, 1, 12);
        uint256 approvals = bound(rawApprovals, 0, guardians);

        _configure(guardians, 1);
        uint256 id = _initiateAndApprove(newOwner, approvals);

        assertLe(dsr.getRequest(id).proofCount, dsr.guardianCount());
    }

    /// @dev Threshold must land inside [1, guardianCount]; everything else is rejected.
    function testFuzz_SetGuardianPayloadRejectsOutOfRangeThreshold(
        uint8 rawGuardians,
        uint256 threshold
    ) public {
        uint256 guardians = bound(rawGuardians, 1, 20);
        vm.assume(threshold == 0 || threshold > guardians);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                DynamicSocialRecovery.InvalidThreshold.selector, threshold, guardians
            )
        );
        dsr.setGuardianPayload(PAYLOAD, _salts(guardians), threshold);
    }

    /* ------------------------------------------------------------------ *
     *                    UNBOUNDED — the owner's veto                     *
     * ------------------------------------------------------------------ */

    /// @dev Property 2: the veto holds at every point in the lifecycle — before, during
    ///      and long after the delay, at any approval count short of execution.
    function testFuzz_OwnerCanAlwaysCancelPendingRequest(uint256 elapsed, uint8 rawApprovals)
        public
    {
        elapsed = bound(elapsed, 0, 3650 days);
        uint256 approvals = bound(rawApprovals, 0, 5);

        _configure(5, 3);
        uint256 id = _initiateAndApprove(newOwner, approvals);

        vm.warp(block.timestamp + elapsed);
        assertTrue(dsr.isPending(id));

        vm.prank(owner);
        dsr.cancelRecovery(id);

        assertTrue(dsr.getRequest(id).cancelled);
        assertEq(dsr.owner(), owner, "cancellation must never move ownership");
    }

    /// @dev Nobody but the owner holds the veto.
    function testFuzz_OnlyOwnerCanCancel(address caller) public {
        vm.assume(caller != owner);

        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        vm.prank(caller);
        vm.expectRevert(DynamicSocialRecovery.NotOwner.selector);
        dsr.cancelRecovery(id);

        assertTrue(dsr.isPending(id));
    }

    /* ------------------------------------------------------------------ *
     *                 UNBOUNDED — proof rejection paths                   *
     * ------------------------------------------------------------------ */

    /// @dev Property 3a: a spent nullifier is never accepted again, by anyone, for anything.
    function testFuzz_NullifierIsNeverReusable(bytes32 nullifier) public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        EmailProof memory first = _proof(id, newOwner, 0, nullifier);
        dsr.submitEmailProof(id, first);

        // A different guardian, same email. Must not count.
        EmailProof memory replay = _proof(id, newOwner, 1, nullifier);

        vm.expectRevert(
            abi.encodeWithSelector(DynamicSocialRecovery.NullifierAlreadyUsed.selector, nullifier)
        );
        dsr.submitEmailProof(id, replay);

        assertEq(dsr.getRequest(id).proofCount, 1);
    }

    /// @dev Property 3b: an unrecognised guardian commitment is always rejected.
    function testFuzz_NonGuardianIsAlwaysRejected(bytes32 salt) public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);
        vm.assume(!dsr.isGuardian(salt));

        EmailProof memory p = _proof(id, newOwner, 0, _nullifier(id, 0));
        p.accountSalt = salt;

        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.NotAGuardian.selector, salt));
        dsr.submitEmailProof(id, p);

        assertEq(dsr.getRequest(id).proofCount, 0);
    }

    /// @dev Property 3c: any command string other than the canonical one is rejected —
    ///      the binding that stops a valid proof being redirected to another request.
    function testFuzz_MismatchedCommandIsAlwaysRejected(string calldata command) public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        string memory canonical = dsr.canonicalCommand(id, newOwner);
        vm.assume(keccak256(bytes(command)) != keccak256(bytes(canonical)));

        EmailProof memory p = _proof(id, newOwner, 0, _nullifier(id, 0));
        p.maskedCommand = command;

        vm.expectRevert(
            abi.encodeWithSelector(DynamicSocialRecovery.CommandMismatch.selector, canonical, command)
        );
        dsr.submitEmailProof(id, p);

        assertEq(dsr.getRequest(id).proofCount, 0);
    }

    /// @dev Property 3d: an unsound proof is rejected regardless of how well-formed the
    ///      surrounding public inputs are.
    function testFuzz_UnsoundProofIsAlwaysRejected(bytes calldata rawProof, bytes32 nullifier)
        public
    {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);
        verifier.setShouldVerify(false);

        EmailProof memory p = _proof(id, newOwner, 0, nullifier);
        p.proof = rawProof;

        vm.expectRevert(DynamicSocialRecovery.InvalidProof.selector);
        dsr.submitEmailProof(id, p);
    }

    /// @dev An email predating the request it approves is rejected: approvals cannot be
    ///      pre-signed before there is anything to approve.
    function testFuzz_StaleEmailIsAlwaysRejected(uint256 emailTimestamp) public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);
        uint64 requestTs = dsr.getRequest(id).timestamp;
        emailTimestamp = bound(emailTimestamp, 1, requestTs - 1);

        EmailProof memory p = _proof(id, newOwner, 0, _nullifier(id, 0));
        p.timestamp = emailTimestamp;

        vm.expectRevert(
            abi.encodeWithSelector(
                DynamicSocialRecovery.StaleEmail.selector, emailTimestamp, requestTs
            )
        );
        dsr.submitEmailProof(id, p);
    }

    /* ------------------------------------------------------------------ *
     *                   UNBOUNDED — command encoding                      *
     * ------------------------------------------------------------------ */

    /// @dev The command must be injective over (requestId, newOwner). If two distinct
    ///      pairs could ever produce the same string, one guardian approval would
    ///      silently authorise a different recovery.
    function testFuzz_CanonicalCommandIsInjective(
        uint256 idA,
        uint256 idB,
        address ownerA,
        address ownerB
    ) public view {
        vm.assume(idA != idB || ownerA != ownerB);

        assertTrue(
            keccak256(bytes(dsr.canonicalCommand(idA, ownerA)))
                != keccak256(bytes(dsr.canonicalCommand(idB, ownerB))),
            "distinct (requestId, newOwner) produced an identical command"
        );
    }

    /* ------------------------------------------------------------------ *
     *                  UNBOUNDED — access control surface                 *
     * ------------------------------------------------------------------ */

    function testFuzz_OnlyOwnerCanSetGuardianPayload(address caller) public {
        vm.assume(caller != owner);

        vm.prank(caller);
        vm.expectRevert(DynamicSocialRecovery.NotOwner.selector);
        dsr.setGuardianPayload(PAYLOAD, _salts(3), 2);
    }

    /// @dev Initiation is deliberately open, for any plausible proposed owner.
    function testFuzz_AnyoneCanInitiateForAnyNewOwner(address caller, address proposed) public {
        vm.assume(proposed != address(0) && proposed != owner);

        _configure(3, 2);
        vm.prank(caller);
        uint256 id = dsr.initiateRecovery(proposed);

        assertEq(dsr.getRequest(id).newOwner, proposed);
    }

    /// @dev Execution is open too — the conditions are entirely on-chain.
    function testFuzz_AnyoneCanExecuteOnceConditionsHold(address caller) public {
        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 2);
        vm.warp(dsr.etaOf(id));

        vm.prank(caller);
        dsr.executeRecovery(id);

        assertEq(dsr.owner(), newOwner);
    }
}
