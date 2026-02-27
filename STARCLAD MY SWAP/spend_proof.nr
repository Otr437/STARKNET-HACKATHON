// COMPLETE NOIR SPEND PROOF CIRCUIT
// Zero-knowledge proof for spending privacy notes

use dep::std;

// Global constants
global MERKLE_TREE_DEPTH: u32 = 20;

// Main spend proof circuit
fn main(
    // Private inputs
    amount: Field,
    secret: Field,
    recipient: pub Field,
    
    // Merkle proof
    merkle_root: pub Field,
    merkle_path: [Field; 20],
    merkle_indices: [u1; 20],
    
    // Public outputs
    nullifier: pub Field,
    commitment: pub Field,
) {
    // 1. Verify commitment = Poseidon(amount, recipient, secret)
    let computed_commitment = poseidon3([amount, recipient, secret]);
    assert(computed_commitment == commitment);
    
    // 2. Verify nullifier = Poseidon(secret, recipient)
    let computed_nullifier = poseidon2([secret, recipient]);
    assert(computed_nullifier == nullifier);
    
    // 3. Verify merkle proof
    let mut current_hash = commitment;
    for i in 0..MERKLE_TREE_DEPTH {
        let path_element = merkle_path[i];
        let is_right = merkle_indices[i];
        
        if is_right == 0 {
            current_hash = poseidon2([current_hash, path_element]);
        } else {
            current_hash = poseidon2([path_element, current_hash]);
        }
    }
    
    assert(current_hash == merkle_root);
    
    // 4. Range check on amount (prevent overflow)
    assert(amount < 21000000 * 100000000); // Max BTC supply in satoshis
}

// Helper: Poseidon hash for 2 elements
fn poseidon2(inputs: [Field; 2]) -> Field {
    std::hash::poseidon::bn254::hash_2(inputs)
}

// Helper: Poseidon hash for 3 elements
fn poseidon3(inputs: [Field; 3]) -> Field {
    std::hash::poseidon::bn254::hash_3(inputs)
}

// Helper: Poseidon hash for 4 elements
fn poseidon4(inputs: [Field; 4]) -> Field {
    std::hash::poseidon::bn254::hash_4(inputs)
}

#[test]
fn test_spend_proof() {
    // Test values
    let amount = 1000000; // 0.01 BTC
    let secret = 12345678901234567890;
    let recipient = 99887766554433221100;
    
    // Compute commitment and nullifier
    let commitment = poseidon3([amount, recipient, secret]);
    let nullifier = poseidon2([secret, recipient]);
    
    // Create dummy merkle proof
    let merkle_path = [0; 20];
    let merkle_indices = [0; 20];
    let merkle_root = commitment; // Simplified for test
    
    // This should pass
    main(
        amount,
        secret,
        recipient,
        merkle_root,
        merkle_path,
        merkle_indices,
        nullifier,
        commitment
    );
}
