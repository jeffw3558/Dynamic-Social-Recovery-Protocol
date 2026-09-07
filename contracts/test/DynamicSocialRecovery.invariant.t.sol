// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";

import {DynamicSocialRecovery} from "../src/DynamicSocialRecovery.sol";
import {MockZKEmailVerifier} from "./mocks/MockZKEmailVerifier.sol";
import {MockDKIMRegistry} from "./mocks/MockDKIMRegistry.sol";
import {RecoveryHandler} from "./handlers/RecoveryHandler.sol";

/// @notice Stateful invariants — the safety properties that must survive any ordering of
///         any actions, not just the sequences a unit test thought to write down.
contract DynamicSocialRecoveryInvariantTest is Test {
    DynamicSocialRecovery internal dsr;
    MockZKEmailVerifier internal verifier;
    MockDKIMRegistry internal dkim;
    RecoveryHandler internal handler;

    address internal owner = makeAddr("owner");

    uint256 internal constant DELAY = 48 hours;

    function setUp() public {
        vm.warp(1_800_000_000);

        verifier = new MockZKEmailVerifier();
        dkim = new MockDKIMRegistry();
        dsr = new DynamicSocialRecovery(owner, verifier, dkim);
        handler = new RecoveryHandler(dsr, verifier, dkim, owner);

        // Seed a guardian set so `initiate`/`approve`/`execute` are reachable from the
        // first call. Without this the fuzzer burns most of its depth waiting to stumble
        // onto `configure`, and the deep states never get explored.
        bytes32[] memory seedSalts = new bytes32[](5);
        for (uint256 i; i < 5; ++i) {
            seedSalts[i] = keccak256(abi.encodePacked("guardian", i));
        }
        vm.prank(owner);
        dsr.setGuardianPayload(hex"c0ffee", seedSalts, 2);

        // Only the handler drives state; the fuzzer never calls `dsr` directly, so every
        // transition passes through the ghost-state bookkeeping.
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = RecoveryHandler.configure.selector;
        selectors[1] = RecoveryHandler.initiate.selector;
        selectors[2] = RecoveryHandler.approve.selector;
        selectors[3] = RecoveryHandler.execute.selector;
        selectors[4] = RecoveryHandler.cancel.selector;
        selectors[5] = RecoveryHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /* ------------------------------------------------------------------ *
     *  INVARIANT 1 — the timelock is absolute                             *
     * ------------------------------------------------------------------ */

    /// @dev No request ever reached `executed` earlier than 48h after it was opened.
    function invariant_NoRecoveryExecutesBeforeTimelockElapses() public view {
        uint256 n = handler.executedCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.executedIds(i);
            DynamicSocialRecovery.RecoveryRequest memory req = dsr.getRequest(id);

            assertGe(
                handler.executedAt(id),
                uint256(req.timestamp) + DELAY,
                "recovery executed before the 48h delay elapsed"
            );
        }
    }

    /* ------------------------------------------------------------------ *
     *  INVARIANT 2 — the owner's veto always works                        *
     * ------------------------------------------------------------------ */

    /// @dev Whatever the state of an in-flight request — approvals, elapsed time — the
    ///      owner can still cancel it. Probed against a state snapshot so the check
    ///      itself leaves no trace on the run.
    function invariant_OwnerCanAlwaysCancelPendingRecovery() public {
        uint256 id = dsr.activeRequestId();
        if (id == 0) return;
        if (!dsr.isPending(id)) return;

        uint256 snapshot = vm.snapshotState();

        vm.prank(dsr.owner());
        dsr.cancelRecovery(id);

        assertTrue(dsr.getRequest(id).cancelled, "owner failed to cancel a pending recovery");

        vm.revertToState(snapshot);
    }

    /* ------------------------------------------------------------------ *
     *  INVARIANT 3 — proofs are single-use                                *
     * ------------------------------------------------------------------ */

    /// @dev Every accepted proof consumed exactly one fresh nullifier, so the number of
    ///      nullifiers spent equals the total approvals recorded across all requests.
    ///      A replayed proof would inflate one side without the other.
    function invariant_AcceptedProofsMatchConsumedNullifiers() public view {
        uint256 total;
        uint256 n = handler.requestCount();
        for (uint256 i; i < n; ++i) {
            total += dsr.getRequest(handler.requestIds(i)).proofCount;
        }

        assertEq(
            total, handler.nullifiersConsumed(), "approval count diverged from nullifiers spent"
        );
    }

    /* ------------------------------------------------------------------ *
     *  INVARIANT 4 — terminal states are exclusive                        *
     * ------------------------------------------------------------------ */

    function invariant_ExecutedAndCancelledAreMutuallyExclusive() public view {
        uint256 n = handler.requestCount();
        for (uint256 i; i < n; ++i) {
            DynamicSocialRecovery.RecoveryRequest memory req =
                dsr.getRequest(handler.requestIds(i));
            assertFalse(req.executed && req.cancelled, "request is both executed and cancelled");
        }
    }

    /* ------------------------------------------------------------------ *
     *  INVARIANT 5 — ownership moves only through recovery                *
     * ------------------------------------------------------------------ */

    function invariant_OwnerChangesExactlyOncePerExecutedRecovery() public view {
        assertEq(
            handler.ownerChanges(),
            handler.executedCount(),
            "owner changed a different number of times than recoveries executed"
        );
    }

    /* ------------------------------------------------------------------ *
     *  INVARIANT 6 — approvals are bounded by the guardian set            *
     * ------------------------------------------------------------------ */

    /// @dev Compared against the guardian count *at initiation*, since the owner may
    ///      resize the set once a request has left the pending state.
    function invariant_ProofCountNeverExceedsGuardianSet() public view {
        uint256 n = handler.requestCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.requestIds(i);
            assertLe(
                uint256(dsr.getRequest(id).proofCount),
                handler.guardianCountAtInitiation(id),
                "more approvals than there were guardians"
            );
        }
    }

    /* ------------------------------------------------------------------ *
     *  INVARIANT 7 — at most one recovery in flight                       *
     * ------------------------------------------------------------------ */

    function invariant_ActiveRequestIsAlwaysPending() public view {
        uint256 id = dsr.activeRequestId();
        if (id == 0) return;
        assertTrue(dsr.isPending(id), "activeRequestId points at a terminal request");
    }

    /* ------------------------------------------------------------------ *
     *                            NON-VACUITY                              *
     * ------------------------------------------------------------------ */

    /// @notice Runs once after the campaign finishes.
    /// @dev The call distribution is the evidence that the invariants above were checked
    ///      against real state rather than an empty run. This cannot be an `invariant_`
    ///      function: invariants must hold at every step including the first, and "the
    ///      handler has done something" is false before the handler has done anything.
    function afterInvariant() public view {
        console.log("configure  calls/ok: %s / %s", handler.callsConfigure(), handler.okConfigure());
        console.log("initiate   calls/ok: %s / %s", handler.callsInitiate(), handler.okInitiate());
        console.log("approve    calls/ok: %s / %s", handler.callsApprove(), handler.okApprove());
        console.log("execute    calls/ok: %s / %s", handler.callsExecute(), handler.okExecute());
        console.log("cancel     calls/ok: %s / %s", handler.callsCancel(), handler.okCancel());
        console.log("warp       calls:    %s", handler.callsWarp());
        console.log("requests / executed: %s / %s", handler.requestCount(), handler.executedCount());
    }

    /// @notice Deterministic proof that the handler can reach every state the invariants
    ///         are meant to constrain — including a completed ownership transfer.
    /// @dev Guards against the failure mode where a handler silently swallows every call
    ///      and the whole suite passes vacuously. Scripted, so it cannot flake.
    function test_HandlerReachesFullRecoveryLifecycle() public {
        handler.configure(5, 2);
        assertGt(handler.okConfigure(), 0, "handler cannot configure guardians");

        handler.initiate(12_345);
        assertGt(handler.okInitiate(), 0, "handler cannot initiate a recovery");

        handler.approve(0, 100, true);
        handler.approve(1, 101, true);
        assertEq(handler.okApprove(), 2, "handler cannot land guardian approvals");

        // A rejected proof must not count.
        handler.approve(2, 102, false);
        assertEq(handler.okApprove(), 2, "an unsound proof was counted");

        // Cross the 48h delay.
        handler.warp(60 hours);
        handler.warp(60 hours);

        handler.execute();
        assertEq(handler.okExecute(), 1, "handler cannot execute a matured recovery");
        assertEq(handler.executedCount(), 1);
        assertEq(handler.ownerChanges(), 1);
        assertEq(dsr.activeRequestId(), 0);
    }

    /// @notice Deterministic proof that the veto path is reachable too.
    function test_HandlerReachesCancelledState() public {
        handler.configure(5, 2);
        handler.initiate(999);
        handler.approve(0, 200, true);
        handler.cancel();

        assertGt(handler.okCancel(), 0, "handler cannot cancel a recovery");
        assertEq(handler.executedCount(), 0);
        assertEq(dsr.activeRequestId(), 0);
    }
}
