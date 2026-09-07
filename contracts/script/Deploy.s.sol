// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {DynamicSocialRecovery} from "../src/DynamicSocialRecovery.sol";
import {IZKEmailVerifier} from "../src/interfaces/IZKEmailVerifier.sol";
import {IDKIMRegistry} from "@zk-email/contracts/interfaces/IDKIMRegistry.sol";

/// @notice Deploys {DynamicSocialRecovery} against an existing ZK Email verifier and
///         DKIM registry.
///
/// @dev The verifier is generated per-blueprint by the ZK Email Registry and the DKIM
///      registry is a shared deployment, so both are supplied by address rather than
///      deployed here — this script must never silently stand up a fake verifier on a
///      live network.
///
///      Usage:
///        forge script script/Deploy.s.sol:Deploy \
///          --rpc-url base_sepolia --broadcast --verify
///
///      Required env: DSRP_OWNER, DSRP_VERIFIER, DSRP_DKIM_REGISTRY, PRIVATE_KEY
contract Deploy is Script {
    function run() external returns (DynamicSocialRecovery dsr) {
        address owner = vm.envAddress("DSRP_OWNER");
        address verifier = vm.envAddress("DSRP_VERIFIER");
        address dkimRegistry = vm.envAddress("DSRP_DKIM_REGISTRY");

        require(verifier.code.length > 0, "DSRP_VERIFIER has no code");
        require(dkimRegistry.code.length > 0, "DSRP_DKIM_REGISTRY has no code");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        dsr = new DynamicSocialRecovery(
            owner, IZKEmailVerifier(verifier), IDKIMRegistry(dkimRegistry)
        );
        vm.stopBroadcast();

        console.log("DynamicSocialRecovery:", address(dsr));
        console.log("owner:                ", owner);
        console.log("verifier:             ", verifier);
        console.log("dkimRegistry:         ", dkimRegistry);
        console.log("delay (seconds):      ", dsr.DELAY());
        console.log("chainId:              ", block.chainid);
    }
}
