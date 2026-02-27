// ============================================
// NOIR ZK CIRCUIT: PRIVACY NOTE SPEND PROOF
// circuits/spend_proof.nr
// ============================================

use dep::std;

// Maximum Merkle tree depth
global MERKLE_DEPTH: u32 = 20;

// Main proving function for spending a privacy note
fn main(
    // Private inputs (known only to prover)
    amount: Field,
    recipient: Field,
    secret: Field,
    merkle_path: [Field; MERKLE_DEPTH],
    merkle_path_indices: [u1; MERKLE_DEPTH],
    
    // Public inputs (known to verifier)
    merkle_root: pub Field,
    nullifier: pub Field,
    commitment: pub Field,
    spender: pub Field,
) {
    // ============================================
    // STEP 1: Verify Note Commitment
    // ============================================
    
    // Recompute commitment from private inputs
    // commitment = Poseidon(amount, recipient, secret)
    let computed_commitment = std::hash::poseidon::bn254::hash_3([
        amount,
        recipient,
        secret
    ]);
    
    // Verify commitment matches public input
    assert(computed_commitment == commitment);
    
    // ============================================
    // STEP 2: Verify Nullifier
    // ============================================
    
    // Recompute nullifier from private inputs
    // nullifier = Poseidon(secret, recipient)
    let computed_nullifier = std::hash::poseidon::bn254::hash_2([
        secret,
        recipient
    ]);
    
    // Verify nullifier matches public input
    assert(computed_nullifier == nullifier);
    
    // ============================================
    // STEP 3: Verify Merkle Proof
    // ============================================
    
    // Start with commitment as leaf
    let mut current_hash = commitment;
    
    // Traverse Merkle tree from leaf to root
    for i in 0..MERKLE_DEPTH {
        let path_element = merkle_path[i];
        let is_right = merkle_path_indices[i];
        
        // Determine if we're left or right child
        let (left, right) = if is_right == 0 {
            (current_hash, path_element)
        } else {
            (path_element, current_hash)
        };
        
        // Hash current level
        current_hash = std::hash::poseidon::bn254::hash_2([left, right]);
    }
    
    // Verify computed root matches public root
    assert(current_hash == merkle_root);
    
    // ============================================
    // STEP 4: Verify Spender Authorization
    // ============================================
    
    // Verify spender matches recipient (only recipient can spend)
    assert(spender == recipient);
    
    // ============================================
    // STEP 5: Range Check (amount > 0)
    // ============================================
    
    // Ensure amount is positive and within valid range
    assert(amount as u64 > 0);
    assert(amount as u64 < 18446744073709551615); // max u64
}

// ============================================
// HELPER FUNCTIONS
// ============================================

// Verify a single Merkle proof step
fn verify_merkle_step(
    current_hash: Field,
    sibling: Field,
    is_right: u1
) -> Field {
    let (left, right) = if is_right == 0 {
        (current_hash, sibling)
    } else {
        (sibling, current_hash)
    };
    
    std::hash::poseidon::bn254::hash_2([left, right])
}

// Compute commitment from note components
fn compute_commitment(
    amount: Field,
    recipient: Field,
    secret: Field
) -> Field {
    std::hash::poseidon::bn254::hash_3([amount, recipient, secret])
}

// Compute nullifier from secret and recipient
fn compute_nullifier(
    secret: Field,
    recipient: Field
) -> Field {
    std::hash::poseidon::bn254::hash_2([secret, recipient])
}

// ============================================
// TEST CASES
// ============================================

#[test]
fn test_valid_spend_proof() {
    // Test data
    let amount = 1000;
    let recipient = 0x123456789abcdef;
    let secret = 0xfedcba987654321;
    
    // Compute commitment
    let commitment = compute_commitment(amount, recipient, secret);
    
    // Compute nullifier
    let nullifier = compute_nullifier(secret, recipient);
    
    // Mock Merkle path (simplified)
    let merkle_path = [0; MERKLE_DEPTH];
    let merkle_path_indices = [0; MERKLE_DEPTH];
    
    // Mock root (would be actual tree root)
    let merkle_root = commitment; // Simplified for test
    
    // This should pass
    main(
        amount,
        recipient,
        secret,
        merkle_path,
        merkle_path_indices,
        merkle_root,
        nullifier,
        commitment,
        recipient
    );
}

#[test(should_fail)]
fn test_invalid_commitment() {
    let amount = 1000;
    let recipient = 0x123456789abcdef;
    let secret = 0xfedcba987654321;
    
    let commitment = compute_commitment(amount, recipient, secret);
    let nullifier = compute_nullifier(secret, recipient);
    
    let merkle_path = [0; MERKLE_DEPTH];
    let merkle_path_indices = [0; MERKLE_DEPTH];
    let merkle_root = commitment;
    
    // Wrong commitment - should fail
    main(
        amount,
        recipient,
        secret,
        merkle_path,
        merkle_path_indices,
        merkle_root,
        nullifier,
        0x999999, // Invalid commitment
        recipient
    );
}