// Shielded RWA Withdrawal Circuit
// Proves note exists in tree without revealing which one

use dep::std;

global TREE_DEPTH: u32 = 20;

fn main(
    // Private inputs
    secret: Field,
    asset_id: Field,
    amount: Field,
    merkle_path: [Field; TREE_DEPTH],
    path_indices: [Field; TREE_DEPTH],
    
    // Public inputs
    merkle_root: pub Field,
    nullifier: pub Field,
    destination: pub Field  // Where funds go
) {
    // 1. Recompute note commitment
    let note_commitment = std::hash::poseidon2::Poseidon2::hash([
        secret,
        asset_id,
        amount
    ], 3);
    
    // 2. Verify note is in Merkle tree
    let mut current = note_commitment;
    
    for i in 0..TREE_DEPTH {
        let path_element = merkle_path[i];
        let is_right = path_indices[i];
        
        if is_right == 0 {
            // Current is left child
            current = std::hash::poseidon2::Poseidon2::hash([current, path_element], 2);
        } else {
            // Current is right child
            current = std::hash::poseidon2::Poseidon2::hash([path_element, current], 2);
        }
    }
    
    assert(current == merkle_root);
    
    // 3. Verify nullifier
    let computed_nullifier = std::hash::poseidon2::Poseidon2::hash([
        secret,
        asset_id
    ], 2);
    
    assert(nullifier == computed_nullifier);
    
    // 4. Validate
    assert(amount > 0);
    assert(secret != 0);
}
