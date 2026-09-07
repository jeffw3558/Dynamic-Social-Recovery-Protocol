// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ITimelock
/// @notice The mandatory delay between initiating a recovery and being able to execute it.
/// @dev One stable surface for maturity, so the Lit decryption gate, front-ends and
///      monitoring tools never recompute a deadline from raw struct fields and drift.
///
///      The delay is not a rate limiter. It is the owner's notification-and-veto window:
///      the interval in which a still-solvent owner who sees an unexpected
///      `RecoveryInitiated` event can kill it. Its length is the security parameter that
///      makes guardian collusion survivable.
interface ITimelock {
    /// @notice The mandatory delay, in seconds. Constant at 48 hours.
    function delay() external view returns (uint256);

    /// @notice Earliest timestamp at which `requestId` may execute.
    /// @dev Reverts for a non-existent request.
    function etaOf(uint256 requestId) external view returns (uint256);

    /// @notice Whether `requestId`'s delay has elapsed.
    /// @dev Maturity only. A mature request may still be un-executable because it is
    ///      short of threshold, already executed, or cancelled.
    function isMature(uint256 requestId) external view returns (bool);
}
