// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDKIMRegistry} from "@zk-email/contracts/interfaces/IDKIMRegistry.sol";

/// @notice Programmable stand-in for the ZK Email DKIM registry.
/// @dev Defaults to accepting every key so the happy path stays terse; individual
///      (domain, keyHash) pairs can be revoked to exercise the untrusted-key branch.
contract MockDKIMRegistry is IDKIMRegistry {
    bool public acceptAll = true;

    mapping(bytes32 domainKeyPair => bool) private _valid;

    function setAcceptAll(bool value) external {
        acceptAll = value;
    }

    function setValid(string calldata domainName, bytes32 publicKeyHash, bool value) external {
        _valid[keccak256(abi.encode(domainName, publicKeyHash))] = value;
    }

    /// @inheritdoc IDKIMRegistry
    function isDKIMPublicKeyHashValid(string memory domainName, bytes32 publicKeyHash)
        external
        view
        returns (bool)
    {
        if (acceptAll) return true;
        return _valid[keccak256(abi.encode(domainName, publicKeyHash))];
    }
}
