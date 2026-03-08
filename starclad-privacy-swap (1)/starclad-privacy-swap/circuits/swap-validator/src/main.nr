use dep::std;

global TREE_DEPTH: u32 = 20;

// Swap Validator Circuit - ONLY cryptographic validation
// Backend/contracts handle: timestamps, expiration, chain state
fn main(
    // Private inputs
    secret: Field,
    nullifier_secret: Field,
    amount: Field,
    merkle_path: [Field; 20],
    merkle_path_indices: [u1; 20],
    
    // Public inputs
    pub commitment: Field,
    pub merkle_root: Field,
    pub nullifier_hash: Field,
    pub amount_commitment: Field,
) {
    // 1. Verify commitment derivation
    let commitment_inputs = [secret, nullifier_secret, amount];
    let computed_commitment = std::hash::pedersen_hash(commitment_inputs);
    assert(computed_commitment == commitment);
    
    // 2. Verify nullifier derivation
    let nullifier = std::hash::pedersen_hash([secret, commitment, nullifier_secret]);
    let computed_nullifier_hash = std::hash::pedersen_hash([nullifier]);
    assert(computed_nullifier_hash == nullifier_hash);
    
    // 3. Verify Merkle proof
    let computed_root = compute_merkle_root(commitment, merkle_path, merkle_path_indices);
    assert(computed_root == merkle_root);
    
    // 4. Verify amount commitment
    let computed_amount_commitment = std::hash::pedersen_hash([amount, secret]);
    assert(computed_amount_commitment == amount_commitment);
    
    // 5. Basic amount validation
    assert(amount > 0);
}

fn compute_merkle_root(
    leaf: Field,
    path: [Field; 20],
    indices: [u1; 20]
) -> Field {
    let mut current = leaf;
    
    for i in 0..20 {
        current = if indices[i] == 0 {
            std::hash::pedersen_hash([current, path[i]])
        } else {
            std::hash::pedersen_hash([path[i], current])
        };
    }
    
    current
}

#[test]
fn test_swap_validation() {
    let secret = 12345;
    let nullifier_secret = 67890;
    let amount = 1000000;
    
    let commitment_inputs = [secret, nullifier_secret, amount];
    let commitment = std::hash::pedersen_hash(commitment_inputs);
    
    let nullifier = std::hash::pedersen_hash([secret, commitment, nullifier_secret]);
    let nullifier_hash = std::hash::pedersen_hash([nullifier]);
    
    let amount_commitment = std::hash::pedersen_hash([amount, secret]);
    
    let leaf2 = std::hash::pedersen_hash([2]);
    let merkle_root = std::hash::pedersen_hash([commitment, leaf2]);
    
    let mut path = [0; 20];
    path[0] = leaf2;
    let mut indices = [0; 20];
    
    main(secret, nullifier_secret, amount, path, indices, commitment, merkle_root, nullifier_hash, amount_commitment);
}
