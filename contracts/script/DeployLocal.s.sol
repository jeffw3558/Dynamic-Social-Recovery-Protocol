// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {DynamicSocialRecovery} from "../src/DynamicSocialRecovery.sol";
import {MockZKEmailVerifier} from "../test/mocks/MockZKEmailVerifier.sol";
import {MockDKIMRegistry} from "../test/mocks/MockDKIMRegistry.sol";

/// @notice Local-only deployment for driving the web app against anvil.
///
/// @dev Deploys the **mock** verifier, which accepts any proof. That is the entire
///      point: the 48-hour timelock and the full approve → wait → execute lifecycle
///      cannot be exercised end-to-end without `evm_increaseTime`, and real Groth16
///      proving in a UI loop is not viable. Anvil is the only place the whole thing
///      can actually be walked through.
///
///      Never point this at a public network. `Deploy.s.sol` is the real one, and it
///      refuses an address with no code precisely so a mock cannot slip through.
contract DeployLocal is Script {
    function run() external returns (DynamicSocialRecovery dsr) {
        require(block.chainid == 31337, "DeployLocal is anvil-only");

        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(
            0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
        ));
        address owner = vm.addr(pk);

        vm.startBroadcast(pk);
        MockZKEmailVerifier verifier = new MockZKEmailVerifier();
        MockDKIMRegistry dkim = new MockDKIMRegistry();
        dsr = new DynamicSocialRecovery(owner, verifier, dkim);
        vm.stopBroadcast();

        console.log("DSRP_ADDRESS =", address(dsr));
        console.log("owner        =", owner);
        console.log("verifier     =", address(verifier));
        console.log("dkimRegistry =", address(dkim));
    }
}
