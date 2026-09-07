// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IDKIMRegistry} from "@zk-email/contracts/interfaces/IDKIMRegistry.sol";

import {ITimelock} from "./interfaces/ITimelock.sol";
import {IZKEmailVerifier, EmailProof} from "./interfaces/IZKEmailVerifier.sol";

/// @title DynamicSocialRecovery
/// @notice Social recovery with zero off-chain storage. The guardian set lives on-chain
///         as a threshold-encrypted blob; guardians approve by replying to an email, and
///         their approvals arrive as zero-knowledge proofs of the DKIM signature.
///
/// @dev Three properties define this contract, and the test suite exists to defend them:
///
///      1. **The timelock is absolute.** No recovery executes before
///         `initiatedAt + DELAY`, whatever the approval count.
///      2. **The owner's veto is unconditional.** `cancelRecovery` succeeds on any
///         non-terminal request, including one already mature and past threshold.
///         Only execution closes the window.
///      3. **Ownership moves only through recovery.** There is deliberately no external
///         `transferOwnership`. It would be a second path to the one thing this contract
///         exists to protect, and would weaken the invariant to no real benefit — this is
///         a recovery controller, not a general ownable.
///
///      Guardian privacy: on-chain state holds ciphertext plus `accountSalt` commitments.
///      It never holds an email address. The chain learns that *some* mailbox at a
///      DKIM-trusted domain approved a recovery, never which one.
contract DynamicSocialRecovery is ITimelock {
    using Strings for uint256;
    using Strings for address;

    /* ------------------------------------------------------------------ *
     *                              CONSTANTS                              *
     * ------------------------------------------------------------------ */

    /// @notice The mandatory recovery delay. Not configurable, by design.
    uint256 public constant DELAY = 48 hours;

    /// @notice Upper bound on the guardian set.
    /// @dev Bounds the clear-and-rewrite loop in {setGuardianPayload} so re-configuring
    ///      can never become gas-unpayable, and keeps `proofCount` inside `uint32`.
    uint256 public constant MAX_GUARDIANS = 64;

    /* ------------------------------------------------------------------ *
     *                                TYPES                                *
     * ------------------------------------------------------------------ */

    struct RecoveryRequest {
        address newOwner;
        uint64 timestamp;
        uint32 proofCount;
        bool executed;
        bool cancelled;
    }

    /* ------------------------------------------------------------------ *
     *                               STORAGE                               *
     * ------------------------------------------------------------------ */

    /// @notice Current wallet owner. Changes only via {executeRecovery}.
    address public owner;

    /// @notice Verifier for ZK Email proofs.
    IZKEmailVerifier public immutable VERIFIER;

    /// @notice Registry of trusted DKIM public key hashes, keyed by domain.
    IDKIMRegistry public immutable DKIM_REGISTRY;

    /// @notice Threshold-encrypted guardian set. Opaque to this contract.
    /// @dev The contract never interprets these bytes. Confining the ciphertext format
    ///      to the SDK is what lets the encryption backend change without a migration.
    bytes public guardianPayload;

    /// @notice `keccak256(guardianPayload)`, for cheap integrity checks off-chain.
    bytes32 public guardianPayloadHash;

    /// @notice Increments on every {setGuardianPayload}, so clients and the decryption
    ///         gate can pin to a specific guardian-set version.
    uint256 public payloadVersion;

    /// @notice Approvals required to execute a recovery.
    uint256 public threshold;

    /// @notice Guardian membership by `accountSalt` commitment.
    mapping(bytes32 accountSalt => bool) public isGuardian;

    /// @dev Enumerable mirror of {isGuardian}, so the set can be cleared on re-configure.
    bytes32[] private _guardianSalts;

    /// @notice Recovery requests by id. Ids start at 1; 0 is the "none" sentinel.
    mapping(uint256 requestId => RecoveryRequest) private _requests;

    /// @notice Id of the in-flight request, or 0 if none.
    uint256 public activeRequestId;

    /// @notice Id assigned to the next request.
    uint256 public nextRequestId = 1;

    /// @notice Globally spent email nullifiers. The basis of replay protection.
    mapping(bytes32 emailNullifier => bool) public usedNullifiers;

    /// @notice Per-request, per-guardian approval record.
    mapping(uint256 requestId => mapping(bytes32 accountSalt => bool)) public hasApproved;

    /* ------------------------------------------------------------------ *
     *                                EVENTS                               *
     * ------------------------------------------------------------------ */

    event GuardianPayloadUpdated(
        uint256 indexed version, bytes32 payloadHash, uint256 guardianCount, uint256 threshold
    );
    /// @dev `command` is emitted verbatim so a guardian's client knows exactly what the
    ///      email must say. It is the same string {canonicalCommand} produces.
    event RecoveryInitiated(
        uint256 indexed requestId,
        address indexed newOwner,
        uint64 timestamp,
        uint256 eta,
        string command
    );
    event EmailProofSubmitted(
        uint256 indexed requestId,
        bytes32 indexed accountSalt,
        bytes32 emailNullifier,
        uint32 proofCount
    );
    event RecoveryExecuted(
        uint256 indexed requestId, address indexed previousOwner, address indexed newOwner
    );
    event RecoveryCancelled(uint256 indexed requestId, address indexed by);

    /* ------------------------------------------------------------------ *
     *                                ERRORS                               *
     * ------------------------------------------------------------------ */

    error NotOwner();
    error ZeroAddress();
    error GuardiansNotConfigured();
    error RecoveryInFlight(uint256 requestId);
    error NoSuchRequest(uint256 requestId);
    error RequestNotPending(uint256 requestId);
    error TimelockNotElapsed(uint256 nowTs, uint256 eta);
    error ThresholdNotMet(uint32 have, uint256 want);
    error SameOwner();

    error TooManyGuardians(uint256 given, uint256 max);
    error InvalidThreshold(uint256 given, uint256 guardianCount);
    error EmptyPayload();
    error ZeroSalt();
    error DuplicateGuardian(bytes32 accountSalt);

    error InvalidProof();
    error UntrustedDKIMKey(string domainName, bytes32 publicKeyHash);
    error CommandMismatch(string expected, string actual);
    error NullifierAlreadyUsed(bytes32 emailNullifier);
    error NotAGuardian(bytes32 accountSalt);
    error AlreadyApproved(uint256 requestId, bytes32 accountSalt);
    error StaleEmail(uint256 emailTimestamp, uint64 requestTimestamp);

    /* ------------------------------------------------------------------ *
     *                              MODIFIERS                              *
     * ------------------------------------------------------------------ */

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /* ------------------------------------------------------------------ *
     *                             CONSTRUCTOR                             *
     * ------------------------------------------------------------------ */

    constructor(address initialOwner, IZKEmailVerifier verifier, IDKIMRegistry dkimRegistry) {
        if (
            initialOwner == address(0) || address(verifier) == address(0)
                || address(dkimRegistry) == address(0)
        ) revert ZeroAddress();

        owner = initialOwner;
        VERIFIER = verifier;
        DKIM_REGISTRY = dkimRegistry;
    }

    /* ------------------------------------------------------------------ *
     *                         GUARDIAN CONFIGURATION                      *
     * ------------------------------------------------------------------ */

    /// @notice Publish the threshold-encrypted guardian set and its approval threshold.
    /// @dev Replaces any previous configuration wholesale.
    ///
    ///      Refuses while a recovery is in flight. An implicit cancel here would be
    ///      convenient but wrong: mutating the guardian set mid-recovery silently
    ///      re-scopes approvals that guardians already gave against the old set. The
    ///      owner must cancel explicitly first, which costs one transaction and makes
    ///      the intent unambiguous.
    ///
    /// @param payload      Ciphertext of the guardian set. Never interpreted on-chain.
    /// @param accountSalts Commitments to each guardian's email. No addresses.
    /// @param newThreshold Approvals required, in `[1, accountSalts.length]`.
    function setGuardianPayload(
        bytes calldata payload,
        bytes32[] calldata accountSalts,
        uint256 newThreshold
    ) external onlyOwner {
        if (activeRequestId != 0) revert RecoveryInFlight(activeRequestId);
        if (payload.length == 0) revert EmptyPayload();

        uint256 count = accountSalts.length;
        if (count > MAX_GUARDIANS) revert TooManyGuardians(count, MAX_GUARDIANS);
        if (newThreshold == 0 || newThreshold > count) {
            revert InvalidThreshold(newThreshold, count);
        }

        // Clear the previous set before writing the new one. Bounded by MAX_GUARDIANS.
        bytes32[] storage salts = _guardianSalts;
        uint256 oldCount = salts.length;
        for (uint256 i; i < oldCount; ++i) {
            delete isGuardian[salts[i]];
        }
        delete _guardianSalts;

        for (uint256 i; i < count; ++i) {
            bytes32 salt = accountSalts[i];
            if (salt == bytes32(0)) revert ZeroSalt();
            if (isGuardian[salt]) revert DuplicateGuardian(salt);
            isGuardian[salt] = true;
            salts.push(salt);
        }

        guardianPayload = payload;
        guardianPayloadHash = keccak256(payload);
        threshold = newThreshold;

        emit GuardianPayloadUpdated(++payloadVersion, guardianPayloadHash, count, newThreshold);
    }

    /* ------------------------------------------------------------------ *
     *                            RECOVERY FLOW                            *
     * ------------------------------------------------------------------ */

    /// @notice Open a recovery request proposing `newOwner`.
    /// @dev Permissionless by necessity: someone who has lost their key is initiating
    ///      from a fresh address with no prior on-chain relationship to this wallet.
    ///
    ///      Opening a request grants nothing. It is inert without `threshold` guardian
    ///      proofs *and* the full 48-hour delay, and the owner can cancel it at any point.
    ///      Only one request may be in flight at a time, which bounds state growth and
    ///      keeps spam to a gas-burning nuisance the owner can clear in one transaction.
    function initiateRecovery(address newOwner) external returns (uint256 requestId) {
        if (newOwner == address(0)) revert ZeroAddress();
        if (newOwner == owner) revert SameOwner();
        if (threshold == 0) revert GuardiansNotConfigured();
        if (activeRequestId != 0) revert RecoveryInFlight(activeRequestId);

        requestId = nextRequestId++;
        activeRequestId = requestId;

        // forge-lint: disable-next-line(unsafe-typecast)
        // casting to 'uint64' is safe: it overflows in the year 584942417355.

        _requests[requestId] =
            RecoveryRequest({
                newOwner: newOwner,
                timestamp: uint64(block.timestamp),
                proofCount: 0,
                executed: false,
                cancelled: false
            });

        emit RecoveryInitiated(
            requestId,
            newOwner,
            uint64(block.timestamp),
            block.timestamp + DELAY,
            canonicalCommand(requestId, newOwner)
        );
    }

    /// @notice Submit a guardian's ZK Email approval for `requestId`.
    /// @dev Permissionless: any relayer may pay the gas. That is safe precisely because
    ///      of the checks below — every proof is self-authenticating and single-use, so a
    ///      relayer can withhold or delay one, but never forge, alter, redirect or replay
    ///      one.
    ///
    ///      Verification alone is *not* authorization. A guardian's proof is a bearer
    ///      credential the moment it hits the mempool; these checks are what narrow it to
    ///      a single use against a single request:
    ///
    ///      1. the proof is sound;
    ///      2. the DKIM key is trusted for the claimed domain;
    ///      3. the command is bound to (this request, this newOwner, this contract, this
    ///         chain) — the check that stops an approval for request #1 being lifted from
    ///         the mempool and replayed into request #2, another deployment, or the same
    ///         bytecode on another chain. Nullifiers alone do *not* cover this;
    ///      4. the email has never been spent;
    ///      5. the sender is a guardian;
    ///      6. that guardian has not already approved this request;
    ///      7. the email is not older than the request, when the blueprint exposes a
    ///         timestamp — this stops approvals pre-signed before a request existed.
    function submitEmailProof(uint256 requestId, EmailProof calldata proof) external {
        RecoveryRequest storage req = _pendingRequest(requestId);

        // 1. Proof soundness.
        if (!VERIFIER.verifyEmailProof(proof)) revert InvalidProof();

        // 2. DKIM key is trusted for the claimed domain.
        if (!DKIM_REGISTRY.isDKIMPublicKeyHashValid(proof.domainName, proof.publicKeyHash)) {
            revert UntrustedDKIMKey(proof.domainName, proof.publicKeyHash);
        }

        // 3. Command binding.
        string memory expected = canonicalCommand(requestId, req.newOwner);
        if (keccak256(bytes(proof.maskedCommand)) != keccak256(bytes(expected))) {
            revert CommandMismatch(expected, proof.maskedCommand);
        }

        // 4. Replay protection.
        if (usedNullifiers[proof.emailNullifier]) {
            revert NullifierAlreadyUsed(proof.emailNullifier);
        }

        // 5. Guardian membership.
        if (!isGuardian[proof.accountSalt]) revert NotAGuardian(proof.accountSalt);

        // 6. One approval per guardian per request.
        if (hasApproved[requestId][proof.accountSalt]) {
            revert AlreadyApproved(requestId, proof.accountSalt);
        }

        // 7. Freshness, when the blueprint exposes a timestamp.
        if (proof.timestamp != 0 && proof.timestamp < req.timestamp) {
            revert StaleEmail(proof.timestamp, req.timestamp);
        }

        usedNullifiers[proof.emailNullifier] = true;
        hasApproved[requestId][proof.accountSalt] = true;
        uint32 newCount = ++req.proofCount;

        emit EmailProofSubmitted(requestId, proof.accountSalt, proof.emailNullifier, newCount);
    }

    /// @notice Execute a matured, fully-approved recovery, transferring ownership.
    /// @dev Permissionless: the conditions are fully on-chain, so anyone may push it
    ///      through once they hold. Follows checks-effects-interactions — terminal state
    ///      is written before ownership moves.
    function executeRecovery(uint256 requestId) external {
        RecoveryRequest storage req = _pendingRequest(requestId);

        uint256 eta = req.timestamp + DELAY;
        // forge-lint: disable-next-line(block-timestamp)
        // Validator timestamp drift is bounded at seconds; the delay is 48 hours, so the
        // manipulation a proposer could achieve is immaterial to this comparison.
        if (block.timestamp < eta) revert TimelockNotElapsed(block.timestamp, eta);

        uint256 required = threshold;
        if (req.proofCount < required) revert ThresholdNotMet(req.proofCount, required);

        req.executed = true;
        activeRequestId = 0;

        address previousOwner = owner;
        owner = req.newOwner;

        emit RecoveryExecuted(requestId, previousOwner, req.newOwner);
    }

    /// @notice Cancel a pending recovery. The owner's veto.
    /// @dev Succeeds on *any* non-terminal request — including one already mature and
    ///      past threshold. Only execution closes the window, which is what makes the
    ///      veto unconditional.
    ///
    ///      Documented tradeoff: a compromised owner key can therefore cancel forever and
    ///      brick the recovery path. That is the direct consequence of treating "the
    ///      owner can always cancel" as a hard safety requirement, and is the intended
    ///      bias — no unauthorised ownership transfer, even at the cost of liveness.
    ///      Protocols wanting the opposite bias add a guardian supermajority override
    ///      after a longer second delay; out of scope here.
    function cancelRecovery(uint256 requestId) external onlyOwner {
        RecoveryRequest storage req = _pendingRequest(requestId);

        req.cancelled = true;
        if (activeRequestId == requestId) activeRequestId = 0;

        emit RecoveryCancelled(requestId, msg.sender);
    }

    /* ------------------------------------------------------------------ *
     *                            ITimelock VIEWS                          *
     * ------------------------------------------------------------------ */

    /// @inheritdoc ITimelock
    function delay() external pure returns (uint256) {
        return DELAY;
    }

    /// @inheritdoc ITimelock
    function etaOf(uint256 requestId) public view returns (uint256) {
        RecoveryRequest storage req = _requests[requestId];
        if (req.timestamp == 0) revert NoSuchRequest(requestId);
        return req.timestamp + DELAY;
    }

    /// @inheritdoc ITimelock
    function isMature(uint256 requestId) external view returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        // See executeRecovery: seconds of drift against a 48-hour delay.
        return block.timestamp >= etaOf(requestId);
    }

    /* ------------------------------------------------------------------ *
     *                                VIEWS                                *
     * ------------------------------------------------------------------ */

    /// @notice The exact string a guardian's email must contain to approve `requestId`.
    /// @dev Bound to the request, the proposed owner, this deployment and this chain.
    ///      Defined here once and mirrored once in the SDK; the two must not drift. A
    ///      mismatch fails closed — proofs stop being accepted, none are wrongly accepted.
    function canonicalCommand(uint256 requestId, address newOwner)
        public
        view
        returns (string memory)
    {
        return string.concat(
            "Approve recovery of wallet ",
            address(this).toHexString(),
            " on chain ",
            block.chainid.toString(),
            " request ",
            requestId.toString(),
            " to new owner ",
            newOwner.toHexString()
        );
    }

    function getRequest(uint256 requestId) external view returns (RecoveryRequest memory) {
        RecoveryRequest storage req = _requests[requestId];
        if (req.timestamp == 0) revert NoSuchRequest(requestId);
        return req;
    }

    /// @notice Whether `requestId` exists and is neither executed nor cancelled.
    function isPending(uint256 requestId) external view returns (bool) {
        RecoveryRequest storage req = _requests[requestId];
        return req.timestamp != 0 && !req.executed && !req.cancelled;
    }

    function guardianCount() external view returns (uint256) {
        return _guardianSalts.length;
    }

    function guardianSaltAt(uint256 index) external view returns (bytes32) {
        return _guardianSalts[index];
    }

    function guardianSalts() external view returns (bytes32[] memory) {
        return _guardianSalts;
    }

    /* ------------------------------------------------------------------ *
     *                               INTERNAL                              *
     * ------------------------------------------------------------------ */

    /// @dev Loads a request that exists and is neither executed nor cancelled.
    function _pendingRequest(uint256 requestId) private view returns (RecoveryRequest storage req) {
        req = _requests[requestId];
        if (req.timestamp == 0) revert NoSuchRequest(requestId);
        if (req.executed || req.cancelled) revert RequestNotPending(requestId);
    }
}
