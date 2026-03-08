use dep::std;

// Commitment Circuit - Generates cryptographic commitment to hide amount and owner
// Uses Pedersen hash for binding commitment
fn main(
    secret: Field,           // Private: User's secret
    nullifier: Field,        // Private: Nullifier for spend protection
    amount: pub Field,       // Public: Amount being committed (hashed)
    asset_id: pub Field,     // Public: Asset identifier (BTC=1, ETH=2, etc)
) -> pub Field {
    
    // Validate inputs are non-zero
    assert(secret != 0);
    assert(nullifier != 0);
    assert(amount > 0);
    assert(asset_id > 0);
    
    // Generate commitment using Pedersen hash
    // commitment = H(secret || nullifier || amount || asset_id)
    let commitment_inputs = [secret, nullifier, amount, asset_id];
    let commitment = std::hash::pedersen_hash(commitment_inputs);
    
    // Additional binding to prevent malleability
    let binding_factor = std::hash::pedersen_hash([commitment, secret]);
    
    // Final commitment combines both hashes
    let final_commitment = std::hash::pedersen_hash([commitment, binding_factor]);
    
    final_commitment
}

// Helper function to verify commitment matches
fn verify_commitment(
    secret: Field,
    nullifier: Field,
    amount: Field,
    asset_id: Field,
    claimed_commitment: Field
) -> bool {
    let commitment_inputs = [secret, nullifier, amount, asset_id];
    let commitment = std::hash::pedersen_hash(commitment_inputs);
    let binding_factor = std::hash::pedersen_hash([commitment, secret]);
    let final_commitment = std::hash::pedersen_hash([commitment, binding_factor]);
    
    final_commitment == claimed_commitment
}

#[test]
fn test_commitment_generation() {
    let secret = 12345;
    let nullifier = 67890;
    let amount = 1000000; // 0.01 BTC in satoshis
    let asset_id = 1; // BTC
    
    let commitment = main(secret, nullifier, amount, asset_id);
    assert(commitment != 0);
    
    // Verify same inputs produce same commitment
    let commitment2 = main(secret, nullifier, amount, asset_id);
    assert(commitment == commitment2);
}

#[test]
fn test_commitment_uniqueness() {
    let secret1 = 12345;
    let secret2 = 12346;
    let nullifier = 67890;
    let amount = 1000000;
    let asset_id = 1;
    
    let commitment1 = main(secret1, nullifier, amount, asset_id);
    let commitment2 = main(secret2, nullifier, amount, asset_id);
    
    assert(commitment1 != commitment2);
}
