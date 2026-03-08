// NOIR MERKLE TREE UTILITIES
// Helper functions for merkle tree operations

use dep::std;

global MERKLE_TREE_DEPTH: u32 = 20;

// Verify a merkle proof
fn verify_proof(
    leaf: Field,
    root: Field,
    path: [Field; 20],
    indices: [u1; 20]
) -> bool {
    let computed_root = compute_root(leaf, path, indices);
    computed_root == root
}

// Compute merkle root from leaf and path
fn compute_root(
    leaf: Field,
    path: [Field; 20],
    indices: [u1; 20]
) -> Field {
    let mut current = leaf;
    
    for i in 0..MERKLE_TREE_DEPTH {
        let sibling = path[i];
        let is_right = indices[i];
        
        current = if is_right == 0 {
            hash_pair(current, sibling)
        } else {
            hash_pair(sibling, current)
        };
    }
    
    current
}

// Hash two field elements
fn hash_pair(left: Field, right: Field) -> Field {
    std::hash::poseidon::bn254::hash_2([left, right])
}

// Compute merkle root from array of leaves
fn compute_merkle_root_from_leaves(leaves: [Field]) -> Field {
    let len = leaves.len();
    assert(len > 0);
    
    if len == 1 {
        return leaves[0];
    }
    
    let mut current_level = leaves;
    
    for level in 0..MERKLE_TREE_DEPTH {
        let level_len = current_level.len();
        
        if level_len == 1 {
            return current_level[0];
        }
        
        let mut next_level = [];
        let pairs = level_len / 2;
        
        for i in 0..pairs {
            let left = current_level[i * 2];
            let right = current_level[i * 2 + 1];
            next_level.push(hash_pair(left, right));
        }
        
        // Handle odd number of nodes
        if level_len % 2 == 1 {
            next_level.push(current_level[level_len - 1]);
        }
        
        current_level = next_level;
    }
    
    current_level[0]
}

#[test]
fn test_merkle_proof() {
    let leaf = 12345;
    let sibling = 67890;
    let root = hash_pair(leaf, sibling);
    
    let path = [sibling, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let indices = [0; 20];
    
    let is_valid = verify_proof(leaf, root, path, indices);
    assert(is_valid);
}

#[test]
fn test_compute_root() {
    let leaves = [1, 2, 3, 4];
    let root = compute_merkle_root_from_leaves(leaves);
    assert(root != 0);
}
