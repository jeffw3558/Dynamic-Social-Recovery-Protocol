// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {DynamicSocialRecovery} from "../../src/DynamicSocialRecovery.sol";
import {EmailProof} from "../../src/interfaces/IZKEmailVerifier.sol";
import {MockZKEmailVerifier} from "../mocks/MockZKEmailVerifier.sol";
import {MockDKIMRegistry} from "../mocks/MockDKIMRegistry.sol";

/// @notice Drives {DynamicSocialRecovery} through random action sequences and records
///         the ghost state the invariants are checked against.
/// @dev Every action is wrapped in try/catch: the suite runs with `fail_on_revert = false`
///      because most random sequences are legitimately invalid, and a revert is a correct
///      outcome rather than a failure. Ghost state is therefore only updated on the
///      success branch, which is what makes the recorded history trustworthy.
contract RecoveryHandler is Test {
    DynamicSocialRecovery public immutable DSR;
    MockZKEmailVerifier public immutable VERIFIER;
    MockDKIMRegistry public immutable DKIM;
    address public immutable OWNER;

    string internal constant DOMAIN = "gmail.com";
    bytes32 internal constant PUBKEY_HASH = keccak256("dkim-public-key");

    /* --------------------------- ghost state --------------------------- */

    /// @notice Ids of every request that reached `executed`, in order.
    uint256[] public executedIds;
    /// @notice Block timestamp at which each request executed.
    mapping(uint256 requestId => uint256) public executedAt;
    /// @notice Guardian-set size at the moment each request was opened.
    mapping(uint256 requestId => uint256) public guardianCountAtInitiation;
    /// @notice Every request id ever opened.
    uint256[] public requestIds;

    /// @notice Nullifiers this handler has seen accepted.
    mapping(bytes32 emailNullifier => bool) public nullifierSeen;
    /// @notice Count of accepted proofs across all requests.
    uint256 public nullifiersConsumed;

    /// @notice Number of times `owner` changed value.
    uint256 public ownerChanges;
    address private _lastKnownOwner;

    /* --------------------------- call counters ------------------------- */

    uint256 public callsConfigure;
    uint256 public callsInitiate;
    uint256 public callsApprove;
    uint256 public callsExecute;
    uint256 public callsCancel;
    uint256 public callsWarp;

    uint256 public okConfigure;
    uint256 public okInitiate;
    uint256 public okApprove;
    uint256 public okExecute;
    uint256 public okCancel;

    constructor(
        DynamicSocialRecovery dsr_,
        MockZKEmailVerifier verifier_,
        MockDKIMRegistry dkim_,
        address owner_
    ) {
        DSR = dsr_;
        VERIFIER = verifier_;
        DKIM = dkim_;
        OWNER = owner_;
        _lastKnownOwner = dsr_.owner();
    }

    /* ------------------------------------------------------------------ *
     *                              ACTIONS                                *
     * ------------------------------------------------------------------ */

    /// @notice Owner (re)publishes the guardian set.
    function configure(uint256 countSeed, uint256 thresholdSeed) external {
        ++callsConfigure;
        uint256 count = bound(countSeed, 1, 6);
        uint256 threshold = bound(thresholdSeed, 1, count);

        vm.prank(OWNER);
        try DSR.setGuardianPayload(hex"c0ffee", _salts(count), threshold) {
            ++okConfigure;
        } catch {}
    }

    /// @notice Anyone opens a recovery request.
    function initiate(uint256 ownerSeed) external {
        ++callsInitiate;
        address proposed = address(uint160(bound(ownerSeed, 1, type(uint160).max)));
        if (proposed == DSR.owner()) return;

        try DSR.initiateRecovery(proposed) returns (uint256 id) {
            ++okInitiate;
            requestIds.push(id);
            guardianCountAtInitiation[id] = DSR.guardianCount();
        } catch {}
    }

    /// @notice A guardian's email approval is relayed in.
    /// @dev `soundProof` lets the fuzzer flip the verifier to rejecting, so the
    ///      invalid-proof branch is reachable rather than dead.
    function approve(uint256 guardianSeed, uint256 nullifierSeed, bool soundProof) external {
        ++callsApprove;
        uint256 id = DSR.activeRequestId();
        if (id == 0) return;

        VERIFIER.setShouldVerify(soundProof);

        // Draw from the *live* guardian set so approvals mostly land and the fuzzer can
        // reach threshold, executed and post-execution states within its depth budget.
        // The range is deliberately one past the end, so the non-guardian rejection
        // branch still gets exercised rather than becoming dead.
        uint256 count = DSR.guardianCount();
        if (count == 0) return;
        uint256 guardianIndex = bound(guardianSeed, 0, count);
        bytes32 nullifier = keccak256(abi.encodePacked("null", nullifierSeed));

        EmailProof memory p = EmailProof({
            domainName: DOMAIN,
            publicKeyHash: PUBKEY_HASH,
            timestamp: block.timestamp,
            maskedCommand: DSR.canonicalCommand(id, DSR.getRequest(id).newOwner),
            emailNullifier: nullifier,
            accountSalt: _salt(guardianIndex),
            isCodeExist: true,
            proof: hex"01"
        });

        try DSR.submitEmailProof(id, p) {
            ++okApprove;
            // Reaching here twice for one nullifier would mean replay protection failed.
            assertFalse(nullifierSeen[nullifier], "INVARIANT: nullifier accepted twice");
            nullifierSeen[nullifier] = true;
            ++nullifiersConsumed;
        } catch {}

        VERIFIER.setShouldVerify(true);
    }

    /// @notice Anyone pushes a matured, fully-approved request through.
    function execute() external {
        ++callsExecute;
        uint256 id = DSR.activeRequestId();
        if (id == 0) return;

        try DSR.executeRecovery(id) {
            ++okExecute;
            executedIds.push(id);
            executedAt[id] = block.timestamp;
            if (DSR.owner() != _lastKnownOwner) {
                ++ownerChanges;
                _lastKnownOwner = DSR.owner();
            }
        } catch {}
    }

    /// @notice The owner exercises the veto.
    function cancel() external {
        ++callsCancel;
        uint256 id = DSR.activeRequestId();
        if (id == 0) return;

        vm.prank(DSR.owner());
        try DSR.cancelRecovery(id) {
            ++okCancel;
        } catch {}
    }

    /// @notice Advance time. Bounded so crossing the 48h delay takes a few calls but is
    ///         reliably reachable within the run depth.
    function warp(uint256 seed) external {
        ++callsWarp;
        vm.warp(block.timestamp + bound(seed, 1 hours, 60 hours));
    }

    /* ------------------------------------------------------------------ *
     *                               VIEWS                                 *
     * ------------------------------------------------------------------ */

    function executedCount() external view returns (uint256) {
        return executedIds.length;
    }

    function requestCount() external view returns (uint256) {
        return requestIds.length;
    }

    function _salt(uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("guardian", index));
    }

    function _salts(uint256 count) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = _salt(i);
        }
    }
}
