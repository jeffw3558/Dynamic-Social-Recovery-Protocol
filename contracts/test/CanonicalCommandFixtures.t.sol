// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./BaseTest.sol";

/// @notice Emits the canonical-command fixtures that the TypeScript SDK checks its
///         mirror against.
///
/// @dev The command string is defined twice — once in Solidity, once in
///      `sdk/src/command.ts` — because the Lit runtime and the relayer both need it
///      off-chain. Two hand-maintained definitions of a security-critical string is
///      exactly the kind of thing that silently drifts, and drift means every guardian
///      proof stops being accepted.
///
///      So the contract is the source of truth: this test regenerates
///      `test/fixtures/canonical-commands.json` from the deployed bytecode, and
///      `sdk/test/command.test.ts` asserts the TypeScript mirror reproduces every entry.
///      Change the format in Solidity and the SDK test fails until the mirror is updated.
contract CanonicalCommandFixturesTest is BaseTest {
    string constant PATH = "./test/fixtures/canonical-commands.json";

    function test_ExportCanonicalCommandFixtures() public {
        uint256[4] memory requestIds = [uint256(1), 2, 4_294_967_296, type(uint256).max];
        address[4] memory owners = [
            newOwner,
            stranger,
            address(0x1),
            address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF)
        ];

        string memory entries = "";
        for (uint256 i; i < requestIds.length; ++i) {
            string memory command = dsr.canonicalCommand(requestIds[i], owners[i]);

            entries = string.concat(
                entries,
                i == 0 ? "" : ",",
                '{"requestId":"',
                vm.toString(requestIds[i]),
                '","newOwner":"',
                vm.toString(owners[i]),
                '","command":"',
                command,
                '"}'
            );

            // The fixture is only worth trusting if it is self-consistent.
            assertEq(command, dsr.canonicalCommand(requestIds[i], owners[i]));
        }

        vm.writeFile(
            PATH,
            string.concat(
                '{\n  "contractAddress": "',
                vm.toString(address(dsr)),
                '",\n  "chainId": ',
                vm.toString(block.chainid),
                ',\n  "cases": [',
                entries,
                "]\n}\n"
            )
        );
    }
}
