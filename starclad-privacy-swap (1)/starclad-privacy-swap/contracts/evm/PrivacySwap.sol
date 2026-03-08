// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

contract PrivacySwap {
    IVerifier public verifier;

    // Incremental Merkle tree (depth 20)
    uint256 public constant TREE_DEPTH = 20;
    uint256 public constant MAX_LEAVES = 1 << 20;

    bytes32[21] public filledSubtrees;   // last filled left node at each level
    bytes32[30] public roots;            // ring buffer of recent roots
    uint32  public currentRootIndex;
    uint32  public nextLeafIndex;

    mapping(bytes32 => bool) public nullifierUsed;
    mapping(bytes32 => bool) public commitments;
    mapping(bytes32 => Swap) public swaps;

    struct Swap {
        bytes32 swapId;
        bytes32 nullifierHash;
        bytes32 amountCommitment;
        address recipient;
        uint256 amount;
        uint256 expiresAt;
        SwapStatus status;
        uint256 createdAt;
    }

    enum SwapStatus { PENDING, LOCKED, COMPLETED, CANCELLED, EXPIRED }

    event CommitmentAdded(bytes32 indexed commitment, uint256 leafIndex, bytes32 merkleRoot);
    event SwapInitiated(bytes32 indexed swapId, bytes32 nullifierHash, uint256 amount, address recipient);
    event SwapCompleted(bytes32 indexed swapId, address recipient, uint256 amount);
    event SwapCancelled(bytes32 indexed swapId);
    event MerkleRootUpdated(bytes32 oldRoot, bytes32 newRoot);

    error NullifierAlreadyUsed();
    error InvalidProof();
    error SwapExpired();
    error SwapNotFound();
    error InvalidMerkleRoot();
    error InsufficientFunds();
    error CommitmentAlreadyExists();
    error TreeFull();
    error UnknownRoot();

    constructor(address _verifier) {
        verifier = IVerifier(_verifier);
        // Initialise filledSubtrees with zero values: zeros[0]=0, zeros[i]=keccak256(zeros[i-1],zeros[i-1])
        bytes32 zero = bytes32(0);
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            filledSubtrees[i] = zero;
            zero = keccak256(abi.encodePacked(zero, zero));
        }
        roots[0] = zero;
    }

    /// @notice Insert a commitment into the incremental Merkle tree.
    /// O(depth) storage writes — no off-chain processing needed.
    function addCommitment(bytes32 commitment) external returns (uint32 leafIndex) {
        if (commitments[commitment]) revert CommitmentAlreadyExists();
        if (nextLeafIndex >= MAX_LEAVES) revert TreeFull();

        leafIndex = nextLeafIndex;
        uint32 idx = leafIndex;
        bytes32 current = commitment;

        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            if (idx % 2 == 0) {
                // current is a left node: store it, compute with zero sibling
                filledSubtrees[i] = current;
                // zero sibling at level i: recompute from zeros chain
                bytes32 zeroSibling = _zeros(i);
                current = keccak256(abi.encodePacked(current, zeroSibling));
            } else {
                // current is a right node: hash with stored left sibling
                current = keccak256(abi.encodePacked(filledSubtrees[i], current));
            }
            idx >>= 1;
        }

        currentRootIndex = (currentRootIndex + 1) % 30;
        roots[currentRootIndex] = current;
        nextLeafIndex++;
        commitments[commitment] = true;

        emit CommitmentAdded(commitment, leafIndex, current);
        return leafIndex;
    }

    /// @notice Verify a Merkle proof against any known recent root.
    function verifyMerkleProof(
        bytes32 leaf,
        bytes32[] calldata proof,
        uint256[] calldata pathIndices
    ) external view returns (bool) {
        require(proof.length == TREE_DEPTH, "Invalid proof length");
        require(pathIndices.length == TREE_DEPTH, "Invalid indices length");
        bytes32 current = leaf;
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            current = pathIndices[i] == 0
                ? keccak256(abi.encodePacked(current, proof[i]))
                : keccak256(abi.encodePacked(proof[i], current));
        }
        return isKnownRoot(current);
    }

    /// @notice Check if a root is in the recent root history.
    function isKnownRoot(bytes32 root) public view returns (bool) {
        if (root == bytes32(0)) return false;
        for (uint32 i = 0; i < 30; i++) {
            if (roots[i] == root) return true;
        }
        return false;
    }

    /// @dev Precomputed zero value at level i: zeros[0]=0, zeros[i]=keccak256(zeros[i-1],zeros[i-1])
    function _zeros(uint256 level) internal pure returns (bytes32 z) {
        z = bytes32(0);
        for (uint256 i = 0; i < level; i++) {
            z = keccak256(abi.encodePacked(z, z));
        }
    }

    function merkleRoot() external view returns (bytes32) {
        return roots[currentRootIndex];
    }

    // Initiate swap by locking funds
    function initiateSwap(
        bytes32 swapId,
        bytes32 nullifierHash,
        bytes32 amountCommitment,
        address recipient,
        uint256 expirationTime
    ) external payable {
        if (nullifierUsed[nullifierHash]) revert NullifierAlreadyUsed();
        if (msg.value == 0) revert InsufficientFunds();

        swaps[swapId] = Swap({
            swapId: swapId,
            nullifierHash: nullifierHash,
            amountCommitment: amountCommitment,
            recipient: recipient,
            amount: msg.value,
            expiresAt: block.timestamp + expirationTime,
            status: SwapStatus.LOCKED,
            createdAt: block.timestamp
        });
        nullifierUsed[nullifierHash] = true;
        emit SwapInitiated(swapId, nullifierHash, msg.value, recipient);
    }

    // Complete swap with zero-knowledge proof
    function completeSwap(
        bytes32 swapId,
        bytes calldata proof,
        bytes32[] calldata publicInputs
    ) external {
        Swap storage swap = swaps[swapId];
        if (swap.swapId == bytes32(0)) revert SwapNotFound();
        if (block.timestamp > swap.expiresAt) revert SwapExpired();
        if (swap.status != SwapStatus.LOCKED) revert SwapNotFound();
        if (!verifier.verify(proof, publicInputs)) revert InvalidProof();
        require(isKnownRoot(publicInputs[0]), "Invalid merkle root");
        require(publicInputs[1] == swap.nullifierHash, "Invalid nullifier");
        require(publicInputs[2] == swap.amountCommitment, "Invalid amount commitment");
        swap.status = SwapStatus.COMPLETED;
        (bool success, ) = swap.recipient.call{value: swap.amount}("");
        require(success, "Transfer failed");
        emit SwapCompleted(swapId, swap.recipient, swap.amount);
    }

    // Cancel expired swap
    function cancelExpiredSwap(bytes32 swapId) external {
        Swap storage swap = swaps[swapId];
        if (swap.swapId == bytes32(0)) revert SwapNotFound();
        if (block.timestamp <= swap.expiresAt) revert("Swap not expired yet");
        if (swap.status != SwapStatus.LOCKED) revert("Swap not locked");
        swap.status = SwapStatus.EXPIRED;
        emit SwapCancelled(swapId);
    }

    function getSwap(bytes32 swapId) external view returns (Swap memory) { return swaps[swapId]; }
    function isNullifierUsed(bytes32 nullifierHash) external view returns (bool) { return nullifierUsed[nullifierHash]; }
    function hasCommitment(bytes32 commitment) external view returns (bool) { return commitments[commitment]; }
}
