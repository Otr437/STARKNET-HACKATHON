use dep::std;

global TREE_DEPTH: u32 = 20; // Supports 2^20 = ~1M commitments

// Merkle Proof Verification Circuit
// Verifies a commitment exists in the Merkle tree without revealing which one
fn main(
    commitment: Field,                          // Private: The commitment to prove
    merkle_path: [Field; 20],                   // Private: Merkle proof path
    merkle_path_indices: [u1; 20],              // Private: Left(0) or right(1) at each level
    merkle_root: pub Field,                     // Public: Current Merkle tree root
) {
    // Validate commitment is non-zero
    assert(commitment != 0);
    
    // Compute root from commitment and path
    let computed_root = compute_merkle_root(
        commitment,
        merkle_path,
        merkle_path_indices
    );
    
    // Verify computed root matches public root
    assert(computed_root == merkle_root);
}

// Compute Merkle root from leaf and path
fn compute_merkle_root(
    leaf: Field,
    path: [Field; 20],
    indices: [u1; 20]
) -> Field {
    let mut current = leaf;
    
    for i in 0..20 {
        let path_element = path[i];
        let is_right = indices[i];
        
        // If is_right = 0, current is left child: hash(current, path_element)
        // If is_right = 1, current is right child: hash(path_element, current)
        current = if is_right == 0 {
            hash_pair(current, path_element)
        } else {
            hash_pair(path_element, current)
        };
    }
    
    current
}

// Hash two nodes in the Merkle tree
fn hash_pair(left: Field, right: Field) -> Field {
    // Use Pedersen hash for efficient ZK proving
    std::hash::pedersen_hash([left, right])
}

// Helper: Generate empty tree hash at given level
fn empty_hash_at_level(level: u32) -> Field {
    if level == 0 {
        0 // Empty leaf
    } else {
        let lower = empty_hash_at_level(level - 1);
        hash_pair(lower, lower)
    }
}

// Verify membership without revealing position
fn verify_membership(
    commitment: Field,
    merkle_path: [Field; 20],
    merkle_path_indices: [u1; 20],
    merkle_root: Field
) -> bool {
    let computed_root = compute_merkle_root(
        commitment,
        merkle_path,
        merkle_path_indices
    );
    computed_root == merkle_root
}

// Calculate leaf index from path indices (for testing)
fn calculate_leaf_index(indices: [u1; 20]) -> Field {
    let mut index: Field = 0;
    let mut multiplier: Field = 1;
    
    for i in 0..20 {
        if indices[i] == 1 {
            index = index + multiplier;
        }
        multiplier = multiplier * 2;
    }
    
    index
}

#[test]
fn test_merkle_proof_verification() {
    // Simple 2-level tree for testing
    let leaf1 = std::hash::pedersen_hash([1]);
    let leaf2 = std::hash::pedersen_hash([2]);
    
    let level1_left = hash_pair(leaf1, leaf2);
    let level1_right = hash_pair(
        std::hash::pedersen_hash([3]),
        std::hash::pedersen_hash([4])
    );
    
    let root = hash_pair(level1_left, level1_right);
    
    // Prove leaf1 is in the tree
    // Path: [leaf2, level1_right]
    let mut path = [0; 20];
    path[0] = leaf2;
    path[1] = level1_right;
    
    let mut indices = [0; 20];
    indices[0] = 0; // leaf1 is left of leaf2
    indices[1] = 0; // level1_left is left of level1_right
    
    let computed = compute_merkle_root(leaf1, path, indices);
    assert(computed == root);
}

#[test]
fn test_hash_pair_deterministic() {
    let left = 12345;
    let right = 67890;
    
    let hash1 = hash_pair(left, right);
    let hash2 = hash_pair(left, right);
    
    assert(hash1 == hash2);
}

#[test]
fn test_hash_pair_order_matters() {
    let a = 12345;
    let b = 67890;
    
    let hash_ab = hash_pair(a, b);
    let hash_ba = hash_pair(b, a);
    
    // Hash should be different based on order
    assert(hash_ab != hash_ba);
}
