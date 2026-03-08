use dep::std;

// Nullifier Circuit - Generates unique nullifier to prevent double-spending
// Nullifier is derived from secret and commitment to ensure uniqueness
fn main(
    secret: Field,                    // Private: User's secret
    commitment: Field,                // Private: Original commitment
    nullifier_secret: Field,          // Private: Additional nullifier secret
) -> pub Field {
    
    // Validate inputs
    assert(secret != 0);
    assert(commitment != 0);
    assert(nullifier_secret != 0);
    
    // Generate nullifier = H(secret || commitment || nullifier_secret)
    // This ensures nullifier is unique per commitment and cannot be reused
    let nullifier_inputs = [secret, commitment, nullifier_secret];
    let nullifier = std::hash::pedersen_hash(nullifier_inputs);
    
    // Add domain separation to prevent cross-protocol attacks
    let domain_separator = std::hash::pedersen_hash([
        0x4e554c4c494649455200000000000000, // "NULLIFIER" in hex
        nullifier
    ]);
    
    // Final nullifier with domain separation
    let final_nullifier = std::hash::pedersen_hash([nullifier, domain_separator]);
    
    final_nullifier
}

// Verify nullifier derivation is correct
fn verify_nullifier(
    secret: Field,
    commitment: Field,
    nullifier_secret: Field,
    claimed_nullifier: Field
) -> bool {
    let nullifier_inputs = [secret, commitment, nullifier_secret];
    let nullifier = std::hash::pedersen_hash(nullifier_inputs);
    let domain_separator = std::hash::pedersen_hash([
        0x4e554c4c494649455200000000000000,
        nullifier
    ]);
    let final_nullifier = std::hash::pedersen_hash([nullifier, domain_separator]);
    
    final_nullifier == claimed_nullifier
}

// Generate nullifier hash for on-chain storage
fn nullifier_hash(nullifier: Field) -> pub Field {
    std::hash::pedersen_hash([nullifier])
}

#[test]
fn test_nullifier_generation() {
    let secret = 12345;
    let commitment = 0x1a2b3c4d5e6f708090a0b0c0d0e0f000;
    let nullifier_secret = 98765;
    
    let nullifier = main(secret, commitment, nullifier_secret);
    assert(nullifier != 0);
    
    // Verify deterministic generation
    let nullifier2 = main(secret, commitment, nullifier_secret);
    assert(nullifier == nullifier2);
}

#[test]
fn test_nullifier_uniqueness() {
    let secret = 12345;
    let commitment1 = 0x1a2b3c4d5e6f708090a0b0c0d0e0f000;
    let commitment2 = 0x1a2b3c4d5e6f708090a0b0c0d0e0f001;
    let nullifier_secret = 98765;
    
    let nullifier1 = main(secret, commitment1, nullifier_secret);
    let nullifier2 = main(secret, commitment2, nullifier_secret);
    
    // Different commitments should produce different nullifiers
    assert(nullifier1 != nullifier2);
}

#[test]
fn test_nullifier_collision_resistance() {
    // Test that changing any input changes the nullifier
    let secret1 = 12345;
    let secret2 = 12346;
    let commitment = 0x1a2b3c4d5e6f708090a0b0c0d0e0f000;
    let nullifier_secret = 98765;
    
    let nullifier1 = main(secret1, commitment, nullifier_secret);
    let nullifier2 = main(secret2, commitment, nullifier_secret);
    
    assert(nullifier1 != nullifier2);
}
