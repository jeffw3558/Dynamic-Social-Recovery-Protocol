// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./BaseTest.sol";
import {DynamicSocialRecovery} from "../src/DynamicSocialRecovery.sol";
import {EmailProof, IZKEmailVerifier} from "../src/interfaces/IZKEmailVerifier.sol";
import {IDKIMRegistry} from "@zk-email/contracts/interfaces/IDKIMRegistry.sol";
import {MockZKEmailVerifier} from "./mocks/MockZKEmailVerifier.sol";
import {MockDKIMRegistry} from "./mocks/MockDKIMRegistry.sol";

contract DynamicSocialRecoveryTest is BaseTest {
    /* ------------------------------------------------------------------ *
     *                            CONSTRUCTOR                              *
     * ------------------------------------------------------------------ */

    function test_Constructor_SetsInitialState() public view {
        assertEq(dsr.owner(), owner);
        assertEq(address(dsr.VERIFIER()), address(verifier));
        assertEq(address(dsr.DKIM_REGISTRY()), address(dkim));
        assertEq(dsr.DELAY(), 48 hours);
        assertEq(dsr.delay(), 48 hours);
        assertEq(dsr.nextRequestId(), 1);
        assertEq(dsr.activeRequestId(), 0);
        assertEq(dsr.threshold(), 0);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert(DynamicSocialRecovery.ZeroAddress.selector);
        new DynamicSocialRecovery(address(0), verifier, dkim);
    }

    function test_Constructor_RevertsOnZeroVerifier() public {
        vm.expectRevert(DynamicSocialRecovery.ZeroAddress.selector);
        new DynamicSocialRecovery(owner, IZKEmailVerifier(address(0)), dkim);
    }

    function test_Constructor_RevertsOnZeroRegistry() public {
        vm.expectRevert(DynamicSocialRecovery.ZeroAddress.selector);
        new DynamicSocialRecovery(owner, verifier, IDKIMRegistry(address(0)));
    }

    /* ------------------------------------------------------------------ *
     *                        setGuardianPayload                           *
     * ------------------------------------------------------------------ */

    function test_SetGuardianPayload_StoresPayloadAndGuardians() public {
        _configure(3, 2);

        assertEq(dsr.guardianPayload(), PAYLOAD);
        assertEq(dsr.guardianPayloadHash(), keccak256(PAYLOAD));
        assertEq(dsr.payloadVersion(), 1);
        assertEq(dsr.threshold(), 2);
        assertEq(dsr.guardianCount(), 3);

        for (uint256 i; i < 3; ++i) {
            assertTrue(dsr.isGuardian(_salt(i)));
            assertEq(dsr.guardianSaltAt(i), _salt(i));
        }
        assertFalse(dsr.isGuardian(_salt(3)));
    }

    function test_SetGuardianPayload_EmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(dsr));
        emit DynamicSocialRecovery.GuardianPayloadUpdated(1, keccak256(PAYLOAD), 3, 2);
        _configure(3, 2);
    }

    /// @dev Re-configuring must fully retire the old set, not union with it.
    function test_SetGuardianPayload_ClearsPreviousGuardians() public {
        _configure(5, 3);
        assertEq(dsr.guardianCount(), 5);

        bytes32[] memory replacement = new bytes32[](2);
        replacement[0] = keccak256("fresh-a");
        replacement[1] = keccak256("fresh-b");

        vm.prank(owner);
        dsr.setGuardianPayload(hex"abcd", replacement, 1);

        assertEq(dsr.guardianCount(), 2);
        assertEq(dsr.payloadVersion(), 2);
        for (uint256 i; i < 5; ++i) {
            assertFalse(dsr.isGuardian(_salt(i)), "stale guardian survived re-configure");
        }
        assertTrue(dsr.isGuardian(replacement[0]));
        assertTrue(dsr.isGuardian(replacement[1]));
    }

    function test_SetGuardianPayload_RevertsIfNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(DynamicSocialRecovery.NotOwner.selector);
        dsr.setGuardianPayload(PAYLOAD, _salts(3), 2);
    }

    function test_SetGuardianPayload_RevertsOnEmptyPayload() public {
        vm.prank(owner);
        vm.expectRevert(DynamicSocialRecovery.EmptyPayload.selector);
        dsr.setGuardianPayload("", _salts(3), 2);
    }

    function test_SetGuardianPayload_RevertsOnTooManyGuardians() public {
        uint256 max = dsr.MAX_GUARDIANS();
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(DynamicSocialRecovery.TooManyGuardians.selector, max + 1, max)
        );
        dsr.setGuardianPayload(PAYLOAD, _salts(max + 1), 1);
    }

    function test_SetGuardianPayload_RevertsOnZeroThreshold() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.InvalidThreshold.selector, 0, 3));
        dsr.setGuardianPayload(PAYLOAD, _salts(3), 0);
    }

    function test_SetGuardianPayload_RevertsOnThresholdAboveGuardianCount() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.InvalidThreshold.selector, 4, 3));
        dsr.setGuardianPayload(PAYLOAD, _salts(3), 4);
    }

    function test_SetGuardianPayload_RevertsOnZeroSalt() public {
        bytes32[] memory salts = new bytes32[](2);
        salts[0] = _salt(0);
        salts[1] = bytes32(0);

        vm.prank(owner);
        vm.expectRevert(DynamicSocialRecovery.ZeroSalt.selector);
        dsr.setGuardianPayload(PAYLOAD, salts, 1);
    }

    /// @dev Duplicates would inflate the effective threshold denominator.
    function test_SetGuardianPayload_RevertsOnDuplicateGuardian() public {
        bytes32[] memory salts = new bytes32[](2);
        salts[0] = _salt(0);
        salts[1] = _salt(0);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(DynamicSocialRecovery.DuplicateGuardian.selector, _salt(0))
        );
        dsr.setGuardianPayload(PAYLOAD, salts, 1);
    }

    /// @dev Mutating the set mid-recovery would silently re-scope approvals already given.
    function test_SetGuardianPayload_RevertsWhileRecoveryInFlight() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.RecoveryInFlight.selector, id));
        dsr.setGuardianPayload(PAYLOAD, _salts(4), 2);
    }

    function test_SetGuardianPayload_SucceedsAfterCancellingInFlightRecovery() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        vm.startPrank(owner);
        dsr.cancelRecovery(id);
        dsr.setGuardianPayload(PAYLOAD, _salts(4), 3);
        vm.stopPrank();

        assertEq(dsr.guardianCount(), 4);
        assertEq(dsr.threshold(), 3);
    }

    /* ------------------------------------------------------------------ *
     *                          initiateRecovery                           *
     * ------------------------------------------------------------------ */

    function test_InitiateRecovery_CreatesRequest() public {
        _configure(3, 2);

        uint256 id = dsr.initiateRecovery(newOwner);
        assertEq(id, 1);
        assertEq(dsr.activeRequestId(), 1);
        assertEq(dsr.nextRequestId(), 2);

        DynamicSocialRecovery.RecoveryRequest memory req = dsr.getRequest(id);
        assertEq(req.newOwner, newOwner);
        assertEq(req.timestamp, uint64(block.timestamp));
        assertEq(req.proofCount, 0);
        assertFalse(req.executed);
        assertFalse(req.cancelled);

        assertEq(dsr.etaOf(id), block.timestamp + DELAY);
        assertFalse(dsr.isMature(id));
        assertTrue(dsr.isPending(id));
    }

    /// @dev Someone who lost their key initiates from a fresh address, so this must be open.
    function test_InitiateRecovery_IsPermissionless() public {
        _configure(3, 2);
        vm.prank(stranger);
        uint256 id = dsr.initiateRecovery(newOwner);
        assertEq(id, 1);
    }

    function test_InitiateRecovery_RevertsOnZeroAddress() public {
        _configure(3, 2);
        vm.expectRevert(DynamicSocialRecovery.ZeroAddress.selector);
        dsr.initiateRecovery(address(0));
    }

    function test_InitiateRecovery_RevertsOnSameOwner() public {
        _configure(3, 2);
        vm.expectRevert(DynamicSocialRecovery.SameOwner.selector);
        dsr.initiateRecovery(owner);
    }

    function test_InitiateRecovery_RevertsIfGuardiansNotConfigured() public {
        vm.expectRevert(DynamicSocialRecovery.GuardiansNotConfigured.selector);
        dsr.initiateRecovery(newOwner);
    }

    function test_InitiateRecovery_RevertsIfAlreadyInFlight() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.RecoveryInFlight.selector, id));
        dsr.initiateRecovery(stranger);
    }

    /* ------------------------------------------------------------------ *
     *                    submitEmailProof — the 7 bindings                *
     * ------------------------------------------------------------------ */

    function test_SubmitEmailProof_CountsApproval() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        _approve(id, newOwner, 0);

        assertEq(dsr.getRequest(id).proofCount, 1);
        assertTrue(dsr.hasApproved(id, _salt(0)));
        assertTrue(dsr.usedNullifiers(_nullifier(id, 0)));
    }

    function test_SubmitEmailProof_EmitsEvent() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        vm.expectEmit(true, true, false, true, address(dsr));
        emit DynamicSocialRecovery.EmailProofSubmitted(id, _salt(0), _nullifier(id, 0), 1);
        _approve(id, newOwner, 0);
    }

    // 1. proof soundness
    function test_SubmitEmailProof_RevertsOnInvalidProof() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);
        verifier.setShouldVerify(false);

        // Build the proof first: `_proof` calls into `dsr`, and `expectRevert` binds to
        // the very next call.
        EmailProof memory p = _proof(id, newOwner, 0, _nullifier(id, 0));

        vm.expectRevert(DynamicSocialRecovery.InvalidProof.selector);
        dsr.submitEmailProof(id, p);
    }

    // 2. DKIM key trust
    function test_SubmitEmailProof_RevertsOnUntrustedDKIMKey() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);
        dkim.setAcceptAll(false);

        EmailProof memory p = _proof(id, newOwner, 0, _nullifier(id, 0));

        vm.expectRevert(
            abi.encodeWithSelector(
                DynamicSocialRecovery.UntrustedDKIMKey.selector, DOMAIN, PUBKEY_HASH
            )
        );
        dsr.submitEmailProof(id, p);
    }

    function test_SubmitEmailProof_SucceedsWhenKeyExplicitlyTrusted() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);
        dkim.setAcceptAll(false);
        dkim.setValid(DOMAIN, PUBKEY_HASH, true);

        _approve(id, newOwner, 0);
        assertEq(dsr.getRequest(id).proofCount, 1);
    }

    // 3. command binding — the check that stops cross-request replay
    function test_SubmitEmailProof_RevertsWhenCommandBoundToAnotherRequest() public {
        _configure(3, 2);
        uint256 first = dsr.initiateRecovery(newOwner);

        // Retire request #1 and open #2 for the same proposed owner.
        vm.prank(owner);
        dsr.cancelRecovery(first);
        uint256 second = dsr.initiateRecovery(newOwner);

        // A guardian proof minted for #1 must not count toward #2.
        EmailProof memory stale = _proof(first, newOwner, 0, _nullifier(first, 0));

        vm.expectRevert(
            abi.encodeWithSelector(
                DynamicSocialRecovery.CommandMismatch.selector,
                dsr.canonicalCommand(second, newOwner),
                stale.maskedCommand
            )
        );
        dsr.submitEmailProof(second, stale);
    }

    function test_SubmitEmailProof_RevertsWhenCommandBoundToAnotherOwner() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        EmailProof memory p = _proof(id, stranger, 0, _nullifier(id, 0));

        vm.expectRevert(
            abi.encodeWithSelector(
                DynamicSocialRecovery.CommandMismatch.selector,
                dsr.canonicalCommand(id, newOwner),
                p.maskedCommand
            )
        );
        dsr.submitEmailProof(id, p);
    }

    /// @dev The same bytecode deployed twice must not share approvals.
    function test_SubmitEmailProof_RevertsWhenCommandBoundToAnotherDeployment() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        DynamicSocialRecovery other = new DynamicSocialRecovery(owner, verifier, dkim);
        vm.prank(owner);
        other.setGuardianPayload(PAYLOAD, _salts(3), 2);
        uint256 otherId = other.initiateRecovery(newOwner);
        assertEq(otherId, id, "ids should collide across deployments");

        EmailProof memory foreign = _proof(id, newOwner, 0, _nullifier(id, 0));
        foreign.maskedCommand = other.canonicalCommand(otherId, newOwner);

        vm.expectRevert(
            abi.encodeWithSelector(
                DynamicSocialRecovery.CommandMismatch.selector,
                dsr.canonicalCommand(id, newOwner),
                foreign.maskedCommand
            )
        );
        dsr.submitEmailProof(id, foreign);
    }

    // 4. replay protection
    function test_SubmitEmailProof_RevertsOnReplayedNullifier() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);
        _approve(id, newOwner, 0);

        // A different guardian, but reusing a spent email.
        EmailProof memory p = _proof(id, newOwner, 1, _nullifier(id, 0));

        vm.expectRevert(
            abi.encodeWithSelector(
                DynamicSocialRecovery.NullifierAlreadyUsed.selector, _nullifier(id, 0)
            )
        );
        dsr.submitEmailProof(id, p);
    }

    // 5. guardian membership
    function test_SubmitEmailProof_RevertsOnNonGuardian() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        EmailProof memory p = _proof(id, newOwner, 99, _nullifier(id, 99));

        vm.expectRevert(
            abi.encodeWithSelector(DynamicSocialRecovery.NotAGuardian.selector, _salt(99))
        );
        dsr.submitEmailProof(id, p);
    }

    // 6. one approval per guardian per request
    function test_SubmitEmailProof_RevertsOnDoubleApprovalBySameGuardian() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);
        _approve(id, newOwner, 0);

        // Same guardian, fresh email.
        EmailProof memory p = _proof(id, newOwner, 0, keccak256("second-email"));

        vm.expectRevert(
            abi.encodeWithSelector(DynamicSocialRecovery.AlreadyApproved.selector, id, _salt(0))
        );
        dsr.submitEmailProof(id, p);
    }

    // 7. freshness
    function test_SubmitEmailProof_RevertsOnEmailOlderThanRequest() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);
        uint64 requestTs = dsr.getRequest(id).timestamp;

        EmailProof memory p = _proof(id, newOwner, 0, _nullifier(id, 0));
        p.timestamp = requestTs - 1;

        vm.expectRevert(
            abi.encodeWithSelector(DynamicSocialRecovery.StaleEmail.selector, requestTs - 1, requestTs)
        );
        dsr.submitEmailProof(id, p);
    }

    /// @dev Blueprints that expose no timestamp report 0; that must not be read as stale.
    function test_SubmitEmailProof_AcceptsUnknownTimestamp() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        EmailProof memory p = _proof(id, newOwner, 0, _nullifier(id, 0));
        p.timestamp = 0;

        dsr.submitEmailProof(id, p);
        assertEq(dsr.getRequest(id).proofCount, 1);
    }

    function test_SubmitEmailProof_RevertsOnUnknownRequest() public {
        _configure(3, 2);
        EmailProof memory p = _proof(42, newOwner, 0, _nullifier(42, 0));

        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.NoSuchRequest.selector, 42));
        dsr.submitEmailProof(42, p);
    }

    function test_SubmitEmailProof_RevertsAfterCancellation() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);
        vm.prank(owner);
        dsr.cancelRecovery(id);

        EmailProof memory p = _proof(id, newOwner, 0, _nullifier(id, 0));

        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.RequestNotPending.selector, id));
        dsr.submitEmailProof(id, p);
    }

    function test_SubmitEmailProof_RevertsAfterExecution() public {
        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 2);
        vm.warp(block.timestamp + DELAY);
        dsr.executeRecovery(id);

        EmailProof memory p = _proof(id, newOwner, 2, _nullifier(id, 2));

        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.RequestNotPending.selector, id));
        dsr.submitEmailProof(id, p);
    }

    /* ------------------------------------------------------------------ *
     *                          executeRecovery                            *
     * ------------------------------------------------------------------ */

    function test_ExecuteRecovery_TransfersOwnership() public {
        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 2);
        vm.warp(block.timestamp + DELAY);

        vm.expectEmit(true, true, true, false, address(dsr));
        emit DynamicSocialRecovery.RecoveryExecuted(id, owner, newOwner);
        dsr.executeRecovery(id);

        assertEq(dsr.owner(), newOwner);
        assertTrue(dsr.getRequest(id).executed);
        assertEq(dsr.activeRequestId(), 0);
        assertFalse(dsr.isPending(id));
    }

    function test_ExecuteRecovery_IsPermissionless() public {
        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 2);
        vm.warp(block.timestamp + DELAY);

        vm.prank(stranger);
        dsr.executeRecovery(id);
        assertEq(dsr.owner(), newOwner);
    }

    function test_ExecuteRecovery_RevertsBeforeTimelockElapsed() public {
        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 2);
        uint256 eta = dsr.etaOf(id);

        vm.expectRevert(
            abi.encodeWithSelector(
                DynamicSocialRecovery.TimelockNotElapsed.selector, block.timestamp, eta
            )
        );
        dsr.executeRecovery(id);
    }

    /// @dev Boundary: one second short must fail.
    function test_ExecuteRecovery_RevertsOneSecondBeforeEta() public {
        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 2);
        uint256 eta = dsr.etaOf(id);
        vm.warp(eta - 1);

        vm.expectRevert(
            abi.encodeWithSelector(DynamicSocialRecovery.TimelockNotElapsed.selector, eta - 1, eta)
        );
        dsr.executeRecovery(id);
    }

    /// @dev Boundary: exactly at the ETA must succeed.
    function test_ExecuteRecovery_SucceedsExactlyAtEta() public {
        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 2);
        vm.warp(dsr.etaOf(id));

        assertTrue(dsr.isMature(id));
        dsr.executeRecovery(id);
        assertEq(dsr.owner(), newOwner);
    }

    function test_ExecuteRecovery_RevertsBelowThreshold() public {
        _configure(3, 3);
        uint256 id = _initiateAndApprove(newOwner, 2);
        vm.warp(block.timestamp + DELAY);

        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.ThresholdNotMet.selector, 2, 3));
        dsr.executeRecovery(id);
    }

    function test_ExecuteRecovery_RevertsIfCancelled() public {
        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 2);
        vm.prank(owner);
        dsr.cancelRecovery(id);
        vm.warp(block.timestamp + DELAY);

        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.RequestNotPending.selector, id));
        dsr.executeRecovery(id);
    }

    function test_ExecuteRecovery_RevertsIfAlreadyExecuted() public {
        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 2);
        vm.warp(block.timestamp + DELAY);
        dsr.executeRecovery(id);

        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.RequestNotPending.selector, id));
        dsr.executeRecovery(id);
    }

    /* ------------------------------------------------------------------ *
     *                           cancelRecovery                            *
     * ------------------------------------------------------------------ */

    function test_CancelRecovery_MarksCancelled() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        vm.expectEmit(true, true, false, false, address(dsr));
        emit DynamicSocialRecovery.RecoveryCancelled(id, owner);
        vm.prank(owner);
        dsr.cancelRecovery(id);

        assertTrue(dsr.getRequest(id).cancelled);
        assertEq(dsr.activeRequestId(), 0);
        assertFalse(dsr.isPending(id));
        assertEq(dsr.owner(), owner);
    }

    function test_CancelRecovery_RevertsIfNotOwner() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        vm.prank(stranger);
        vm.expectRevert(DynamicSocialRecovery.NotOwner.selector);
        dsr.cancelRecovery(id);
    }

    /// @dev The veto is unconditional: mature *and* fully approved is still cancellable.
    function test_CancelRecovery_SucceedsWhenMatureAndAtThreshold() public {
        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 3);
        vm.warp(dsr.etaOf(id) + 30 days);

        assertTrue(dsr.isMature(id));
        vm.prank(owner);
        dsr.cancelRecovery(id);

        assertTrue(dsr.getRequest(id).cancelled);
        assertEq(dsr.owner(), owner, "ownership must not have moved");
    }

    function test_CancelRecovery_RevertsIfAlreadyExecuted() public {
        _configure(3, 2);
        uint256 id = _initiateAndApprove(newOwner, 2);
        vm.warp(block.timestamp + DELAY);
        dsr.executeRecovery(id);

        // Ownership moved, so the veto now belongs to the new owner — and is too late.
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.RequestNotPending.selector, id));
        dsr.cancelRecovery(id);
    }

    function test_CancelRecovery_AllowsAFreshRequestAfterwards() public {
        _configure(3, 2);
        uint256 first = dsr.initiateRecovery(newOwner);
        vm.prank(owner);
        dsr.cancelRecovery(first);

        uint256 second = dsr.initiateRecovery(newOwner);
        assertEq(second, 2);
        assertEq(dsr.activeRequestId(), 2);
    }

    /* ------------------------------------------------------------------ *
     *                               VIEWS                                 *
     * ------------------------------------------------------------------ */

    function test_EtaOf_RevertsOnUnknownRequest() public {
        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.NoSuchRequest.selector, 7));
        dsr.etaOf(7);
    }

    function test_GetRequest_RevertsOnUnknownRequest() public {
        vm.expectRevert(abi.encodeWithSelector(DynamicSocialRecovery.NoSuchRequest.selector, 7));
        dsr.getRequest(7);
    }

    function test_IsPending_FalseForUnknownRequest() public view {
        assertFalse(dsr.isPending(7));
    }

    function test_GuardianSalts_ReturnsFullSet() public {
        _configure(4, 2);
        bytes32[] memory salts = dsr.guardianSalts();
        assertEq(salts.length, 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(salts[i], _salt(i));
        }
    }

    /// @dev Guards against drift between the on-chain command and the SDK's mirror of it.
    ///      Built here from primitives rather than by calling the contract, so a change to
    ///      the format fails this test rather than silently invalidating every proof.
    function test_CanonicalCommand_MatchesIndependentlyBuiltString() public {
        _configure(3, 2);
        uint256 id = dsr.initiateRecovery(newOwner);

        string memory expected = string.concat(
            "Approve recovery of wallet ",
            _lower(vm.toString(address(dsr))),
            " on chain ",
            vm.toString(block.chainid),
            " request ",
            vm.toString(id),
            " to new owner ",
            _lower(vm.toString(newOwner))
        );

        assertEq(dsr.canonicalCommand(id, newOwner), expected);
    }

    function test_CanonicalCommand_VariesByRequestAndOwner() public view {
        assertTrue(
            keccak256(bytes(dsr.canonicalCommand(1, newOwner)))
                != keccak256(bytes(dsr.canonicalCommand(2, newOwner))),
            "command must vary by requestId"
        );
        assertTrue(
            keccak256(bytes(dsr.canonicalCommand(1, newOwner)))
                != keccak256(bytes(dsr.canonicalCommand(1, stranger))),
            "command must vary by proposed owner"
        );
    }

    /// @dev Ownership has exactly one mover: executeRecovery. Asserting the absence of a
    ///      transferOwnership entry point keeps that from being weakened by accident.
    function test_NoExternalOwnershipTransferEntryPoint() public {
        (bool ok,) = address(dsr).call(
            abi.encodeWithSignature("transferOwnership(address)", stranger)
        );
        assertFalse(ok, "contract must expose no transferOwnership");
        assertEq(dsr.owner(), owner);
    }

    /// @dev The Lit decryption gate (`sdk/src/lit-actions/guardian-gate.js`) calls these
    ///      four functions by raw selector, because the Lit runtime has no ABI encoder.
    ///      Hand-written selectors in JavaScript cannot be type-checked, so they are
    ///      pinned here: renaming or re-signing any of these functions breaks this test
    ///      loudly instead of breaking decryption silently in production.
    function test_GateActionSelectorsAreStable() public view {
        // `threshold` is an auto-generated public getter, so these are taken from an
        // instance rather than the type.
        assertEq(dsr.isPending.selector, bytes4(0xca8836d2), "isPending(uint256)");
        assertEq(dsr.isMature.selector, bytes4(0x3e55e63d), "isMature(uint256)");
        assertEq(dsr.threshold.selector, bytes4(0x42cde4e8), "threshold()");
        assertEq(dsr.getRequest.selector, bytes4(0xc58343ef), "getRequest(uint256)");
    }

    /* ------------------------------------------------------------------ *
     *                          END-TO-END HAPPY PATH                      *
     * ------------------------------------------------------------------ */

    function test_EndToEnd_EnrolApproveWaitExecute() public {
        _configure(5, 3);
        assertEq(dsr.owner(), owner);

        uint256 id = dsr.initiateRecovery(newOwner);
        for (uint256 i; i < 3; ++i) {
            _approve(id, newOwner, i);
        }

        // Short of the delay, nothing moves.
        vm.warp(dsr.etaOf(id) - 1);
        vm.expectRevert();
        dsr.executeRecovery(id);
        assertEq(dsr.owner(), owner);

        vm.warp(dsr.etaOf(id));
        dsr.executeRecovery(id);
        assertEq(dsr.owner(), newOwner);
    }

    /* ------------------------------------------------------------------ *
     *                              INTERNAL                               *
     * ------------------------------------------------------------------ */

    /// @dev `vm.toString(address)` is checksummed; the contract emits lowercase hex.
    function _lower(string memory input) private pure returns (string memory) {
        bytes memory b = bytes(input);
        for (uint256 i; i < b.length; ++i) {
            if (b[i] >= 0x41 && b[i] <= 0x5A) b[i] = bytes1(uint8(b[i]) + 32);
        }
        return string(b);
    }
}
